import { resolveIdentity } from '../k8s/gateway.ts'
import { getAiConfig, isAiConfigured, streamChat, type ChatMessage } from './provider.ts'
import { executeTool, TOOL_DEFS } from './tools.ts'

/**
 * AI assistant endpoints (`/api/ai/*`). All responses to the browser are SSE
 * (`text/event-stream`) with JSON events:
 *   {type:'token', text}        — a streamed content chunk
 *   {type:'tool', name, args}   — the model invoked a read-only cluster tool
 *   {type:'proposal', summary, manifest} — a change proposed for human approval
 *   {type:'error', message}
 *   {type:'done'}
 *
 * Policy: the model reads/diagnoses with the USER's RBAC and may PROPOSE changes
 * (as a reviewable manifest) but never mutates the cluster itself.
 */

const SYSTEM_PROMPT =
  `You are the Adhar Console assistant — an expert Kubernetes SRE embedded in a cluster operations UI. ` +
  `Help the operator understand, diagnose and safely change their cluster. ` +
  `Use the provided read-only tools to gather real data (list/get/logs/events/discovery) before answering — never guess resource state. ` +
  `Be concise and concrete: reference actual names, namespaces, statuses, and log lines you observed. ` +
  `When you recommend a change, call propose_change with a complete, minimal, valid manifest and a one-line summary; do NOT claim you applied anything — the human reviews and applies. ` +
  `Prefer root-cause explanations (events + logs + status) over generic advice. Format with short markdown.`

function sse(controller: ReadableStreamDefaultController, obj: unknown) {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`))
}

interface ChatBody {
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>
  prompt?: string
  /** Optional resource focus for inline "explain/diagnose" affordances. */
  context?: { group?: string; version: string; resource: string; namespace?: string; name?: string; kind?: string }
  mode?: 'chat' | 'diagnose' | 'explain' | 'generate'
}

export async function handleAi(req: Request, name: string): Promise<Response> {
  if (name === 'config') {
    const cfg = getAiConfig()
    return Response.json({ configured: isAiConfigured(), model: cfg?.model })
  }
  if (!['chat', 'diagnose', 'explain', 'generate'].includes(name)) {
    return Response.json({ error: 'unknown_ai_endpoint' }, { status: 404 })
  }
  if (!isAiConfigured()) {
    return Response.json({ error: 'ai_not_configured', hint: 'set AI_BASE_URL / AI_MODEL' }, { status: 503 })
  }
  const id = await resolveIdentity(req)
  if (!id) return Response.json({ error: 'unauthenticated' }, { status: 401 })

  let body: ChatBody
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const messages = await buildMessages(name as ChatBody['mode'], body)
  const cfg = getAiConfig()!
  const token = id.token

  const stream = new ReadableStream({
    async start(controller) {
      const convo: ChatMessage[] = messages
      try {
        for (let step = 0; step < 6; step++) {
          let content = ''
          let toolCalls: NonNullable<ChatMessage['tool_calls']> = []
          for await (const delta of streamChat(cfg, convo, { tools: TOOL_DEFS, signal: req.signal })) {
            if (delta.content) {
              content += delta.content
              sse(controller, { type: 'token', text: delta.content })
            }
            if (delta.toolCalls) toolCalls = delta.toolCalls
          }
          if (toolCalls.length === 0) break
          convo.push({ role: 'assistant', content: content || null, tool_calls: toolCalls })
          for (const tc of toolCalls) {
            sse(controller, { type: 'tool', name: tc.function.name, args: safeParse(tc.function.arguments) })
            const result = await executeTool(tc.function.name, tc.function.arguments, token)
            if (result.proposal) {
              sse(controller, { type: 'proposal', summary: result.proposal.summary, manifest: result.proposal.manifest })
            }
            convo.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: result.content })
          }
        }
        sse(controller, { type: 'done' })
      } catch (e) {
        sse(controller, { type: 'error', message: e instanceof Error ? e.message : String(e) })
      } finally {
        controller.close()
      }
    },
  })

  const headers = new Headers({
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  if (id.refreshedCookie) headers.append('set-cookie', id.refreshedCookie)
  return new Response(stream, { headers })
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

async function buildMessages(mode: ChatBody['mode'], body: ChatBody): Promise<ChatMessage[]> {
  const msgs: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }]
  const ctx = body.context
  const focus = ctx
    ? `The user is looking at ${ctx.kind ?? ctx.resource} "${ctx.name ?? ''}"${ctx.namespace ? ` in namespace ${ctx.namespace}` : ''} (group="${ctx.group ?? ''}" version="${ctx.version}" resource="${ctx.resource}"). Use k8s_get / k8s_events / k8s_logs to inspect it.`
    : ''

  switch (mode) {
    case 'diagnose':
      msgs.push({
        role: 'user',
        content: `${focus}\nDiagnose the health of this resource. Fetch its current object, related Events, and (for pods/workloads) recent logs from failing containers. Explain the root cause of any problem and, if there's a fix, propose_change it. If healthy, say so briefly.`,
      })
      break
    case 'explain':
      msgs.push({
        role: 'user',
        content: `${focus}\nExplain what this resource is, what it does, its current state, and anything notable an operator should know. Fetch it first.`,
      })
      break
    case 'generate':
      msgs.push({
        role: 'user',
        content: `${focus}\n${body.prompt ?? 'Generate a Kubernetes manifest for the following request.'}\nReturn the manifest via propose_change (validate against real cluster kinds via k8s_discovery if unsure).`,
      })
      break
    default: {
      // Free chat: prior turns + latest.
      if (focus) msgs.push({ role: 'system', content: focus })
      for (const m of body.messages ?? []) msgs.push({ role: m.role, content: m.content })
      if (body.prompt) msgs.push({ role: 'user', content: body.prompt })
    }
  }
  return msgs
}
