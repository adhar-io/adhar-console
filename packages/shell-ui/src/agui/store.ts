import { useSyncExternalStore } from 'react'
import {
  AgentRunError,
  EventType,
  getAiConfig,
  getOperatorFindings,
  runAgent,
  type AgentInfo,
  type OperatorFinding,
  type AguiEvent,
  type AguiMessage,
  type FrontendTool,
} from './client.ts'

/**
 * Adhar AI — the AG-UI conversation store.
 *
 * One module-level store shared by every surface that talks to the agents (the
 * ⌘K overlay, inline "Ask AI" affordances in remotes). Module Federation shares
 * shell-ui as a singleton, so this store is a singleton too and React context
 * is not involved — context does not cross remote boundaries.
 *
 * It owns four things:
 *   1. **Event reduction** — AG-UI events → the messages, tool calls and
 *      generative-UI blocks the transcript renders.
 *   2. **Shared agent state** — STATE_SNAPSHOT / STATE_DELTA (JSON Patch) into
 *      a live plan + findings object the UI renders next to the thread.
 *   3. **Frontend tools** — tools the browser executes for the agent
 *      (navigate, open a resource, ask the operator). When the server pauses a
 *      run on one, we execute it and resume the same thread.
 *   4. **Persistence** — recent threads in localStorage.
 */

/* ─────────────────────────── model ─────────────────────────── */

export interface AiContext {
  group?: string
  version: string
  resource: string
  namespace?: string
  name?: string
  kind?: string
}

export interface ToolCallView {
  id: string
  name: string
  args: string
  status: 'running' | 'done' | 'error'
  result?: string
}

/** A component the agent asked the console to render. */
export interface UiBlock {
  id: string
  component: string
  title?: string
  props: Record<string, unknown>
  toolCallId?: string
}

export interface ChatEntry {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  error?: string
  toolCalls: ToolCallView[]
  ui: UiBlock[]
  at: string
}

export interface Thread {
  id: string
  title: string
  agentId: string
  messages: ChatEntry[]
  createdAt: string
  updatedAt: string
}

export interface PlanStep {
  id: string
  label: string
  status: 'pending' | 'active' | 'done' | 'failed'
}

export interface Finding {
  id: string
  severity: 'critical' | 'warning' | 'info' | 'ok'
  title: string
  detail?: string
  resource?: { kind?: string; name?: string; namespace?: string }
}

/**
 * What a run did, when the run was a governed adhar-ai run.
 *
 * This is the audit trail, not decoration. `autonomy` is what the runtime
 * actually GRANTED, which may be lower than what was asked for — showing it
 * back is how an operator learns they were pinned to read-only rather than
 * wondering why nothing was applied. `auditId` is the handle support needs to
 * find the run server-side.
 */
export interface AdharAiRunInfo {
  kind?: 'answer' | 'proposed' | 'budget_exhausted' | 'error'
  steps?: number
  auditId?: string
  autonomy?: string
  /** Autonomy the operator asked for, when the grant came back lower. */
  requested?: string
  writeAllowed?: boolean
  authenticated?: boolean
  pullRequests?: number
}

/** The agent's shared state, mirrored from STATE_SNAPSHOT / STATE_DELTA. */
export interface RunState {
  agent?: { id: string; name: string; accent: string; icon: string }
  // `thinking` and `answering` are the delegated runtime's phases: it has no
  // plan to tick through, so 'planning'/'working' would misdescribe it.
  phase?: 'planning' | 'working' | 'thinking' | 'answering' | 'awaiting-input' | 'done' | 'error'
  plan: PlanStep[]
  findings: Finding[]
  tools?: { called: number; last?: string; failed?: number }
  adharAi?: AdharAiRunInfo
}

/** A question the agent put to the operator, awaiting an answer. */
export interface PendingAsk {
  toolCallId: string
  question: string
  options: string[]
  allowFreeText: boolean
}

export interface AskOptions {
  mode?: 'chat' | 'diagnose' | 'explain' | 'generate'
  prompt?: string
  context?: AiContext
  title?: string
  agentId?: string
}

