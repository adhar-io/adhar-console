import type { AguiStream } from './protocol.ts'
import {
  adharAiChat,
  type AdharAiResult,
  type AdharAiToolCall,
  type Autonomy,
} from '../adhar-ai.ts'

/**
 * Run a turn on **adhar-ai** and narrate it as AG-UI.
 *
 * adhar-ai answers with one JSON document at the end of a run — there is no
 * token stream and no intermediate events. The console's other agents stream,
 * so a naive integration would sit silent for a minute and then dump a wall of
 * text, which reads as a hang.
 *
 * This translates the finished run into the same event vocabulary the browser
 * already knows, in the order the events would have arrived had the run been
 * streamed: the grounding it used, then each tool it called, then the answer
 * typed out, then any pull request it proposed as a generative-UI card. The
 * browser needs no new code paths, and the transcript afterwards is the same
 * shape as every other agent's.
 *
 * What it does NOT do is pretend to be live. The text is revealed in chunks for
 * readability, but the run is already over by then — so `steps`, `audit_id` and
 * the tool list are exact rather than guessed, and nothing is invented to fill
 * the wait.
 */

/** Roughly a sentence per chunk — enough to read as prose arriving, not a stutter. */
const CHUNK = 180
const CHUNK_DELAY_MS = 16

function chunks(text: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(i + CHUNK, text.length)
    if (end < text.length) {
      // Prefer a paragraph break, then a sentence end, so chunks land on
      // boundaries a reader expects rather than mid-word.
      const para = text.lastIndexOf('\n', end)
      const stop = text.lastIndexOf('. ', end)
      const at = Math.max(para, stop)
      if (at > i + CHUNK / 3) end = at + 1
    }
    out.push(text.slice(i, end))
    i = end
  }
  return out
}

/**
 * A tool call's display name.
 *
 * adhar-ai emits `{tool, args, decision}`, not the OpenAI-shaped
 * `{name, arguments}`. Reading the wrong field renders every call as
 * "tool_1, tool_2, …" with empty arguments — which looks like the agent did
 * nothing, exactly when the transcript matters most. `name` is still accepted
 * in case the runtime ever normalises toward the OpenAI shape.
 */
function toolName(call: AdharAiToolCall, index: number): string {
  const raw = call.tool ?? (call.name as string | undefined)
  return typeof raw === 'string' && raw ? raw : `tool_${index + 1}`
}

function toolArguments(call: AdharAiToolCall): unknown {
  if (call.args && typeof call.args === 'object') return call.args
  if (call.arguments && typeof call.arguments === 'object') return call.arguments
  return {}
}

/**
 * What the transcript shows for a call.
 *
 * There is no result payload — adhar-ai records the DECISION ("ok", "error", or
 * a policy refusal), not what the tool returned. Saying "ok" regardless would
 * quietly hide the failures, and a run whose every tool errored while the UI
 * showed three green ticks is worse than no transcript at all.
 */
function resultText(call: AdharAiToolCall): string {
  const decision = typeof call.decision === 'string' ? call.decision : ''
  if (!decision) return 'called'
  return decision === 'error' ? 'error — the tool call failed' : decision
}

/** Errors and policy refusals deserve to look different from a clean call. */
function failed(call: AdharAiToolCall): boolean {
  const d = typeof call.decision === 'string' ? call.decision.toLowerCase() : ''
  return d === 'error' || d.includes('refus') || d.includes('denied')
}

export interface DelegateOptions {
  prompt: string
  /** Signed-in user's access token — adhar-ai derives its Principal from it. */
  bearer?: string
  autonomy?: Autonomy
  signal?: AbortSignal
  user?: string
  session?: string
}

/**
 * Emit a whole adhar-ai run onto `stream`.
 *
 * Returns the assistant's final text so the caller can reuse it for the
 * notification/telemetry hook, exactly as the native loop does. Never throws:
 * a failure is narrated as a RUN_ERROR-worthy message and returned as text, so
 * the caller decides how to end the run.
 */
