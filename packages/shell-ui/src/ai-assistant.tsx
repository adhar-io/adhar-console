import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { getAiConfig, streamAi, type AiContext, type AiMode, type AiProposal } from './ai.ts'

/**
 * Triggering the assistant is decoupled from the panel via a `window`
 * CustomEvent so it works across Module-Federation remotes (React context does
 * not cross the boundary — each remote bundles its own shell-ui). Any remote's
 * `AiButton` / `useAi().ask()` dispatches the event; the single host-mounted
 * `<AiProvider>` listens and drives the panel.
 */
const ASK_EVENT = 'adhar:ai:ask'
const OPEN_EVENT = 'adhar:ai:open'
const CLOSE_EVENT = 'adhar:ai:close'

function emit(name: string, detail?: unknown) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(name, { detail }))
}

/** Local, provider-independent AI config (works in any remote). */
function useAiConfigured(): boolean {
  const [ok, setOk] = useState(false)
  useEffect(() => {
    void getAiConfig().then((c) => setOk(c.configured))
  }, [])
  return ok
}

/**
 * AI assistant — a global provider + slide-over panel woven into every view.
 *
 * Any component calls `useAi().ask({ mode, context, prompt })`; the panel opens
 * and streams the answer. The model works read-only with the user's RBAC and
 * may PROPOSE changes (rendered as approval cards) — applying them is the host's
 * job via `onApplyProposal` (kept out of shell-ui so it stays UI-only).
 */

interface ToolChip {
  name: string
  args: unknown
}
interface Turn {
  id: number
  role: 'user' | 'assistant'
  content: string
  tools: ToolChip[]
  proposals: AiProposal[]
  streaming?: boolean
  error?: string
}

export interface AskOptions {
  mode?: AiMode
  prompt?: string
  context?: AiContext
  /** Header label describing what's being asked (e.g. "Diagnose payments-api"). */
  title?: string
}

/**
 * Trigger the assistant from anywhere (host or any remote). Provider-free: it
 * dispatches window events the host-mounted `<AiProvider>` listens for.
 */
export function useAi(): { ask(opts: AskOptions): void; open(): void; close(): void; configured: boolean } {
  const configured = useAiConfigured()
  return {
    ask: (opts) => emit(ASK_EVENT, opts),
    open: () => emit(OPEN_EVENT),
    close: () => emit(CLOSE_EVENT),
    configured,
  }
}

export interface AiProviderProps {
  children: ReactNode
  /** Apply a model-proposed manifest. Return a human-readable result. */
  onApplyProposal?(manifest: unknown): Promise<{ ok: boolean; message: string }>
}

let turnSeq = 0

export function AiProvider({ children, onApplyProposal }: AiProviderProps) {
  const [isOpen, setOpen] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [model, setModel] = useState<string | undefined>()
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState('Assistant')
  const [input, setInput] = useState('')
  const lastCtx = useRef<AiContext | undefined>(undefined)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    void getAiConfig().then((c) => {
      setConfigured(c.configured)
      setModel(c.model)
    })
  }, [])

  const run = useCallback(
    (mode: AiMode, opts: { prompt?: string; context?: AiContext; userLabel?: string }) => {
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      setBusy(true)
      if (opts.context) lastCtx.current = opts.context

      const history = turnsToHistory()
      if (opts.userLabel) {
        setTurns((t) => [...t, { id: ++turnSeq, role: 'user', content: opts.userLabel!, tools: [], proposals: [] }])
      }
      const assistant: Turn = { id: ++turnSeq, role: 'assistant', content: '', tools: [], proposals: [], streaming: true }
      setTurns((t) => [...t, assistant])
      const patch = (fn: (a: Turn) => Turn) =>
        setTurns((t) => t.map((x) => (x.id === assistant.id ? fn(x) : x)))

      void streamAi(
        {
          mode,
          prompt: opts.prompt,
          context: opts.context ?? lastCtx.current,
          messages: mode === 'chat' ? history : undefined,
          signal: ac.signal,
        },
        {
          onToken: (text) => patch((a) => ({ ...a, content: a.content + text })),
          onTool: (name, args) => patch((a) => ({ ...a, tools: [...a.tools, { name, args }] })),
          onProposal: (p) => patch((a) => ({ ...a, proposals: [...a.proposals, p] })),
          onError: (message) => patch((a) => ({ ...a, error: message, streaming: false })),
          onDone: () => {
            patch((a) => ({ ...a, streaming: false }))
            setBusy(false)
          },
        },
      ).finally(() => setBusy(false))

      function turnsToHistory() {
        return turns
          .filter((t) => t.content.trim())
          .map((t) => ({ role: t.role, content: t.content }))
      }
    },
    [turns],
  )

  const ask = useCallback(
    (opts: AskOptions) => {
      setOpen(true)
      setTitle(opts.title ?? (opts.mode ? cap(opts.mode) : 'Assistant'))
      const mode = opts.mode ?? 'chat'
      run(mode, {
        prompt: opts.prompt,
        context: opts.context,
        userLabel: mode === 'chat' ? opts.prompt : (opts.title ?? cap(mode)),
      })
    },
    [run],
  )

  // Listen for cross-remote trigger events (dispatched by useAi()/AiButton).
  useEffect(() => {
    const onAsk = (e: Event) => ask((e as CustomEvent<AskOptions>).detail ?? {})
    const onOpen = () => setOpen(true)
    const onClose = () => setOpen(false)
    window.addEventListener(ASK_EVENT, onAsk)
    window.addEventListener(OPEN_EVENT, onOpen)
    window.addEventListener(CLOSE_EVENT, onClose)
    return () => {
      window.removeEventListener(ASK_EVENT, onAsk)
      window.removeEventListener(OPEN_EVENT, onOpen)
      window.removeEventListener(CLOSE_EVENT, onClose)
    }
  }, [ask])

  const submit = () => {
    const p = input.trim()
    if (!p || busy) return
    setInput('')
    run('chat', { prompt: p, userLabel: p })
  }

  return (
    <>
      {children}
      {configured && !isOpen ? (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-linear-to-br from-brand-500 to-accent-500 text-white shadow-lg ring-1 ring-black/5 transition-transform hover:scale-105"
          aria-label="Ask the AI assistant"
          title="Ask AI"
        >
          <SparkIcon />
        </button>
      ) : null}
      <AiPanel
        open={isOpen}
        onClose={() => setOpen(false)}
        title={title}
        model={model}
        configured={configured}
        turns={turns}
        busy={busy}
        input={input}
        setInput={setInput}
        onSubmit={submit}
        onStop={() => abortRef.current?.abort()}
        onClear={() => setTurns([])}
        onApplyProposal={onApplyProposal}
      />
    </>
  )
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/* ─────────────── the panel ─────────────── */