interface State {
  configured: boolean
  configLoaded: boolean
  model?: string
  agents: AgentInfo[]
  agentId: string
  thread: Thread
  history: Thread[]
  busy: boolean
  run: RunState | null
  context?: AiContext
  canApply: boolean
  pendingAsk: PendingAsk | null
  /** Autonomy to request for delegated (adhar-ai) runs. */
  autonomy: Autonomy
  /** What the runtime's operators noticed on their own. Empty when unavailable. */
  operatorFindings: OperatorFinding[]
}

/**
 * The autonomy ladder, exactly as adhar-ai spells it. Authority only ever
 * narrows: this is a CEILING REQUEST, and the runtime may grant less based on
 * who is asking. Sending a value outside this set is an error there, not a
 * silent downgrade — hence the exact spelling, hyphens included.
 *
 * The runtime's fourth rung, `scoped`, is deliberately not offered here. Every
 * other rung ends at a pull request a human merges, which is the property that
 * makes handing the agent a production cluster reasonable; putting a
 * one-click escape from it in a ⌘K palette is not.
 */
export const AUTONOMY_LEVELS = [
  { id: 'read-only', label: 'Read only', hint: 'Investigate and answer. No changes of any kind.' },
  { id: 'suggest', label: 'Suggest', hint: 'Investigate, then describe the change it would make.' },
  { id: 'approve-to-apply', label: 'Propose PR', hint: 'Open a pull request for you to review and merge.' },
] as const
export type Autonomy = (typeof AUTONOMY_LEVELS)[number]['id']

/* ─────────────────────── frontend tools ─────────────────────── */

/**
 * Tools the BROWSER executes. They are declared to the agent on every run; the
 * server pauses the run when the model calls one, we run it here and resume.
 * This is what lets the agent drive the console rather than only describe it.
 */
export const FRONTEND_TOOLS: FrontendTool[] = [
  {
    name: 'navigate_to',
    description:
      "Open a page in this console for the operator. Use it when the answer is 'go look at X' — the operator lands there instead of hunting for it. Paths are console routes like /platform?section=workloads, /deliver?section=apps, /develop?section=repos, /discover?section=logs.",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Console route, e.g. /platform?section=pods' },
        reason: { type: 'string', description: 'One line: why this page answers the question.' },
      },
      required: ['path', 'reason'],
    },
  },
  {
    name: 'open_resource',
    description:
      'Open the live detail drawer for one Kubernetes object (YAML, events, logs, related objects). Use it when the operator should inspect a specific object you found.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'e.g. Pod, Deployment, Service' },
        name: { type: 'string' },
        namespace: { type: 'string' },
      },
      required: ['kind', 'name'],
    },
  },
  {
    name: 'ask_operator',
    description:
      'Ask the operator a question and WAIT for the answer before continuing. Use it when you need a decision only a human can make (which environment, whether to widen a search, which of several candidates to dig into). Do not use it for information you can look up.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: {
          type: 'array',
          description: 'Suggested answers as buttons. Omit for a free-text answer.',
          items: { type: 'string' },
        },
      },
      required: ['question'],
    },
  },
]

type FrontendHandler = (args: Record<string, unknown>) => Promise<string> | string
type ApplyHandler = (manifest: unknown) => Promise<{ ok: boolean; message: string }>

const HISTORY_KEY = 'adhar.assist.threads.v2'
const AGENT_KEY = 'adhar.assist.agent.v1'
const AUTONOMY_KEY = 'adhar.assist.autonomy.v1'
const HISTORY_MAX = 20

let applyHandler: ApplyHandler | null = null
const frontendHandlers = new Map<string, FrontendHandler>()
let abort: AbortController | null = null
/** Resolver for the in-flight `ask_operator`. */
let askResolver: ((answer: string) => void) | null = null
const listeners = new Set<() => void>()

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function newThread(agentId: string): Thread {
  const now = new Date().toISOString()
  return { id: uid('thread'), title: 'New conversation', agentId, messages: [], createdAt: now, updatedAt: now }
}

function loadHistory(): Thread[] {
  try {
    const raw = globalThis.localStorage?.getItem(HISTORY_KEY)
    return raw ? (JSON.parse(raw) as Thread[]) : []
  } catch {
    return []
  }
}

