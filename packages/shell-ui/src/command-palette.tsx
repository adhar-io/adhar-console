import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { cn } from '@adhar-console/utils'
import { DEFAULT_NAV, type NavItem, type NavSection } from './nav-tree.tsx'
import { assistStore, useAssist, type AssistTurn } from './assist-store.ts'
import { consumePendingAsk, SparkIcon } from './ai-assistant.tsx'
import { useSelection } from './selection-store.ts'
import { useNotifications } from './notifications.ts'
import type { AiMode, AiProposal } from './ai.ts'

export interface CommandPaletteProps {
  open: boolean
  onClose(): void
  /** Sources — a set of flat commands to search through. */
  items?: CommandItem[]
  /** Falls back to DEFAULT_NAV flattened into commands. */
  sections?: NavSection[]
}

export interface CommandItem {
  id: string
  label: string
  description?: string
  to?: string
  search?: Record<string, unknown>
  group?: string
  icon?: ReactNode
  /** Custom action — runs instead of navigating. */
  onSelect?(): void
  keywords?: string[]
}

/**
 * Adhar Assist — the ⌘K overlay, and the primary way to talk to the platform.
 *
 * One large surface with two lanes:
 *   • Conversation (left) — a real LLM chat over `/api/ai/*`: streamed
 *     answers rendered as markdown, tool-call chips showing what the model
 *     read from the cluster (with the user's RBAC), proposals as review-and-
 *     apply cards, stop / regenerate / copy, modes (Chat · Diagnose · Explain
 *     · Generate), slash commands (`/go`, `/diagnose`, `/explain`,
 *     `/generate`, `/new`), context chips (page · cluster · namespace) and a
 *     conversation history kept in the browser.
 *   • Navigate (right) — dynamic results for whatever is typed: every page
 *     and command in the console, ranked live. `⌘⏎` opens the top hit, or
 *     click any. When AI isn't configured the overlay still works as the
 *     command palette.
 *
 * The composer has no focus ring/border highlight by design — the surface
 * itself is the focus.
 */
export function CommandPalette({ open, onClose, items, sections = DEFAULT_NAV }: CommandPaletteProps) {
  if (!open) return null
  return <AssistOverlay onClose={onClose} items={items} sections={sections} />
}

const MODES: Array<{ id: AiMode; label: string; hint: string }> = [
  { id: 'chat', label: 'Chat', hint: 'Ask anything about the platform' },
  { id: 'diagnose', label: 'Diagnose', hint: 'Root-cause a workload' },
  { id: 'explain', label: 'Explain', hint: 'What is this resource?' },
  { id: 'generate', label: 'Generate', hint: 'Draft a manifest to review' },
]

const STARTERS: Array<{ label: string; prompt: string; mode?: AiMode }> = [
  { label: 'What needs my attention right now?', prompt: 'Scan the cluster for Warning events and unhealthy workloads, group by namespace, and tell me what needs attention first.' },
  { label: 'Why is a pod crash-looping?', prompt: 'Find pods in CrashLoopBackOff or ImagePullBackOff across the cluster, run diagnostics on the worst one, and explain the root cause.' },
  { label: 'Are my Argo CD apps in sync?', prompt: 'List Argo CD applications that are OutOfSync or Degraded and explain what is blocking each.' },
  { label: 'Which policies are being violated?', prompt: 'Summarise Kyverno policy violations: which policies fail most, which namespaces are affected, and what to fix first.' },
  { label: 'Draft a Deployment', prompt: 'Draft a production-ready Deployment with resource requests/limits, probes, non-root security context and 2 replicas for an image I will name.', mode: 'generate' },
  { label: 'Explain the current page', prompt: 'Explain what the resource I am looking at does, its current state, and anything an operator should know.', mode: 'explain' },
]

