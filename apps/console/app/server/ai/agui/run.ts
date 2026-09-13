import { RunAgentInputSchema } from '@ag-ui/core'
import { getAiConfig, streamChat, type ChatMessage } from '../provider.ts'
import { executeTool } from '../tools.ts'
import type { K8sIdentity } from '../../k8s/gateway.ts'
import { AguiStream, type PatchOp } from './protocol.ts'
import { getAgent, isServerTool, toolsForAgent, uiForToolResult, type AgentDef } from './agents.ts'
import { delegateToAdharAi } from './delegate.ts'
import { AUTONOMY_LADDER } from '../adhar-ai.ts'

/**
 * The AG-UI run loop.
 *
 * One HTTP POST carrying a `RunAgentInput` produces one SSE stream of AG-UI
 * events. The loop is a standard tool-calling agent with three additions that
 * make it an agent *platform* rather than a chat box:
 *
 *   1. **Shared state** — a plan + findings object published as STATE_SNAPSHOT
 *      and kept current with STATE_DELTA (JSON Patch). The UI renders it live,
 *      so the operator watches the agent think instead of waiting on a spinner.
 *   2. **Generative UI** — every tool result is mapped to a component payload
 *      (CUSTOM `adhar.ui`), and the model can also call `render_ui` directly.
 *      The transcript shows a diagnosis rather than describing one.
 *   3. **Frontend tools** — tools the BROWSER owns (navigate, open a resource,
 *      ask the operator to approve). The server emits the TOOL_CALL_* events
 *      and finishes the run; the client executes, appends a tool message and
 *      POSTs again on the same thread. This is the AG-UI handshake for
 *      human-in-the-loop and client-side actions.
 *
 * Safety is unchanged from the previous assistant: reads use the signed-in
 * user's identity and nothing here can mutate the cluster.
 */

/** Hard ceiling on tool rounds per run, so a confused model can't loop forever. */
const MAX_STEPS = 8

export interface RunState extends Record<string, unknown> {
  agent: { id: string; name: string; accent: string; icon: string }
  // `thinking`/`answering` belong to the delegated runtime, which has no plan
  // to tick through and so cannot honestly report 'planning' or 'working'.
  phase: 'planning' | 'working' | 'thinking' | 'answering' | 'awaiting-input' | 'done' | 'error'
  plan: Array<{ id: string; label: string; status: 'pending' | 'active' | 'done' | 'failed' }>
  findings: Array<{ id: string; severity: string; title: string; detail?: string; resource?: Record<string, unknown> }>
  tools: { called: number; last?: string }
}

interface AguiMessage {
  id?: string
  role: string
  content?: string | null
  name?: string
  toolCallId?: string
  toolCalls?: Array<{ id: string; type?: string; function: { name: string; arguments: string } }>
}

/** AG-UI message list → the OpenAI-compatible shape our provider speaks. */
function toChatMessages(messages: AguiMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.content ?? '', tool_call_id: m.toolCallId ?? '', name: m.name })
      continue
    }
    if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content ?? null,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function' as const, function: t.function })) }
          : {}),
      })
      continue
    }
    if (m.role === 'user' || m.role === 'system' || m.role === 'developer') {
      out.push({ role: m.role === 'developer' ? 'system' : (m.role as 'user' | 'system'), content: m.content ?? '' })
    }
  }
  return out
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || '{}')
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Execute one of the agentic (UI-driving) tools. These never touch the cluster:
 * their entire effect is the AG-UI event they emit.
 */
function runAgenticTool(
  name: string,
  args: Record<string, unknown>,
  stream: AguiStream,
  state: RunState,
  toolCallId: string,
): string | null {
  switch (name) {
    case 'update_plan': {
      const steps = Array.isArray(args.steps) ? (args.steps as Array<Record<string, unknown>>) : []
      state.plan = steps.slice(0, 12).map((s, i) => ({
        id: `p${i}`,
        label: String(s.label ?? '').slice(0, 120),
        status: (['pending', 'active', 'done', 'failed'].includes(String(s.status)) ? String(s.status) : 'pending') as RunState['plan'][number]['status'],
      }))
      stream.patchState([{ op: 'replace', path: '/plan', value: state.plan }])
      return JSON.stringify({ ok: true, steps: state.plan.length })
    }
    case 'record_finding': {
      const finding = {
        id: `f${state.findings.length}`,
        severity: ['critical', 'warning', 'info', 'ok'].includes(String(args.severity)) ? String(args.severity) : 'info',
        title: String(args.title ?? '').slice(0, 200),
        detail: args.detail ? String(args.detail).slice(0, 2000) : undefined,
        resource: (args.resource as Record<string, unknown> | undefined) ?? undefined,
      }
      state.findings.push(finding)
      stream.patchState([{ op: 'add', path: '/findings/-', value: finding }])
      return JSON.stringify({ ok: true, recorded: finding.title })
    }
    case 'render_ui': {
      const component = String(args.component ?? '')
      if (!component) return JSON.stringify({ error: 'component is required' })
      stream.ui({
        id: stream.id('ui'),
        component,
        title: args.title ? String(args.title) : undefined,
        props: (args.props as Record<string, unknown>) ?? {},
        toolCallId,
      })
      return JSON.stringify({ ok: true, rendered: component })
    }
    default:
      return null
  }
}

