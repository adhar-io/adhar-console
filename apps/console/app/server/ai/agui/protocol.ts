import { EventSchemas, EventType } from '@ag-ui/core'
import { env } from '@adhar-console/utils'

/**
 * AG-UI (Agent-User Interaction Protocol) emission layer.
 *
 * Every event this console streams to the browser is a canonical AG-UI event
 * built with the protocol's own `EventType` enum and validated against the
 * protocol's own zod schemas (`EventSchemas`, the discriminated union) before
 * it goes on the wire. If the upstream protocol changes shape, our emission
 * fails loudly in dev instead of silently producing a stream no AG-UI client
 * can read.
 *
 * Transport is SSE (`data: <json>\n\n`) — the AG-UI standard HTTP transport,
 * and the same one the previous bespoke `/api/ai/chat` stream used, so the
 * BFF's streaming/auth/cookie plumbing is unchanged.
 *
 * Validation is on in dev and off in production: the schemas are not cheap and
 * a token-by-token stream emits thousands of events per run. `AGUI_VALIDATE=1`
 * forces it on anywhere.
 */

/** JSON Patch (RFC 6902) operation — the STATE_DELTA payload. */
export interface PatchOp {
  op: 'add' | 'replace' | 'remove'
  path: string
  value?: unknown
}

const VALIDATE = env('AGUI_VALIDATE') === '1' || env('NODE_ENV') !== 'production'

/** Apply one RFC-6902 op to a plain object tree (add / replace / remove only). */
function applyOp(root: Record<string, unknown>, op: PatchOp): void {
  const parts = op.path.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
  if (parts.length === 0) return
  let node: unknown = root
  for (const key of parts.slice(0, -1)) {
    if (Array.isArray(node)) node = node[Number(key)]
    else if (node && typeof node === 'object') node = (node as Record<string, unknown>)[key]
    else return
  }
  const last = parts[parts.length - 1]
  if (Array.isArray(node)) {
    const i = last === '-' ? node.length : Number(last)
    if (op.op === 'remove') node.splice(i, 1)
    else if (op.op === 'add') node.splice(i, 0, op.value)
    else node[i] = op.value
    return
  }
  if (!node || typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  if (op.op === 'remove') delete obj[last]
  else obj[last] = op.value
}

/**
 * One AG-UI run, bound to a `ReadableStream` controller.
 *
 * Also owns the run's **shared state** — the object the agent and the UI both
 * read. `setState` publishes a full STATE_SNAPSHOT; `patchState` publishes the
 * minimal STATE_DELTA and keeps the server's copy in sync, so a late snapshot
 * and the accumulated deltas always agree.
 */
export class AguiStream {
  private closed = false
  private state: Record<string, unknown> = {}
  private seq = 0

  constructor(
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    readonly threadId: string,
    readonly runId: string,
  ) {}

  /** Stable ids so message/tool-call ids never collide inside a run. */
  id(prefix: string): string {
    return `${prefix}_${this.runId}_${++this.seq}`
  }

  private send(event: Record<string, unknown>): void {
    if (this.closed) return
    const withTs = { ...event, timestamp: Date.now() }
    if (VALIDATE) {
      const parsed = EventSchemas.safeParse(withTs)
      if (!parsed.success) {
        // Never ship a malformed event; surface it as a protocol error instead.
        const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        console.error(`[agui] refusing to emit invalid ${String(event.type)} — ${detail}`)
        return
      }
    }
    this.controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(withTs)}\n\n`))
  }

  /* ── lifecycle ── */
  runStarted() {
    this.send({ type: EventType.RUN_STARTED, threadId: this.threadId, runId: this.runId })
  }
  runFinished(result?: unknown) {
    this.send({ type: EventType.RUN_FINISHED, threadId: this.threadId, runId: this.runId, ...(result === undefined ? {} : { result }) })
  }
  runError(message: string, code?: string) {
    this.send({ type: EventType.RUN_ERROR, message, ...(code ? { code } : {}) })
  }
  stepStarted(stepName: string) {
    this.send({ type: EventType.STEP_STARTED, stepName })
  }
  stepFinished(stepName: string) {
    this.send({ type: EventType.STEP_FINISHED, stepName })
  }

  /* ── assistant text ── */
  textStart(messageId: string) {
    this.send({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' })
  }
  textDelta(messageId: string, delta: string) {
    if (!delta) return
    this.send({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta })
  }
  textEnd(messageId: string) {
    this.send({ type: EventType.TEXT_MESSAGE_END, messageId })
  }

  /* ── tool calls ── */
  toolStart(toolCallId: string, toolCallName: string, parentMessageId?: string) {
    this.send({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName, ...(parentMessageId ? { parentMessageId } : {}) })
  }
  toolArgs(toolCallId: string, delta: string) {
    this.send({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta })
  }
  toolEnd(toolCallId: string) {
    this.send({ type: EventType.TOOL_CALL_END, toolCallId })
  }
  toolResult(toolCallId: string, content: string, messageId = this.id('msg')) {
    this.send({ type: EventType.TOOL_CALL_RESULT, messageId, toolCallId, content, role: 'tool' })
  }

  /* ── shared state ── */
  getState(): Record<string, unknown> {
    return this.state
  }
  setState(next: Record<string, unknown>) {
    this.state = next
    this.send({ type: EventType.STATE_SNAPSHOT, snapshot: next })
  }
  patchState(ops: PatchOp[]) {
    if (!ops.length) return
    for (const op of ops) applyOp(this.state, op)
    this.send({ type: EventType.STATE_DELTA, delta: ops })
  }

  /**
   * Generative UI. AG-UI's escape hatch for app-specific payloads: the console
   * renders `value` through its component registry (see
   * packages/shell-ui/src/agui/generative). Namespaced so a generic AG-UI
   * client can ignore what it doesn't know.
   */
  ui(value: { id: string; component: string; props: Record<string, unknown>; title?: string; toolCallId?: string }) {
    this.send({ type: EventType.CUSTOM, name: 'adhar.ui', value })
  }
  /** Any other app-level signal (agent handoff, quota notice, …). */
  custom(name: string, value: unknown) {
    this.send({ type: EventType.CUSTOM, name, value })
  }

  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.controller.close()
    } catch {
      // already closed by an aborted request
    }
  }
}