function AssistOverlay({ onClose, items, sections }: { onClose(): void; items?: CommandItem[]; sections: NavSection[] }) {
  const navigate = useNavigate()
  const state = useAssist()
  const selection = useSelection()
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<AiMode>('chat')
  const [rail, setRail] = useState<'navigate' | 'history'>('navigate')
  const [activeNav, setActiveNav] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  const allItems = useMemo<CommandItem[]>(() => (items && items.length ? items : flattenNav(sections)), [items, sections])
  const navQuery = input.startsWith('/go ') ? input.slice(4) : input
  const navResults = useMemo(() => filterItems(allItems, navQuery).slice(0, 12), [allItems, navQuery])
  const page = typeof location !== 'undefined' ? location.pathname : ''
  const pageItem = useMemo(() => allItems.find((i) => i.to && page.startsWith(i.to) && i.to !== '/') ?? allItems.find((i) => i.to === page), [allItems, page])

  // Boot: config, pending ask (from useAi().ask / AiButton), focus.
  useEffect(() => {
    void assistStore.loadConfig()
    const pending = consumePendingAsk()
    if (pending) {
      const m = pending.mode ?? 'chat'
      setMode(m)
      assistStore.run(m, {
        prompt: pending.prompt,
        context: pending.context,
        userLabel: m === 'chat' ? pending.prompt : pending.title ?? MODES.find((x) => x.id === m)?.label,
        title: pending.title,
      })
    }
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  // Keep the thread pinned to the newest message while streaming.
  useLayoutEffect(() => {
    const el = threadRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [state.current.turns])

  useEffect(() => {
    setActiveNav(0)
  }, [navQuery])

  // Keys: Esc closes, ⌘⏎ opens top nav hit, ↑/↓ moves through nav hits when typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])

  const runItem = (item: CommandItem) => {
    if (item.onSelect) item.onSelect()
    else if (item.to) navigate({ to: item.to, search: item.search as never })
    onClose()
  }

  const submit = () => {
    const text = input.trim()
    if (!text) return
    // Slash commands.
    if (text === '/new') {
      assistStore.newChat()
      setInput('')
      return
    }
    if (text.startsWith('/go')) {
      const hit = navResults[activeNav] ?? navResults[0]
      if (hit) runItem(hit)
      return
    }
    let m = mode
    let prompt = text
    const slash = /^\/(diagnose|explain|generate|chat)\b\s*/.exec(text)
    if (slash) {
      m = slash[1] as AiMode
      prompt = text.slice(slash[0].length).trim()
      setMode(m)
    }
    if (!state.configured) {
      // No LLM — behave as the command palette.
      const hit = navResults[0]
      if (hit) runItem(hit)
      return
    }
    if (state.busy) return
    setInput('')
    stickToBottom.current = true
    assistStore.run(m, {
      prompt: prompt || undefined,
      userLabel: m === 'chat' ? prompt : `${MODES.find((x) => x.id === m)?.label}${prompt ? `: ${prompt}` : ''}`,
    })
  }

  const turns = state.current.turns
  const hasThread = turns.length > 0
  const ctxChips = [
    pageItem ? { k: 'page', v: pageItem.label } : null,
    { k: 'cluster', v: selection.cluster || 'local' },
    { k: 'namespace', v: selection.namespace || 'all' },
    state.context?.name ? { k: state.context.kind ?? state.context.resource, v: state.context.name } : null,
  ].filter(Boolean) as Array<{ k: string; v: string }>

  return (
    <div role="dialog" aria-modal="true" aria-label="Adhar Assist" className="fixed inset-0 z-[70] flex items-start justify-center px-3 pt-[6vh] sm:px-6">
      <div className="fade-in absolute inset-0 bg-slate-950/60 backdrop-blur-[3px]" onClick={onClose} aria-hidden />
      <div className="pop-in relative flex h-[86vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-edge-default bg-surface-app shadow-[0_40px_80px_-20px_rgba(15,23,42,0.5)]">
        {/* ═══ header ═══ */}
        <header className="flex items-center gap-3 border-b border-edge-subtle bg-surface-raised px-4 py-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-linear-to-br from-brand-500 to-accent-500 text-white shadow-sm">
            <SparkIcon size={15} />
          </span>
          <div className="min-w-0">
            <div className="text-[14px] font-semibold tracking-tight text-content">Adhar Assist</div>
            <div className="truncate text-[11px] text-content-subtle">
              {state.configured ? `${state.model ? `${state.model} · ` : ''}reads with your RBAC · never applies without approval` : 'AI not configured — search & navigate still work'}
            </div>
          </div>
          <div className="ml-2 hidden flex-wrap items-center gap-1 md:flex">
            {ctxChips.map((c) => (
              <span key={c.k} className="inline-flex items-center gap-1 rounded-md bg-surface-sunken px-1.5 py-0.5 text-[10.5px] text-content-muted"><span className="text-content-subtle">{c.k}</span><span className="font-mono text-content">{c.v}</span></span>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1">
            <HeaderBtn onClick={() => { assistStore.newChat(); setInput(''); inputRef.current?.focus() }} title="New conversation">
              <IconPlus /> New
            </HeaderBtn>
            <HeaderBtn onClick={() => setRail(rail === 'history' ? 'navigate' : 'history')} title="Conversation history" active={rail === 'history'}>
              <IconHistory /> History{state.history.length ? ` · ${state.history.length}` : ''}
            </HeaderBtn>
            <button type="button" onClick={onClose} aria-label="Close" className="ml-1 flex h-8 w-8 items-center justify-center rounded-lg text-content-subtle hover:bg-surface-sunken hover:text-content"><IconX /></button>
          </div>
        </header>

        {/* ═══ body ═══ */}
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_300px]">
          {/* ── conversation ── */}
          <section className="flex min-h-0 flex-col">
            <div
              ref={threadRef}
              onScroll={(e) => {
                const el = e.currentTarget
                stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
              }}
              className="min-h-0 flex-1 overflow-y-auto px-5 py-5"
            >
              {!hasThread ? (
                <Welcome configured={state.configured} onPick={(s) => { if (s.mode) setMode(s.mode); assistStore.run(s.mode ?? 'chat', { prompt: s.prompt, userLabel: s.mode && s.mode !== 'chat' ? `${MODES.find((x) => x.id === s.mode)?.label}: ${s.label}` : s.prompt }) }} navHint={navResults[0]} />
              ) : (
                <div className="mx-auto max-w-3xl space-y-5">
                  {turns.map((t) => (
                    <TurnView key={t.id} turn={t} canApply={state.canApply} />
                  ))}
                  {!state.busy && turns.length ? (
                    <div className="flex justify-end gap-1">
                      <SmallBtn onClick={() => assistStore.regenerate()}><IconRefresh /> Regenerate</SmallBtn>
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            {/* composer */}
            <div className="border-t border-edge-subtle bg-surface-raised px-4 pb-3 pt-2.5">
              <div className="mb-2 flex flex-wrap items-center gap-1">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setMode(m.id)}
                    title={m.hint}
                    className={cn('h-7 rounded-md px-2.5 text-[11.5px] font-medium transition-colors', mode === m.id ? 'bg-brand-600 text-white' : 'text-content-muted hover:bg-surface-sunken hover:text-content')}
                  >
                    {m.label}
                  </button>
                ))}
                <span className="ml-auto hidden text-[10.5px] text-content-subtle sm:inline">
                  <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">/go</kbd> navigate · <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">/diagnose</kbd> <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">/explain</kbd> <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">/generate</kbd> <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">/new</kbd>
                </span>
              </div>
              <div className="flex items-end gap-2 rounded-xl bg-surface-app px-3 py-2 ring-1 ring-edge-subtle">
                <span className="mb-1.5 text-brand-600"><SparkIcon size={16} /></span>
                <textarea
                  ref={inputRef}
                  value={input}
                  rows={1}
                  spellCheck={false}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      if (e.metaKey || e.ctrlKey) {
                        const hit = navResults[activeNav] ?? navResults[0]
                        if (hit) runItem(hit)
                        return
                      }
                      submit()
                    } else if (e.key === 'ArrowDown' && navResults.length && input.trim()) {
                      e.preventDefault()
                      setActiveNav((i) => Math.min(i + 1, navResults.length - 1))
                    } else if (e.key === 'ArrowUp' && navResults.length && input.trim()) {
                      e.preventDefault()
                      setActiveNav((i) => Math.max(i - 1, 0))
                    }
                  }}
                  placeholder={state.configured ? `Ask Adhar anything, or type a page name to jump there…` : 'Search pages, apps and settings…'}
                  aria-label="Message Adhar Assist"
                  className="max-h-40 min-h-[28px] flex-1 resize-none bg-transparent py-1 text-[14px] leading-6 text-content outline-none placeholder:text-content-subtle focus:outline-none focus:ring-0"
                  style={{ height: 'auto' }}
                  onInput={(e) => {
                    const el = e.currentTarget
                    el.style.height = 'auto'
                    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
                  }}
                />
                {state.busy ? (
                  <button type="button" onClick={() => assistStore.stop()} className="mb-0.5 inline-flex h-8 items-center gap-1 rounded-lg bg-surface-sunken px-3 text-[12px] font-semibold text-content-muted hover:text-content">
                    <IconStop /> Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={submit}
                    disabled={!input.trim()}
                    className="mb-0.5 inline-flex h-8 items-center gap-1 rounded-lg bg-brand-600 px-3 text-[12px] font-semibold text-white hover:bg-brand-700 disabled:opacity-40"
                  >
                    {state.configured ? 'Send' : 'Go'} <IconReturn />
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* ── rail ── */}
          <aside className="hidden min-h-0 flex-col border-l border-edge-subtle bg-surface-raised/60 md:flex">
            <div className="flex items-center gap-1 border-b border-edge-subtle p-1.5">
              {(
                [
                  ['navigate', 'Navigate'],
                  ['history', 'History'],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" onClick={() => setRail(id)} className={cn('h-7 flex-1 rounded-md text-[11.5px] font-medium transition-colors', rail === id ? 'bg-surface-raised text-content shadow-sm ring-1 ring-edge-default' : 'text-content-muted hover:text-content')}>
                  {label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {rail === 'navigate' ? (
                <NavRail results={navResults} query={navQuery} active={activeNav} onHover={setActiveNav} onPick={runItem} all={allItems} />
              ) : (
                <HistoryRail />
              )}
            </div>
            <div className="border-t border-edge-subtle px-3 py-2 text-[10.5px] text-content-subtle">
              <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">⏎</kbd> send · <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">⌘⏎</kbd> open top result · <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">esc</kbd> close
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

/* ─────────── welcome ─────────── */

function Welcome({ configured, onPick, navHint }: { configured: boolean; onPick(s: { label: string; prompt: string; mode?: AiMode }): void; navHint?: CommandItem }) {
  const notif = useNotifications()
  const insights = notif.items.filter((n) => !n.read && n.prompt).slice(0, 4)
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center pt-6 text-center">
      {insights.length ? (
        <div className="mb-5 w-full rounded-xl border border-violet-200 bg-violet-50/60 p-3 text-left dark:border-violet-500/30 dark:bg-violet-500/10">
          <div className="mb-1.5 flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-wider text-violet-700 dark:text-violet-300">
            <span>Needs attention · {insights.length}</span>
            <span className="font-normal normal-case tracking-normal text-content-subtle">from your Notification Center</span>
          </div>
          <div className="space-y-1">
            {insights.map((n) => (
              <button key={n.id} type="button" onClick={() => { notif.markRead(n.id); onPick({ label: n.title, prompt: n.prompt! }) }} className="group flex w-full items-center gap-2 rounded-lg bg-surface-raised px-2.5 py-1.5 text-left ring-1 ring-edge-subtle transition-colors hover:ring-violet-300">
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', n.kind === 'error' ? 'bg-rose-500' : n.kind === 'warning' ? 'bg-amber-500' : 'bg-violet-500')} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-content">{n.title}</span>
                <span className="shrink-0 text-[11px] text-violet-700 opacity-0 transition-opacity group-hover:opacity-100 dark:text-violet-300">Ask →</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-linear-to-br from-brand-500 to-accent-500 text-white shadow-lg shadow-brand-600/25">
        <SparkIcon size={26} />
      </span>
      <h2 className="mt-4 text-xl font-semibold tracking-tight text-content">How can I help?</h2>
      <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-content-muted">
        {configured
          ? 'I read your cluster, Argo CD, policies and events with your permissions, explain what I find, and propose changes you approve — nothing is applied on its own.'
          : 'AI isn’t configured on this cluster yet (set AI_BASE_URL / AI_MODEL). Meanwhile, type any page, app or setting to jump straight to it.'}
      </p>
      {configured ? (
        <div className="mt-6 grid w-full gap-2 sm:grid-cols-2">
          {STARTERS.map((s) => (
            <button key={s.label} type="button" onClick={() => onPick(s)} className="group rounded-xl border border-edge-default bg-surface-raised p-3 text-left transition-colors hover:border-brand-300 hover:bg-brand-50/40 dark:hover:border-brand-500/40 dark:hover:bg-brand-500/5">
              <div className="flex items-center justify-between gap-2 text-[13px] font-medium text-content">
                {s.label}
                <span className="text-content-subtle opacity-0 transition-opacity group-hover:opacity-100"><IconReturn /></span>
              </div>
              <div className="mt-0.5 line-clamp-2 text-[11.5px] text-content-subtle">{s.prompt}</div>
            </button>
          ))}
        </div>
      ) : navHint ? (
        <div className="mt-6 text-[12px] text-content-muted">Press <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono">⏎</kbd> to open <span className="font-medium text-content">{navHint.label}</span></div>
      ) : null}
    </div>
  )
}

/* ─────────── turns ─────────── */

function TurnView({ turn, canApply }: { turn: AssistTurn; canApply: boolean }) {
  const [copied, setCopied] = useState(false)
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-brand-600 px-4 py-2.5 text-[13.5px] leading-relaxed text-white shadow-sm">
          {turn.mode && turn.mode !== 'chat' ? <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/70">{turn.mode}</div> : null}
          <div className="whitespace-pre-wrap">{turn.content}</div>
        </div>
      </div>
    )
  }
  return (
    <div className="flex gap-3">
      <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-brand-500 to-accent-500 text-white"><SparkIcon size={13} /></span>
      <div className="min-w-0 flex-1 space-y-2">
        {turn.tools.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {turn.tools.map((t, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded-full border border-edge-subtle bg-surface-sunken px-2 py-0.5 text-[11px] text-content-muted" title={JSON.stringify(t.args)}>
                <IconTool /> {toolLabel(t.name, t.args)}
              </span>
            ))}
          </div>
        ) : null}
        {turn.content ? (
          <div className="group relative rounded-2xl rounded-tl-md bg-surface-raised px-4 py-3 text-[13.5px] leading-relaxed text-content ring-1 ring-edge-subtle">
            <Markdown text={turn.content} />
            {turn.streaming ? <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-brand-400 align-middle" /> : null}
            {!turn.streaming ? (
              <button
                type="button"
                onClick={() => { void navigator.clipboard?.writeText(turn.content); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
                className="absolute right-2 top-2 rounded-md bg-surface-raised px-1.5 py-0.5 text-[10.5px] text-content-subtle opacity-0 ring-1 ring-edge-default transition-opacity hover:text-content group-hover:opacity-100"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            ) : null}
          </div>
        ) : turn.streaming ? (
          <div className="flex items-center gap-2 py-2 text-[13px] text-content-subtle"><Dots /> {turn.tools.length ? 'reading the cluster…' : 'thinking…'}</div>
        ) : null}
        {turn.proposals.map((p, i) => (
          <ProposalCard key={i} proposal={p} canApply={canApply} />
        ))}
        {turn.error ? <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-300">{turn.error}</div> : null}
      </div>
    </div>
  )
}

function ProposalCard({ proposal, canApply }: { proposal: AiProposal; canApply: boolean }) {
  const [state, setState] = useState<'idle' | 'applying' | 'done' | 'error'>('idle')
  const [msg, setMsg] = useState('')
  const [showYaml, setShowYaml] = useState(false)
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-500/25 dark:bg-amber-500/10">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-amber-600"><IconWrench /></span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-amber-900 dark:text-amber-200">Proposed change — review &amp; apply</div>
          <div className="mt-0.5 text-[13px] text-content">{proposal.summary}</div>
        </div>
      </div>
      <button type="button" onClick={() => setShowYaml((s) => !s)} className="mt-2 text-[11px] font-medium text-amber-800 underline-offset-2 hover:underline dark:text-amber-300">
        {showYaml ? 'Hide' : 'View'} manifest
      </button>
      {showYaml ? <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100">{JSON.stringify(proposal.manifest, null, 2)}</pre> : null}
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          disabled={!canApply || state === 'applying' || state === 'done'}
          onClick={async () => {
            setState('applying')
            try {
              const r = await assistStore.applyProposal(proposal.manifest)
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
        <button type="button" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(proposal.manifest, null, 2))} className="rounded-md border border-amber-300 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:text-amber-200 dark:hover:bg-amber-500/10">Copy manifest</button>
        {msg ? <span className={cn('text-[11px]', state === 'error' ? 'text-rose-700 dark:text-rose-300' : 'text-emerald-700 dark:text-emerald-300')}>{msg}</span> : null}
      </div>
      <div className="mt-2 flex items-center gap-1 text-[11px] text-amber-800/80 dark:text-amber-300/80"><IconShield /> Nothing happens until you review and apply.</div>
    </div>
  )
}

function toolLabel(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, string>
  switch (name) {
    case 'k8s_list': return `list ${a.resource ?? ''}${a.namespace ? ` · ${a.namespace}` : ''}`
    case 'k8s_get': return `get ${a.resource ?? ''}/${a.name ?? ''}`
    case 'k8s_logs': return `logs ${a.pod ?? ''}`
    case 'k8s_events': return 'events'
    case 'k8s_discovery': return 'discover API'
    case 'k8s_describe': return `describe ${a.resource ?? ''}/${a.name ?? ''}${a.namespace ? ` · ${a.namespace}` : ''}`
    case 'k8s_pod_diagnostics': return `pod diagnostics ${a.pod ?? ''}${a.namespace ? ` · ${a.namespace}` : ''}`
    case 'k8s_workload_health': return `${a.kind ?? 'workload'} health ${a.name ?? ''}${a.namespace ? ` · ${a.namespace}` : ''}`
    case 'k8s_events_scan': return `warning scan · ${a.namespace ?? 'cluster'}`
    case 'argocd_app_status': return `argocd app ${a.name ?? ''}`
    case 'propose_change': return 'propose change'
    default: return name
  }
}

/* ─────────── rails ─────────── */

function NavRail({ results, query, active, onHover, onPick, all }: { results: CommandItem[]; query: string; active: number; onHover(i: number): void; onPick(i: CommandItem): void; all: CommandItem[] }) {
  const list = query.trim() ? results : all.slice(0, 12)
  let lastGroup: string | undefined
  return (
    <div>
      <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">{query.trim() ? `Matches · ${results.length}` : 'Go to'}</div>
      {list.length === 0 ? <p className="px-2 py-3 text-[11.5px] text-content-subtle">No page matches “{query}” — send it to Assist instead.</p> : null}
      <div className="space-y-px">
        {list.map((item, i) => {
          const header = item.group && item.group !== lastGroup && !query.trim() ? item.group : null
          lastGroup = item.group
          const isActive = query.trim() ? i === active : false
          return (
            <div key={item.id}>
              {header ? <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">{header}</div> : null}
              <button
                type="button"
                onMouseEnter={() => onHover(i)}
                onClick={() => onPick(item)}
                className={cn('group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors', isActive ? 'bg-brand-50 text-content ring-1 ring-inset ring-brand-200 dark:bg-brand-500/10 dark:ring-brand-500/30' : 'text-content-muted hover:bg-surface-sunken hover:text-content')}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center text-content-subtle [&>svg]:h-4 [&>svg]:w-4">{item.icon ?? <IconDot />}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">{item.label}</span>
                  {item.description ? <span className="block truncate text-[10.5px] text-content-subtle">{item.description}</span> : null}
                </span>
                {query.trim() && item.group ? <span className="shrink-0 text-[9.5px] uppercase tracking-wider text-content-subtle">{item.group}</span> : null}
                <span className={cn('shrink-0 text-content-subtle transition-opacity', isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}><IconReturn /></span>
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function HistoryRail() {
  const state = useAssist()
  if (!state.history.length) return <p className="px-2 py-4 text-[11.5px] text-content-subtle">Conversations you have with Assist are kept here (in this browser).</p>
  return (
    <div>
      <div className="flex items-center justify-between px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
        <span>Recent</span>
        <button type="button" onClick={() => assistStore.clearHistory()} className="font-medium normal-case tracking-normal hover:text-rose-600">clear</button>
      </div>
      <div className="space-y-px">
        {state.history.map((c) => (
          <div key={c.id} className="group flex items-center gap-1">
            <button type="button" onClick={() => assistStore.openConversation(c.id)} className={cn('min-w-0 flex-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-sunken', state.current.id === c.id ? 'bg-brand-50 dark:bg-brand-500/10' : '')}>
              <div className="truncate text-[12.5px] font-medium text-content">{c.title}</div>
              <div className="truncate text-[10.5px] text-content-subtle">{c.turns.length} messages · {relTime(c.updatedAt)}</div>
            </button>
            <button type="button" onClick={() => assistStore.deleteConversation(c.id)} aria-label="Delete conversation" className="rounded p-1 text-content-subtle opacity-0 hover:bg-surface-sunken hover:text-rose-600 group-hover:opacity-100"><IconTrash /></button>
          </div>
        ))}
      </div>
    </div>
  )
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/* ─────────── markdown-lite ─────────── */

/**
 * Small, dependency-free renderer for the subset the assistant emits:
 * fenced code, inline code, headings, bullet / numbered lists, bold, italic,
 * links and paragraphs. Never injects HTML.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text])
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        if (b.type === 'code') {
          return (
            <div key={i} className="group/code relative">
              <pre className="max-h-96 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-[11.5px] leading-relaxed text-slate-100">{b.text}</pre>
              {b.lang ? <span className="absolute right-2 top-1.5 text-[10px] uppercase text-slate-500">{b.lang}</span> : null}
              <button type="button" onClick={() => void navigator.clipboard?.writeText(b.text)} className="absolute bottom-2 right-2 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300 opacity-0 transition-opacity hover:text-white group-hover/code:opacity-100">copy</button>
            </div>
          )
        }
        if (b.type === 'heading') return <div key={i} className={cn('font-semibold text-content', b.level <= 2 ? 'text-[14px]' : 'text-[13px]')}>{inline(b.text)}</div>
        if (b.type === 'ul') return <ul key={i} className="list-disc space-y-0.5 pl-5">{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ul>
        if (b.type === 'ol') return <ol key={i} className="list-decimal space-y-0.5 pl-5">{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ol>
        return <p key={i}>{inline(b.text)}</p>
      })}
    </div>
  )
}

type Block =
  | { type: 'p'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'code'; lang?: string; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r/g, '').split('\n')
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim() || undefined
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      i++
      out.push({ type: 'code', lang, text: buf.join('\n') })
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      out.push({ type: 'heading', level: h[1].length, text: h[2] })
      i++
      continue
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*•]\s+/, ''))
      out.push({ type: 'ul', items })
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''))
      out.push({ type: 'ol', items })
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const buf: string[] = []
    while (i < lines.length && lines[i].trim() && !/^```|^#{1,4}\s|^\s*[-*•]\s+|^\s*\d+[.)]\s+/.test(lines[i])) buf.push(lines[i++])
    out.push({ type: 'p', text: buf.join(' ') })
  }
  return out
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let k = 0
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0
    if (idx > last) out.push(text.slice(last, idx))
    const tok = m[0]
    if (tok.startsWith('`')) out.push(<code key={k++} className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[12px] text-content">{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('**')) out.push(<strong key={k++} className="font-semibold">{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith('[')) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)
      if (mm) out.push(<a key={k++} href={mm[2]} target="_blank" rel="noreferrer" className="text-brand-700 underline underline-offset-2 dark:text-brand-300">{mm[1]}</a>)
    } else out.push(<em key={k++}>{tok.slice(1, -1)}</em>)
    last = idx + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/* ─────────── bits ─────────── */

function HeaderBtn({ children, onClick, title, active = false }: { children: ReactNode; onClick(): void; title: string; active?: boolean }) {
  return (
    <button type="button" onClick={onClick} title={title} className={cn('inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors', active ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300' : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong hover:text-content')}>
      {children}
    </button>
  )
}

function SmallBtn({ children, onClick }: { children: ReactNode; onClick(): void }) {
  return <button type="button" onClick={onClick} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] text-content-muted hover:bg-surface-sunken hover:text-content">{children}</button>
}

function Dots() {
  return (
    <span className="inline-flex gap-1" aria-hidden>
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-400 [animation-delay:-0.2s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-400 [animation-delay:-0.1s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-400" />
    </span>
  )
}

const I = ({ children, size = 14, sw = 2 }: { children: ReactNode; size?: number; sw?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">{children}</svg>
)
const IconX = () => <I size={16}><path d="M18 6 6 18M6 6l12 12" /></I>
const IconPlus = () => <I size={12} sw={2.5}><path d="M12 5v14M5 12h14" /></I>
const IconHistory = () => <I size={13}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></I>
const IconReturn = () => <I size={12} sw={2.25}><polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 0 1-4 4H4" /></I>
const IconStop = () => <I size={12} sw={2.5}><rect x="6" y="6" width="12" height="12" rx="2" /></I>
const IconRefresh = () => <I size={12}><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></I>
const IconTool = () => <I size={11}><path d="M4 6h16M4 12h16M4 18h10" /></I>
const IconShield = () => <I size={11}><path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5l8-3z" /></I>
const IconWrench = () => <I size={15}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.1 2.1-2.3-.6-.6-2.3 2.1-2.1z" /></I>
const IconTrash = () => <I size={12}><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></I>
const IconDot = () => <svg width="6" height="6" viewBox="0 0 6 6" aria-hidden><circle cx="3" cy="3" r="2" fill="currentColor" /></svg>

/* ─────────── nav flatten + filter ─────────── */

function flattenNav(sections: NavSection[]): CommandItem[] {
  const out: CommandItem[] = []
  const walk = (item: NavItem, groupLabel: string) => {
    if (item.to) {
      out.push({
        id: item.id,
        label: item.label,
        description: item.description,
        to: item.to,
        search: item.search ? { section: item.search } : undefined,
        group: groupLabel,
        icon: item.icon,
        keywords: item.description ? [item.description] : undefined,
      })
    }
    item.children?.forEach((c) => walk(c, groupLabel))
  }
  for (const section of sections) {
    const label = section.label ?? 'General'
    for (const item of section.items) walk(item, label)
  }
  return out
}

function filterItems(items: CommandItem[], q: string): CommandItem[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return items
  return items
    .map((item) => ({ item, score: score(item, needle) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item)
}

function score(item: CommandItem, needle: string): number {
  const label = item.label.toLowerCase()
  let s = 0
  if (label === needle) s += 100
  else if (label.startsWith(needle)) s += 50
  else if (label.includes(needle)) s += 25
  if (item.group?.toLowerCase().includes(needle)) s += 6
  if (item.description?.toLowerCase().includes(needle)) s += 10
  if (item.keywords?.some((k) => k.toLowerCase().includes(needle))) s += 8
  // Multi-word queries: every word must hit somewhere.
  const words = needle.split(/\s+/).filter((w) => w.length > 2)
  if (words.length > 1) {
    const hay = `${label} ${item.description ?? ''} ${item.group ?? ''}`.toLowerCase()
    if (words.every((w) => hay.includes(w))) s += 15
  }
  return s
}