export interface RunOptions {
  identity: K8sIdentity | string
  signal?: AbortSignal
  /** Called once with the assistant's final text, for notifications/telemetry. */
  onComplete?(summary: { text: string; findings: RunState['findings']; agent: AgentDef }): void
}

/**
 * Validate a RunAgentInput and stream the run as AG-UI SSE.
 * Throws only on invalid input; everything else surfaces as RUN_ERROR.
 */
export function runAgent(rawInput: unknown, opts: RunOptions): Response {
  const parsed = RunAgentInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_run_input', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      { status: 400 },
    )
  }
  const input = parsed.data as unknown as {
    threadId: string
    runId: string
    messages: AguiMessage[]
    tools?: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>
    context?: Array<{ description: string; value: string }>
    state?: unknown
    forwardedProps?: Record<string, unknown>
  }

  const cfg = getAiConfig()
  if (!cfg) {
    return Response.json({ error: 'ai_not_configured', hint: 'set AI_BASE_URL / AI_MODEL' }, { status: 503 })
  }

  const agent = getAgent(input.forwardedProps?.agent as string | undefined)
  // Frontend tools the browser declared it can run this turn.
  const clientTools = (input.tools ?? []).map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description ?? '', parameters: t.parameters ?? { type: 'object', properties: {} } },
  }))
  const tools = [...toolsForAgent(agent), ...clientTools]

  const state: RunState = {
    agent: { id: agent.id, name: agent.name, accent: agent.accent, icon: agent.icon },
    phase: 'planning',
    plan: [],
    findings: [],
    tools: { called: 0 },
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const stream = new AguiStream(controller, input.threadId, input.runId)
      stream.runStarted()
      stream.setState({ ...state })

      // System prompt + any UI-supplied context, then the conversation.
      const convo: ChatMessage[] = [{ role: 'system', content: agent.systemPrompt }]
      for (const c of input.context ?? []) {
        convo.push({ role: 'system', content: `${c.description}: ${c.value}` })
      }
      convo.push(...toChatMessages(input.messages))

      let finalText = ''
      try {
        /*
         * Delegated agents skip this loop entirely.
         *
         * `adhar-ai` is a whole agentic runtime with its own governed tool
         * contract and its own write path; re-running it inside the console's
         * loop would mean two agents arguing about one turn. The runtime gets
         * the user's last message and its answer is narrated as AG-UI, so the
         * browser sees the same events either way.
         */
        if (agent.delegateTo === 'adhar-ai') {
          const last = [...input.messages].reverse().find((m) => m.role === 'user')
          const prompt = typeof last?.content === 'string' ? last.content.trim() : ''
          if (!prompt) {
            stream.runError('No user message to send to adhar-ai.', 'empty_prompt')
            stream.close()
            return
          }
          // Context the UI attached (the page you were on, the resource you had
          // open) is prepended, because the runtime has no view of the console.
          const context = (input.context ?? []).map((c) => `${c.description}: ${c.value}`).join('\n')
          // Autonomy the operator picked. Validated against the ladder rather
          // than forwarded blind: adhar-ai rejects an unknown value outright,
          // so a typo would fail the whole run instead of falling back to the
          // runtime's own default.
          const asked = typeof input.forwardedProps?.autonomy === 'string' ? input.forwardedProps.autonomy : ''
          const autonomy = AUTONOMY_LADDER.find((a) => a === asked)
          const delegated = await delegateToAdharAi(stream, {
            prompt: context ? `${context}\n\n${prompt}` : prompt,
            autonomy,
            bearer: typeof opts.identity === 'string' ? opts.identity : opts.identity.token,
            user: typeof opts.identity === 'string' ? undefined : opts.identity.user.email,
            session: input.threadId,
            signal: opts.signal,
          })
          if (delegated.error) {
            stream.runError(delegated.error, 'adhar_ai_error')
            stream.close()
            return
          }
          finalText = delegated.text
          stream.patchState([{ op: 'replace', path: '/phase', value: 'done' }])
          stream.runFinished({ text: finalText })
          stream.close()
          opts.onComplete?.({ text: finalText, findings: state.findings, agent })
          return
        }

        for (let step = 0; step < MAX_STEPS; step++) {
          const stepName = `step-${step + 1}`
          stream.stepStarted(stepName)
          if (state.phase === 'planning' && step > 0) {
            state.phase = 'working'
            stream.patchState([{ op: 'replace', path: '/phase', value: 'working' }])
          }

          const messageId = stream.id('msg')
          let opened = false
          let content = ''
          let toolCalls: NonNullable<ChatMessage['tool_calls']> = []

          for await (const delta of streamChat(cfg, convo, { tools, signal: opts.signal })) {
            if (delta.content) {
              if (!opened) {
                stream.textStart(messageId)
                opened = true
              }
              content += delta.content
              stream.textDelta(messageId, delta.content)
            }
            if (delta.toolCalls) toolCalls = delta.toolCalls
          }
          if (opened) stream.textEnd(messageId)
          if (content.trim()) finalText = content

          if (!toolCalls.length) {
            stream.stepFinished(stepName)
            break
          }

          convo.push({ role: 'assistant', content: content || null, tool_calls: toolCalls })

          let awaitingClient: { toolCallId: string; toolName: string } | null = null
          for (const tc of toolCalls) {
            const toolName = tc.function.name
            const args = safeParse(tc.function.arguments)

            stream.toolStart(tc.id, toolName, messageId)
            if (tc.function.arguments) stream.toolArgs(tc.id, tc.function.arguments)
            stream.toolEnd(tc.id)

            // A tool the server doesn't own belongs to the browser: pause the
            // run here and let the client execute it and come back.
            if (!isServerTool(toolName)) {
              awaitingClient = { toolCallId: tc.id, toolName }
              break
            }

            state.tools = { called: state.tools.called + 1, last: toolName }
            const patch: PatchOp[] = [{ op: 'replace', path: '/tools', value: state.tools }]
            if (state.phase === 'planning') {
              state.phase = 'working'
              patch.push({ op: 'replace', path: '/phase', value: 'working' })
            }
            stream.patchState(patch)

            // Agentic tools first (they render UI / mutate state), then cluster tools.
            const agentic = runAgenticTool(toolName, args, stream, state, tc.id)
            if (agentic !== null) {
              stream.toolResult(tc.id, agentic)
              convo.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: agentic })
              continue
            }

            const result = await executeTool(toolName, tc.function.arguments, opts.identity)
            stream.toolResult(tc.id, result.content)

            if (result.proposal) {
              // Human-in-the-loop: a change the operator reviews and applies.
              stream.ui({
                id: stream.id('ui'),
                component: 'proposal',
                title: 'Proposed change',
                props: { summary: result.proposal.summary, manifest: result.proposal.manifest },
                toolCallId: tc.id,
              })
            } else {
              const ui = uiForToolResult(toolName, args, safeParse(result.content))
              if (ui) stream.ui({ id: stream.id('ui'), ...ui, toolCallId: tc.id })
            }

            convo.push({ role: 'tool', tool_call_id: tc.id, name: toolName, content: result.content })
          }

          stream.stepFinished(stepName)

          if (awaitingClient) {
            state.phase = 'awaiting-input'
            stream.patchState([{ op: 'replace', path: '/phase', value: 'awaiting-input' }])
            stream.runFinished({ status: 'awaiting_tool_result', ...awaitingClient })
            opts.onComplete?.({ text: finalText, findings: state.findings, agent })
            stream.close()
            return
          }
        }

        state.phase = 'done'
        stream.patchState([{ op: 'replace', path: '/phase', value: 'done' }])
        stream.runFinished({ status: 'complete', findings: state.findings.length, toolCalls: state.tools.called })
        opts.onComplete?.({ text: finalText, findings: state.findings, agent })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        // An aborted request is the user closing the panel, not a failure.
        if (!/abort/i.test(message)) {
          state.phase = 'error'
          stream.patchState([{ op: 'replace', path: '/phase', value: 'error' }])
          stream.runError(message)
        }
      } finally {
        stream.close()
      }
    },
  })

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // Streamed SSE through nginx/ingress buffers without this.
      'x-accel-buffering': 'no',
    },
  })
}