function AiPanel(props: {
  open: boolean
  onClose(): void
  title: string
  model?: string
  configured: boolean
  turns: Turn[]
  busy: boolean
  input: string
  setInput(v: string): void
  onSubmit(): void
  onStop(): void
  onClear(): void
  onApplyProposal?(manifest: unknown): Promise<{ ok: boolean; message: string }>
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (props.open) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [props.turns, props.open])

  if (!props.open) return null
  return (
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-label="AI assistant">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-[1px]" onClick={props.onClose} aria-hidden />
      <aside className="relative flex h-full w-full max-w-md flex-col border-l border-edge-default bg-surface-app shadow-2xl animate-in slide-in-from-right duration-200">
        <header className="flex items-center gap-2 border-b border-edge-subtle px-4 py-3">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-linear-to-br from-brand-500 to-accent-500 text-white">
            <SparkIcon />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-content">{props.title}</div>
            <div className="truncate text-[11px] text-content-subtle">
              {props.configured ? (props.model ? `AI · ${props.model}` : 'AI assistant') : 'AI not configured'}
            </div>
          </div>
          <button onClick={props.onClear} className="rounded-md px-2 py-1 text-xs text-content-muted hover:bg-surface-sunken" title="Clear conversation">
            Clear
          </button>
          <button onClick={props.onClose} className="rounded-md p-1.5 text-content-muted hover:bg-surface-sunken" aria-label="Close">
            <CloseIcon />
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {props.turns.length === 0 ? (
            <EmptyPrompt configured={props.configured} />
          ) : (
            props.turns.map((t) => (
              <TurnView key={t.id} turn={t} onApplyProposal={props.onApplyProposal} />
            ))
          )}
        </div>

        <div className="border-t border-edge-subtle p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={props.input}
              onChange={(e) => props.setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  props.onSubmit()
                }
              }}
              rows={1}
              placeholder={props.configured ? 'Ask about your cluster…' : 'AI is not configured'}
              disabled={!props.configured}
              className="max-h-32 min-h-9 flex-1 resize-none rounded-lg border border-edge-default bg-white px-3 py-2 text-sm text-content outline-none placeholder:text-content-subtle focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20 disabled:opacity-60"
            />
            {props.busy ? (
              <button onClick={props.onStop} className="h-9 rounded-lg bg-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-300">
                Stop
              </button>
            ) : (
              <button
                onClick={props.onSubmit}
                disabled={!props.configured || !props.input.trim()}
                className="h-9 rounded-lg bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}

function TurnView({ turn, onApplyProposal }: { turn: Turn; onApplyProposal?(m: unknown): Promise<{ ok: boolean; message: string }> }) {
  if (turn.role === 'user') {
    return (
      <div className="ml-8 rounded-2xl rounded-tr-sm bg-brand-600 px-3.5 py-2 text-sm text-white">{turn.content}</div>
    )
  }
  return (
    <div className="space-y-2">
      {turn.tools.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {turn.tools.map((t, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-full border border-edge-subtle bg-surface-sunken px-2 py-0.5 text-[11px] text-content-muted">
              <ToolIcon /> {toolLabel(t.name, t.args)}
            </span>
          ))}
        </div>
      ) : null}
      {turn.content ? (
        <div className="whitespace-pre-wrap rounded-2xl rounded-tl-sm bg-white px-3.5 py-2.5 text-sm leading-relaxed text-content ring-1 ring-edge-subtle">
          {turn.content}
          {turn.streaming ? <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-brand-400 align-middle" /> : null}
        </div>
      ) : turn.streaming ? (
        <div className="flex items-center gap-2 text-sm text-content-subtle">
          <Dots /> thinking…
        </div>
      ) : null}
      {turn.proposals.map((p, i) => (
        <ProposalCard key={i} proposal={p} onApply={onApplyProposal} />
      ))}
      {turn.error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{turn.error}</div>
      ) : null}
    </div>
  )
}

function ProposalCard({ proposal, onApply }: { proposal: AiProposal; onApply?(m: unknown): Promise<{ ok: boolean; message: string }> }) {
  const [state, setState] = useState<'idle' | 'applying' | 'done' | 'error'>('idle')
  const [msg, setMsg] = useState('')
  const [showYaml, setShowYaml] = useState(false)
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-amber-600"><WrenchIcon /></span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-amber-900">Proposed change · review before applying</div>
          <div className="mt-0.5 text-sm text-content">{proposal.summary}</div>
        </div>
      </div>
      <button onClick={() => setShowYaml((s) => !s)} className="mt-2 text-[11px] font-medium text-amber-800 underline-offset-2 hover:underline">
        {showYaml ? 'Hide' : 'View'} manifest
      </button>
      {showYaml ? (
        <pre className="mt-1.5 max-h-56 overflow-auto rounded-lg bg-slate-900 p-2.5 text-[11px] leading-relaxed text-slate-100">
          {JSON.stringify(proposal.manifest, null, 2)}
        </pre>
      ) : null}
      <div className="mt-2.5 flex items-center gap-2">
        <button
          disabled={!onApply || state === 'applying' || state === 'done'}
          onClick={async () => {
            if (!onApply) return
            setState('applying')
            try {
              const r = await onApply(proposal.manifest)
              setState(r.ok ? 'done' : 'error')
              setMsg(r.message)
            } catch (e) {
              setState('error')
              setMsg(e instanceof Error ? e.message : String(e))
            }
          }}
          className="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {state === 'applying' ? 'Applying…' : state === 'done' ? 'Applied ✓' : 'Apply'}
        </button>
        {msg ? <span className={`text-[11px] ${state === 'error' ? 'text-rose-700' : 'text-emerald-700'}`}>{msg}</span> : null}
      </div>
    </div>
  )
}