function saveHistory(list: Thread[]) {
  try {
    globalThis.localStorage?.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)))
  } catch {
    // quota / private mode
  }
}

function storedAgent(): string {
  try {
    return globalThis.localStorage?.getItem(AGENT_KEY) || 'sre'
  } catch {
    return 'sre'
  }
}

/** Remembered autonomy, floored at read-only if the stored value is stale. */
function storedAutonomy(): Autonomy {
  try {
    const raw = globalThis.localStorage?.getItem(AUTONOMY_KEY)
    const hit = AUTONOMY_LEVELS.find((l) => l.id === raw)
    return hit ? hit.id : 'read-only'
  } catch {
    return 'read-only'
  }
}

let state: State = {
  configured: false,
  configLoaded: false,
  agents: [],
  agentId: storedAgent(),
  thread: newThread(storedAgent()),
  history: loadHistory(),
  busy: false,
  run: null,
  canApply: false,
  pendingAsk: null,
  autonomy: storedAutonomy(),
  operatorFindings: [],
}

function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  listeners.forEach((l) => l())
}

function patchThread(fn: (t: Thread) => Thread) {
  set((s) => ({ thread: { ...fn(s.thread), updatedAt: new Date().toISOString() } }))
}

function patchEntry(id: string, fn: (e: ChatEntry) => ChatEntry) {
  patchThread((t) => ({ ...t, messages: t.messages.map((m) => (m.id === id ? fn(m) : m)) }))
}

/** Ensure an assistant entry exists to attach streamed content / tools / UI to. */
function ensureAssistant(id: string): string {
  const existing = state.thread.messages.find((m) => m.id === id)
  if (existing) return id
  const entry: ChatEntry = { id, role: 'assistant', content: '', toolCalls: [], ui: [], streaming: true, at: new Date().toISOString() }
  patchThread((t) => ({ ...t, messages: [...t.messages, entry] }))
  return id
}

/** The assistant entry currently being built — tools/UI attach to it. */
function currentAssistantId(): string {
  const last = [...state.thread.messages].reverse().find((m) => m.role === 'assistant')
  if (last) return last.id
  return ensureAssistant(uid('msg'))
}

/* ─────────────────────── JSON Patch (RFC 6902) ─────────────────────── */

function applyPatch(root: Record<string, unknown>, ops: Array<{ op: string; path: string; value?: unknown }>) {
  for (const op of ops) {
    const parts = op.path.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    if (!parts.length) continue
    let node: unknown = root
    for (const key of parts.slice(0, -1)) {
      if (Array.isArray(node)) node = node[Number(key)]
      else if (node && typeof node === 'object') node = (node as Record<string, unknown>)[key]
      else {
        node = undefined
        break
      }
    }
    if (!node || typeof node !== 'object') continue
    const last = parts[parts.length - 1]
    if (Array.isArray(node)) {
      const i = last === '-' ? node.length : Number(last)
      if (op.op === 'remove') node.splice(i, 1)
      else if (op.op === 'add') node.splice(i, 0, op.value)
      else node[i] = op.value
      continue
    }
    const obj = node as Record<string, unknown>
    if (op.op === 'remove') delete obj[last]
    else obj[last] = op.value
  }
}

/* ─────────────────────── event reduction ─────────────────────── */

/** Set while a run is paused on a frontend tool the browser must execute. */
let awaitingTool: { toolCallId: string; toolName: string } | null = null

