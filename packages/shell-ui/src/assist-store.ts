import { useSyncExternalStore } from 'react'
import { getAiConfig, streamAi, type AiContext, type AiMode, type AiProposal } from './ai.ts'

/**
 * Adhar AI conversation store — one module-level store shared by every
 * surface that talks to the assistant (the ⌘K overlay, the floating button,
 * inline "Ask AI" affordances in remotes). Module Federation shares shell-ui
 * as a singleton, so the store is a singleton too.
 *
 * Responsibilities: run a request against `/api/ai/*` (streaming tokens,
 * tool chips, proposals), keep the current conversation + a small history in
 * localStorage, expose busy/config state, and hold the host's apply handler
 * for proposals (kept out of React context so it crosses remote boundaries).
 */

export interface ToolChip {
  name: string
  args: unknown
}

export interface AssistTurn {
  id: number
  role: 'user' | 'assistant'
  content: string
  tools: ToolChip[]
  proposals: AiProposal[]
  streaming?: boolean
  error?: string
  mode?: AiMode
  at: string
}

export interface Conversation {
  id: string
  title: string
  turns: AssistTurn[]
  createdAt: string
  updatedAt: string
}

export interface AskOptions {
  mode?: AiMode
  prompt?: string
  context?: AiContext
  /** Header label describing what's being asked (e.g. "Diagnose payments-api"). */
  title?: string
}

interface State {
  configured: boolean
  configLoaded: boolean
  model?: string
  current: Conversation
  history: Conversation[]
  busy: boolean
  /** The last resource focus handed to the assistant (used as default context). */
  context?: AiContext
  /** Set when the host records a proposal-apply handler. */
  canApply: boolean
}

type ApplyHandler = (manifest: unknown) => Promise<{ ok: boolean; message: string }>

const HISTORY_KEY = 'adhar.assist.history.v1'
const HISTORY_MAX = 20
let turnSeq = 0
let applyHandler: ApplyHandler | null = null
let abort: AbortController | null = null
const listeners = new Set<() => void>()

function newConversation(): Conversation {
  const now = new Date().toISOString()
  return { id: `c${Date.now().toString(36)}`, title: 'New conversation', turns: [], createdAt: now, updatedAt: now }
}

function loadHistory(): Conversation[] {
  try {
    const raw = globalThis.localStorage?.getItem(HISTORY_KEY)
    return raw ? (JSON.parse(raw) as Conversation[]) : []
  } catch {
    return []
  }
}

function saveHistory(list: Conversation[]) {
  try {
    globalThis.localStorage?.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)))
  } catch {
    // quota / private mode
  }
}

let state: State = {
  configured: false,
  configLoaded: false,
  current: newConversation(),
  history: loadHistory(),
  busy: false,
  canApply: false,
}

function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  listeners.forEach((l) => l())
}

function patchTurn(id: number, fn: (t: AssistTurn) => AssistTurn) {
  set((s) => ({ current: { ...s.current, turns: s.current.turns.map((t) => (t.id === id ? fn(t) : t)), updatedAt: new Date().toISOString() } }))
}

/** Persist the current conversation into history (deduped by id). */
function persistCurrent() {
  const cur = state.current
  if (!cur.turns.some((t) => t.role === 'user')) return
  const snapshot: Conversation = {
    ...cur,
    turns: cur.turns.map((t) => ({ ...t, streaming: false })),
    title: cur.title === 'New conversation' ? titleFor(cur) : cur.title,
  }
  const history = [snapshot, ...state.history.filter((c) => c.id !== cur.id)].slice(0, HISTORY_MAX)
  saveHistory(history)
  set({ history, current: { ...cur, title: snapshot.title } })
}