function toolLabel(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, string>
  switch (name) {
    case 'k8s_list':
      return `list ${a.resource ?? ''}${a.namespace ? ` · ${a.namespace}` : ''}`
    case 'k8s_get':
      return `get ${a.resource ?? ''}/${a.name ?? ''}`
    case 'k8s_logs':
      return `logs ${a.pod ?? ''}`
    case 'k8s_events':
      return 'events'
    case 'k8s_discovery':
      return 'discover API'
    case 'propose_change':
      return 'propose change'
    default:
      return name
  }
}

function EmptyPrompt({ configured }: { configured: boolean }) {
  return (
    <div className="mt-6 text-center text-sm text-content-subtle">
      {configured ? (
        <>
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-linear-to-br from-brand-500 to-accent-500 text-white">
            <SparkIcon />
          </div>
          Ask about workloads, diagnose failures, or generate manifests. I read your cluster with your permissions.
        </>
      ) : (
        <>AI isn’t configured on this cluster. Set <code className="rounded bg-surface-sunken px-1">AI_BASE_URL</code> / <code className="rounded bg-surface-sunken px-1">AI_MODEL</code> to enable it.</>
      )}
    </div>
  )
}

/* ─────────────── inline trigger ─────────────── */

export function AiButton({
  mode = 'chat',
  context,
  prompt,
  label = 'Ask AI',
  title,
  className,
}: {
  mode?: AiMode
  context?: AiContext
  prompt?: string
  label?: string
  title?: string
  className?: string
}) {
  const ai = useAi()
  if (!ai.configured) return null
  return (
    <button
      type="button"
      onClick={() => ai.ask({ mode, context, prompt, title })}
      className={
        className ??
        'inline-flex items-center gap-1.5 rounded-md border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 transition-colors hover:border-brand-300 hover:bg-brand-100'
      }
    >
      <SparkIcon /> {label}
    </button>
  )
}

/* ─────────────── icons ─────────────── */
function SparkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2l1.9 5.6L19.5 9l-5.6 1.9L12 16.5l-1.9-5.6L4.5 9l5.6-1.4L12 2z" />
    </svg>
  )
}
function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}
function ToolIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 6h16M4 12h16M4 18h10" strokeLinecap="round" />
    </svg>
  )
}
function WrenchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.1 2.1-2.3-.6-.6-2.3 2.1-2.1z" />
    </svg>
  )
}
function Dots() {
  return (
    <span className="inline-flex gap-1">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-400 [animation-delay:-0.2s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-400 [animation-delay:-0.1s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-400" />
    </span>
  )
}