function reduce(e: AguiEvent) {
  switch (e.type) {
    case EventType.STATE_SNAPSHOT: {
      const snap = (e as { snapshot: unknown }).snapshot
      set({ run: { plan: [], findings: [], ...(snap as object) } as RunState })
      break
    }
    case EventType.STATE_DELTA: {
      const ops = (e as { delta: Array<{ op: string; path: string; value?: unknown }> }).delta
      const next: RunState = JSON.parse(JSON.stringify(state.run ?? { plan: [], findings: [] }))
      applyPatch(next as unknown as Record<string, unknown>, ops)
      set({ run: next })
      break
    }
    case EventType.TEXT_MESSAGE_START: {
      ensureAssistant((e as { messageId: string }).messageId)
      break
    }
    case EventType.TEXT_MESSAGE_CONTENT: {
      const { messageId, delta } = e as { messageId: string; delta: string }
      ensureAssistant(messageId)
      patchEntry(messageId, (m) => ({ ...m, content: m.content + delta, streaming: true }))
      break
    }
    case EventType.TEXT_MESSAGE_END: {
      patchEntry((e as { messageId: string }).messageId, (m) => ({ ...m, streaming: false }))
      break
    }
    case EventType.TOOL_CALL_START: {
      const { toolCallId, toolCallName, parentMessageId } = e as { toolCallId: string; toolCallName: string; parentMessageId?: string }
      const target = parentMessageId ? ensureAssistant(parentMessageId) : currentAssistantId()
      patchEntry(target, (m) => ({
        ...m,
        toolCalls: [...m.toolCalls, { id: toolCallId, name: toolCallName, args: '', status: 'running' }],
      }))
      break
    }
    case EventType.TOOL_CALL_ARGS: {
      const { toolCallId, delta } = e as { toolCallId: string; delta: string }
      patchThread((t) => ({
        ...t,
        messages: t.messages.map((m) => ({
          ...m,
          toolCalls: m.toolCalls.map((c) => (c.id === toolCallId ? { ...c, args: c.args + delta } : c)),
        })),
      }))
      break
    }
    case EventType.TOOL_CALL_RESULT: {
      const { toolCallId, content } = e as { toolCallId: string; content: string }
      patchThread((t) => ({
        ...t,
        messages: t.messages.map((m) => ({
          ...m,
          toolCalls: m.toolCalls.map((c) =>
            c.id === toolCallId ? { ...c, status: isErrorResult(content) ? 'error' : 'done', result: content } : c,
          ),
        })),
      }))
      break
    }
    case EventType.CUSTOM: {
      const { name, value } = e as { name: string; value: unknown }
      if (name !== 'adhar.ui' || !value || typeof value !== 'object') break
      const block = value as UiBlock
      patchEntry(currentAssistantId(), (m) => ({ ...m, ui: [...m.ui, block] }))
      break
    }
    case EventType.RUN_FINISHED: {
      const result = (e as { result?: { status?: string; toolCallId?: string; toolName?: string } }).result
      awaitingTool =
        result?.status === 'awaiting_tool_result' && result.toolCallId && result.toolName
          ? { toolCallId: result.toolCallId, toolName: result.toolName }
          : null
      break
    }
    case EventType.RUN_ERROR: {
      const message = (e as { message: string }).message
      patchEntry(currentAssistantId(), (m) => ({ ...m, error: message, streaming: false }))
      break
    }
    default:
      // STEP_STARTED / STEP_FINISHED / RUN_STARTED and anything the protocol
      // adds later: nothing to render, the state object carries progress.
      break
  }
}

function isErrorResult(content: string): boolean {
  try {
    const v = JSON.parse(content) as { error?: unknown }
    return typeof v?.error === 'string'
  } catch {
    return false
  }
}

/** Rebuild the protocol message list the server needs to continue a thread. */
function protocolMessages(thread: Thread): AguiMessage[] {
  const out: AguiMessage[] = []
  for (const m of thread.messages) {
    if (m.role === 'user') {
      out.push({ id: m.id, role: 'user', content: m.content })
      continue
    }
    if (!m.content && !m.toolCalls.length) continue
    out.push({
      id: m.id,
      role: 'assistant',
      content: m.content || undefined,
      ...(m.toolCalls.length
        ? {
            toolCalls: m.toolCalls.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: c.args || '{}' },
            })),
          }
        : {}),
    })
    for (const c of m.toolCalls) {
      if (c.result === undefined) continue
      out.push({ id: `${c.id}_result`, role: 'tool', toolCallId: c.id, name: c.name, content: c.result })
    }
  }
  return out
}