function titleFor(c: Conversation): string {
  const first = c.turns.find((t) => t.role === 'user')?.content.trim() ?? 'Conversation'
  return first.length > 60 ? `${first.slice(0, 57)}…` : first
}

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
    set({ configured: c.configured, model: c.model, configLoaded: true })
  },

  setApplyHandler(fn: ApplyHandler | null) {
    applyHandler = fn
    set({ canApply: !!fn })
  },

  async applyProposal(manifest: unknown): Promise<{ ok: boolean; message: string }> {
    if (!applyHandler) return { ok: false, message: 'Applying changes is not available in this context.' }
    return applyHandler(manifest)
  },

  setContext(ctx?: AiContext) {
    set({ context: ctx })
  },

  /**
   * Run one assistant turn. `chat` sends the prior turns as history; the
   * focused modes (diagnose / explain / generate) send only the context.
   */
  run(mode: AiMode, opts: { prompt?: string; context?: AiContext; userLabel?: string; title?: string }) {
    abort?.abort()
    const ac = new AbortController()
    abort = ac
    if (opts.context) set({ context: opts.context })
    const context = opts.context ?? state.context
    const now = new Date().toISOString()

    const history = state.current.turns.filter((t) => t.content.trim() && !t.error).map((t) => ({ role: t.role, content: t.content }))
    const userTurn: AssistTurn | null = opts.userLabel
      ? { id: ++turnSeq, role: 'user', content: opts.userLabel, tools: [], proposals: [], mode, at: now }
      : null
    const assistant: AssistTurn = { id: ++turnSeq, role: 'assistant', content: '', tools: [], proposals: [], streaming: true, mode, at: now }
    set((s) => ({
      busy: true,
      current: {
        ...s.current,
        title: s.current.title === 'New conversation' && opts.title ? opts.title : s.current.title,
        turns: [...s.current.turns, ...(userTurn ? [userTurn] : []), assistant],
        updatedAt: now,
      },
    }))

    void streamAi(
      { mode, prompt: opts.prompt, context, messages: mode === 'chat' ? history : undefined, signal: ac.signal },
      {
        onToken: (text) => patchTurn(assistant.id, (a) => ({ ...a, content: a.content + text })),
        onTool: (name, args) => patchTurn(assistant.id, (a) => ({ ...a, tools: [...a.tools, { name, args }] })),
        onProposal: (p) => patchTurn(assistant.id, (a) => ({ ...a, proposals: [...a.proposals, p] })),
        onError: (message) => patchTurn(assistant.id, (a) => ({ ...a, error: message, streaming: false })),
        onDone: () => patchTurn(assistant.id, (a) => ({ ...a, streaming: false })),
      },
    ).finally(() => {
      patchTurn(assistant.id, (a) => ({ ...a, streaming: false }))
      if (abort === ac) abort = null
      set({ busy: false })
      persistCurrent()
    })
  },

  stop() {
    abort?.abort()
    abort = null
    set((s) => ({ busy: false, current: { ...s.current, turns: s.current.turns.map((t) => ({ ...t, streaming: false })) } }))
  },

  newChat() {
    abort?.abort()
    abort = null
    persistCurrent()
    set({ current: newConversation(), busy: false })
  },

  openConversation(id: string) {
    const c = state.history.find((x) => x.id === id)
    if (!c) return
    persistCurrent()
    set({ current: { ...c, turns: c.turns.map((t) => ({ ...t })) }, busy: false })
  },

  deleteConversation(id: string) {
    const history = state.history.filter((c) => c.id !== id)
    saveHistory(history)
    set((s) => ({ history, current: s.current.id === id ? newConversation() : s.current }))
  },

  clearHistory() {
    saveHistory([])
    set({ history: [] })
  },

  /** Drop the last assistant turn and re-run the last user prompt. */
  regenerate() {
    const turns = state.current.turns
    const lastUser = [...turns].reverse().find((t) => t.role === 'user')
    if (!lastUser || state.busy) return
    const idx = turns.lastIndexOf(lastUser)
    set((s) => ({ current: { ...s.current, turns: s.current.turns.slice(0, idx) } }))
    assistStore.run(lastUser.mode ?? 'chat', { prompt: lastUser.content, userLabel: lastUser.content })
  },
}

export function useAssist(): State {
  return useSyncExternalStore(assistStore.subscribe, assistStore.getSnapshot, assistStore.getSnapshot)
}