export async function delegateToAdharAi(
  stream: AguiStream,
  opts: DelegateOptions,
): Promise<{ text: string; result?: AdharAiResult; error?: string }> {
  stream.stepStarted('adhar-ai')
  stream.patchState([{ op: 'replace', path: '/phase', value: 'thinking' }])

  const res = await adharAiChat(
    { prompt: opts.prompt, autonomy: opts.autonomy, user: opts.user, session: opts.session },
    { bearer: opts.bearer, signal: opts.signal },
  )

  if (!res.ok) {
    stream.stepFinished('adhar-ai')
    return { text: '', error: res.error }
  }
  const run = res.data

  // 1. Grounding — say what the answer was based on before the answer itself,
  //    so a reader can judge it. Silent when retrieval returned nothing rather
  //    than claiming an empty basis.
  const grounded = (run.grounded_on ?? []).filter(Boolean)
  if (grounded.length > 0) {
    stream.ui({
      id: stream.id('ui'),
      component: 'checklist',
      title: 'Grounded on',
      props: { items: grounded.map((g) => ({ label: g, done: true })) },
    })
  }

  // 2. The tools it actually called. Replayed as real tool events so the UI's
  //    existing tool timeline works unchanged.
  let toolFailures = 0
  run.tool_calls?.forEach((call, i) => {
    const id = stream.id('tool')
    stream.toolStart(id, toolName(call, i))
    stream.toolArgs(id, JSON.stringify(toolArguments(call)))
    stream.toolEnd(id)
    stream.toolResult(id, resultText(call))
    if (failed(call)) toolFailures++
  })

  stream.patchState([
    { op: 'replace', path: '/phase', value: 'answering' },
    {
      op: 'replace',
      path: '/tools',
      value: { called: run.tool_calls?.length ?? 0, failed: toolFailures },
    },
  ])

  // 3. The answer.
  const text = run.text?.trim() ?? ''
  if (text) {
    const messageId = stream.id('msg')
    stream.textStart(messageId)
    for (const piece of chunks(text)) {
      stream.textDelta(messageId, piece)
      if (CHUNK_DELAY_MS) await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS))
    }
    stream.textEnd(messageId)
  }

  // 4. Proposed pull requests — the whole point of the write path. A card per
  //    PR, because "it opened a PR" buried in prose is the one outcome nobody
  //    should have to read carefully to notice.
  for (const pr of run.pull_requests ?? []) {
    stream.ui({
      id: stream.id('ui'),
      component: 'proposal',
      title: pr.title ?? 'Proposed change',
      props: {
        title: pr.title ?? 'Proposed change',
        summary: pr.repo ? `${pr.repo}${pr.branch ? ` · ${pr.branch}` : ''}` : undefined,
        href: pr.url,
        cta: pr.url ? 'Review pull request' : undefined,
        tone: 'info',
      },
    })
  }

  // 5. What the run cost and who it ran as — the audit trail, not decoration.
  //    `autonomy` is what adhar-ai actually allowed, which may be lower than
  //    what was asked for, so showing it back is how a user learns they were
  //    pinned to read-only.
  stream.patchState([
    {
      op: 'replace',
      path: '/adharAi',
      value: {
        kind: run.kind,
        steps: run.steps,
        auditId: run.audit_id,
        autonomy: run.autonomy,
        writeAllowed: run.principal?.write_allowed ?? false,
        authenticated: run.principal?.authenticated ?? false,
        pullRequests: run.pull_requests?.length ?? 0,
      },
    },
  ])

  stream.stepFinished('adhar-ai')

  // `budget_exhausted` and `error` are real outcomes, not silence: a run that
  // stopped early with no text would otherwise look like a successful empty
  // answer.
  if (!text && run.kind === 'budget_exhausted') {
    return { text: '', result: run, error: 'The run hit its step or tool budget before reaching an answer.' }
  }
  if (!text && run.kind === 'error') {
    return { text: '', result: run, error: run.error || 'adhar-ai reported an error with no detail.' }
  }

  return { text, result: run }
}