/** Execute a frontend tool and return the string result the agent sees. */
async function executeFrontendTool(name: string, argsJson: string, toolCallId: string): Promise<string> {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(argsJson || '{}') as Record<string, unknown>
  } catch {
    return JSON.stringify({ error: 'invalid arguments' })
  }

  if (name === 'ask_operator') {
    const question = String(args.question ?? 'Which option?')
    const options = Array.isArray(args.options) ? (args.options as unknown[]).map(String).slice(0, 6) : []
    const answer = await new Promise<string>((resolve) => {
      askResolver = resolve
      set({ pendingAsk: { toolCallId, question, options, allowFreeText: options.length === 0 } })
    })
    set({ pendingAsk: null })
    return JSON.stringify({ answer })
  }

  const handler = frontendHandlers.get(name)
  if (!handler) {
    return JSON.stringify({ error: `the console cannot run "${name}" in this context` })
  }
  try {
    return await handler(args)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

function titleFor(t: Thread): string {
  const first = t.messages.find((m) => m.role === 'user')?.content.trim() ?? 'Conversation'
  return first.length > 60 ? `${first.slice(0, 57)}…` : first
}

function persist() {
  const cur = state.thread
  if (!cur.messages.some((m) => m.role === 'user')) return
  const snapshot: Thread = {
    ...cur,
    messages: cur.messages.map((m) => ({ ...m, streaming: false })),
    title: cur.title === 'New conversation' ? titleFor(cur) : cur.title,
  }
  const history = [snapshot, ...state.history.filter((t) => t.id !== cur.id)].slice(0, HISTORY_MAX)
  saveHistory(history)
  set({ history, thread: { ...cur, title: snapshot.title } })
}

/* ─────────────────────────── store ─────────────────────────── */

export const assistStore = {
  subscribe(l: () => void) {
    listeners.add(l)
    return () => listeners.delete(l)
  },
  getSnapshot(): State {
    return state
  },

  async loadConfig() {
    if (state.configLoaded) return
    const c = await getAiConfig()
    const agents = c.agents ?? []
    const agentId = agents.some((a) => a.id === state.agentId) ? state.agentId : (c.defaultAgent ?? agents[0]?.id ?? 'sre')
    set({ configured: c.configured, model: c.model, agents, agentId, configLoaded: true })
    // Not awaited: what the operators noticed is worth showing, but nobody
    // should wait on the runtime to start typing a question.
    if (agents.some((a) => a.delegated)) {
      void getOperatorFindings().then((operatorFindings) => set({ operatorFindings }))
    }
  },

  setApplyHandler(fn: ApplyHandler | null) {
    applyHandler = fn
    set({ canApply: !!fn })
  },

  /** Register the host's implementation of a frontend tool (navigate, open…). */
  setFrontendHandler(name: string, fn: FrontendHandler | null) {
    if (fn) frontendHandlers.set(name, fn)
    else frontendHandlers.delete(name)
  },

  async applyProposal(manifest: unknown): Promise<{ ok: boolean; message: string }> {
    if (!applyHandler) return { ok: false, message: 'Applying changes is not available in this context.' }
    return applyHandler(manifest)
  },

  setContext(ctx?: AiContext) {
    set({ context: ctx })
  },

  setAgent(agentId: string) {
    try {
      globalThis.localStorage?.setItem(AGENT_KEY, agentId)
    } catch {
      // ignore
    }
    set((s) => ({ agentId, thread: s.thread.messages.length ? s.thread : { ...s.thread, agentId } }))
  },

  /** Request a different autonomy ceiling for delegated runs. */
  setAutonomy(autonomy: Autonomy) {
    try {
      globalThis.localStorage?.setItem(AUTONOMY_KEY, autonomy)
    } catch {
      // ignore
    }
    set({ autonomy })
  },

  /** Answer the agent's pending `ask_operator` question. */
  answerAsk(answer: string) {
    askResolver?.(answer)
    askResolver = null
  },

  /**
   * Send a turn. Drives the run to completion, resuming across frontend-tool
   * pauses until the agent stops asking for browser work.
   */
  send(text: string, opts: { context?: AiContext; title?: string } = {}) {
    const prompt = text.trim()
    if (!prompt || state.busy) return
    if (opts.context) set({ context: opts.context })

    const entry: ChatEntry = { id: uid('msg'), role: 'user', content: prompt, toolCalls: [], ui: [], at: new Date().toISOString() }
    patchThread((t) => ({
      ...t,
      title: t.title === 'New conversation' && opts.title ? opts.title : t.title,
      messages: [...t.messages, entry],
    }))
    void assistStore.drive()
  },

  /** Run (or resume) the agent against the current thread. */
  async drive() {
    abort?.abort()
    const ac = new AbortController()
    abort = ac
    set({ busy: true, run: null })

    const ctx = state.context
    const context = ctx
      ? [
          {
            description: 'The operator is currently looking at this object',
            value: `${ctx.kind ?? ctx.resource} "${ctx.name ?? ''}"${ctx.namespace ? ` in namespace ${ctx.namespace}` : ''} (group="${ctx.group ?? ''}" version="${ctx.version}" resource="${ctx.resource}")`,
          },
        ]
      : []

    try {
      // Resume loop: each pass is one server run; a pass that ends on a
      // frontend tool executes it here and runs again on the same thread.
      for (let hop = 0; hop < 6; hop++) {
        awaitingTool = null
        for await (const event of runAgent({
          threadId: state.thread.id,
          runId: uid('run'),
          messages: protocolMessages(state.thread),
          tools: FRONTEND_TOOLS,
          context,
          forwardedProps: { agent: state.agentId, autonomy: state.autonomy },
          signal: ac.signal,
        })) {
          reduce(event)
        }

        if (!awaitingTool) break
        const pending = awaitingTool
        const call = state.thread.messages.flatMap((m) => m.toolCalls).find((c) => c.id === pending.toolCallId)
        const result = await executeFrontendTool(pending.toolName, call?.args ?? '{}', pending.toolCallId)
        patchThread((t) => ({
          ...t,
          messages: t.messages.map((m) => ({
            ...m,
            toolCalls: m.toolCalls.map((c) =>
              c.id === pending.toolCallId ? { ...c, status: isErrorResult(result) ? 'error' : 'done', result } : c,
            ),
          })),
        }))
        if (ac.signal.aborted) break
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        const message = err instanceof AgentRunError ? err.message : err instanceof Error ? err.message : String(err)
        patchEntry(currentAssistantId(), (m) => ({ ...m, error: message, streaming: false }))
      }
    } finally {
      if (abort === ac) abort = null
      patchThread((t) => ({ ...t, messages: t.messages.map((m) => ({ ...m, streaming: false })) }))
      set({ busy: false, pendingAsk: null })
      askResolver = null
      persist()
    }
  },

  stop() {
    abort?.abort()
    abort = null
    askResolver = null
    patchThread((t) => ({ ...t, messages: t.messages.map((m) => ({ ...m, streaming: false })) }))
    set({ busy: false, pendingAsk: null })
  },

  newThread() {
    abort?.abort()
    abort = null
    persist()
    set((s) => ({ thread: newThread(s.agentId), busy: false, run: null, pendingAsk: null }))
  },

  openThread(id: string) {
    const t = state.history.find((x) => x.id === id)
    if (!t) return
    persist()
    set({ thread: { ...t, messages: t.messages.map((m) => ({ ...m })) }, busy: false, run: null, agentId: t.agentId || state.agentId })
  },

  deleteThread(id: string) {
    const history = state.history.filter((t) => t.id !== id)
    saveHistory(history)
    set((s) => ({ history, thread: s.thread.id === id ? newThread(s.agentId) : s.thread }))
  },

  clearHistory() {
    saveHistory([])
    set({ history: [] })
  },

  /** Drop the last assistant turn and re-run the last user message. */
  regenerate() {
    if (state.busy) return
    const messages = state.thread.messages
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    if (!lastUser) return
    const idx = messages.lastIndexOf(lastUser)
    patchThread((t) => ({ ...t, messages: t.messages.slice(0, idx + 1) }))
    void assistStore.drive()
  },
}

export function useAssist(): State {
  return useSyncExternalStore(assistStore.subscribe, assistStore.getSnapshot, assistStore.getSnapshot)
}

export type { AgentInfo }
