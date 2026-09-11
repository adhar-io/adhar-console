import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { cn } from '@adhar-console/utils'
import { DEFAULT_NAV, type NavItem, type NavSection } from './nav-tree.tsx'
import { assistStore, useAssist, type ChatEntry, type Finding, type PlanStep, type ToolCallView } from './agui/store.ts'
import { GenerativeBlock } from './agui/generative.tsx'
import { consumePendingAsk, SparkIcon } from './ai-assistant.tsx'
import { useSelection } from './selection-store.ts'
import { useNotifications } from './notifications.ts'

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
 * Adhar AI — the ⌘K overlay, and the primary way to talk to the platform.
 *
 * The conversation runs on **AG-UI** (the Agent-User Interaction Protocol):
 * the BFF is an AG-UI server and this overlay is an AG-UI client, so what you
 * see is driven by protocol events rather than a bespoke token stream:
 *
 *   • **Agents** — a roster (Reliability · Delivery · Security · FinOps ·
 *     Platform guide), each with its own brief, toolbox and starters.
 *   • **Generative UI** — tool results and `render_ui` calls arrive as CUSTOM
 *     events and render as real components (diagnosis cards, tables, charts,
 *     timelines) inline in the transcript, not as JSON.
 *   • **Live agent state** — STATE_SNAPSHOT / STATE_DELTA drive the workspace
 *     rail: the agent's plan ticking off step by step and its findings
 *     accumulating while it works.
 *   • **Frontend tools** — the agent can navigate the console, open a resource
 *     drawer, or stop and ask the operator a question (human-in-the-loop).
 *   • **Navigate lane** — every page and command in the console, ranked live.
 *     `⌘⏎` opens the top hit. With no LLM configured this is still a full
 *     command palette.
 */
export function CommandPalette({ open, onClose, items, sections = DEFAULT_NAV }: CommandPaletteProps) {
  if (!open) return null
  return <AssistOverlay onClose={onClose} items={items} sections={sections} />
}

const SLASH: Array<{ cmd: string; hint: string }> = [
  { cmd: '/go', hint: 'Jump to a page instead of asking' },
  { cmd: '/new', hint: 'Start a fresh conversation' },
]

/** Fallback starters when the roster hasn't loaded (or AI is off). */
const FALLBACK_STARTERS = [
  { label: 'What needs my attention right now?', prompt: 'Scan the cluster for Warning events and unhealthy workloads, then tell me what needs attention first.' },
  { label: 'Why is a pod crash-looping?', prompt: 'Find pods in CrashLoopBackOff or ImagePullBackOff, diagnose the worst one and explain the root cause.' },
]

function AssistOverlay({ onClose, items, sections }: { onClose(): void; items?: CommandItem[]; sections: NavSection[] }) {
  const navigate = useNavigate()
  const state = useAssist()
  const selection = useSelection()
  const [input, setInput] = useState('')
  const [rail, setRail] = useState<'navigate' | 'agent' | 'history'>('navigate')
  const [attachContext, setAttachContext] = useState(true)
  const [activeNav, setActiveNav] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  const allItems = useMemo<CommandItem[]>(() => (items && items.length ? items : flattenNav(sections)), [items, sections])
  const navQuery = input.startsWith('/go ') ? input.slice(4) : input
  const navResults = useMemo(() => filterItems(allItems, navQuery).slice(0, 12), [allItems, navQuery])
  const page = typeof location !== 'undefined' ? location.pathname : ''
  const pageItem = useMemo(() => allItems.find((i) => i.to && page.startsWith(i.to) && i.to !== '/') ?? allItems.find((i) => i.to === page), [allItems, page])
  const agent = state.agents.find((a) => a.id === state.agentId)

  // Boot: config, a queued ask (from useAi().ask / AiButton), focus.
  useEffect(() => {
    void assistStore.loadConfig()
    const pending = consumePendingAsk()
    if (pending) {
      if (pending.agentId) assistStore.setAgent(pending.agentId)
      if (pending.context) assistStore.setContext(pending.context)
      if (pending.prompt) assistStore.send(pending.prompt, { context: pending.context, title: pending.title })
    }
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  /**
   * Frontend tools. Registered while the overlay is mounted because they need
   * the router; the store itself outlives the overlay so a run keeps going if
   * the agent navigates and the panel closes.
   */
  useEffect(() => {
    assistStore.setFrontendHandler('navigate_to', (args) => {
      const path = String(args.path ?? '')
      if (!path.startsWith('/')) return JSON.stringify({ error: 'path must be a console route starting with /' })
      const [pathname, qs] = path.split('?')
      const search = qs ? Object.fromEntries(new URLSearchParams(qs)) : undefined
      try {
        navigate({ to: pathname, search: search as never })
      } catch {
        return JSON.stringify({ error: `no such console route: ${pathname}` })
      }
      onClose()
      return JSON.stringify({ ok: true, navigated: path, note: 'The operator is now on this page.' })
    })
    assistStore.setFrontendHandler('open_resource', (args) => {
      globalThis.dispatchEvent(new CustomEvent('adhar:ai:open-resource', { detail: args }))
      return JSON.stringify({ ok: true, opened: `${String(args.kind)}/${String(args.name)}` })
    })
    return () => {
      assistStore.setFrontendHandler('navigate_to', null)
      assistStore.setFrontendHandler('open_resource', null)
    }
  }, [navigate, onClose])

  // Keep the thread pinned to the newest message while streaming.
  useLayoutEffect(() => {
    const el = threadRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [state.thread.messages, state.run])

  useEffect(() => setActiveNav(0), [navQuery])

  // A run with live state or a question pending is worth showing by default.
  useEffect(() => {
    if (state.pendingAsk) setRail('agent')
  }, [state.pendingAsk])

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
    if (text === '/new') {
      assistStore.newThread()
      setInput('')
      return
    }
    if (text.startsWith('/go')) {
      const hit = navResults[activeNav] ?? navResults[0]
      if (hit) runItem(hit)
      return
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
    if (!attachContext) assistStore.setContext(undefined)
    assistStore.send(text)
  }

  const messages = state.thread.messages
  const hasThread = messages.length > 0
  const starters = agent?.starters?.length ? agent.starters : FALLBACK_STARTERS
  const ctxChips = !attachContext ? [] : [
    pageItem ? { k: 'page', v: pageItem.label } : null,
    { k: 'cluster', v: selection.cluster || 'local' },
    { k: 'namespace', v: selection.namespace || 'all' },
    state.context?.name ? { k: state.context.kind ?? state.context.resource, v: state.context.name } : null,
  ].filter(Boolean) as Array<{ k: string; v: string }>

  return (
    <div role="dialog" aria-modal="true" aria-label="Adhar AI" className="fixed inset-0 z-[70] flex items-start justify-center px-3 pt-[6vh] sm:px-6">
      <div className="fade-in absolute inset-0 bg-slate-950/60 backdrop-blur-[3px]" onClick={onClose} aria-hidden />
      <div className="pop-in relative flex h-[86vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-edge-default bg-surface-app shadow-[0_40px_80px_-20px_rgba(15,23,42,0.5)]">
        {/* ═══ header ═══ */}
        <header className="flex items-center gap-3 border-b border-edge-subtle bg-surface-raised px-4 py-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-linear-to-br from-brand-500 to-accent-500 text-white shadow-sm">
            <SparkIcon size={15} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[14px] font-semibold tracking-tight text-content">
              Adhar AI
              {state.configured ? <span className="rounded bg-surface-sunken px-1 py-px font-mono text-[9px] font-medium uppercase tracking-wider text-content-subtle">AG-UI</span> : null}
            </div>
            <div className="truncate text-[11px] text-content-subtle">
              {state.configured
                ? `${state.model ? `${state.model} · ` : ''}reads with your RBAC · never applies without approval${attachContext ? '' : ' · context off'}`
                : 'AI not configured — search & navigate still work'}
            </div>
          </div>
          <div className="ml-2 hidden flex-wrap items-center gap-1 md:flex">
            {ctxChips.map((c) => (
              <span key={c.k} className="inline-flex items-center gap-1 rounded-md bg-surface-sunken px-1.5 py-0.5 text-[10.5px] text-content-muted"><span className="text-content-subtle">{c.k}</span><span className="font-mono text-content">{c.v}</span></span>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1">
            <HeaderBtn onClick={() => { assistStore.newThread(); setInput(''); inputRef.current?.focus() }} title="New conversation">
              <IconPlus /> New
            </HeaderBtn>
            <button type="button" onClick={onClose} aria-label="Close" className="ml-1 flex h-8 w-8 items-center justify-center rounded-lg text-content-subtle hover:bg-surface-sunken hover:text-content"><IconX /></button>
          </div>
        </header>

        {/* ═══ body ═══ */}
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_320px]">
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
                <Welcome configured={state.configured} starters={starters} onPick={(prompt) => assistStore.send(prompt)} navHint={navResults[0]} agentName={agent?.name} />
              ) : (
                <div className="mx-auto max-w-3xl space-y-5">
                  {messages.map((m) => <EntryView key={m.id} entry={m} />)}
                  {state.pendingAsk ? <AskCard /> : null}
                  {state.busy && !state.pendingAsk ? <Thinking run={state.run} /> : null}
                  {!state.busy && messages.length ? (
                    <div className="flex justify-end gap-1">
                      <SmallBtn onClick={() => assistStore.regenerate()}><IconRefresh /> Regenerate</SmallBtn>
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            {/* composer */}
            <div className="border-t border-edge-subtle bg-surface-raised px-4 pb-3 pt-2.5">
              {state.configured && state.agents.length ? (
                <div className="mb-2 flex flex-wrap items-center gap-1">
                  {state.agents.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => assistStore.setAgent(a.id)}
                      title={a.description}
                      disabled={state.busy}
                      className={cn(
                        'h-7 rounded-md px-2.5 text-[11.5px] font-medium transition-colors disabled:opacity-50',
                        state.agentId === a.id ? 'bg-brand-600 text-white' : 'text-content-muted hover:bg-surface-sunken hover:text-content',
                      )}
                    >
                      {a.name}
                    </button>
                  ))}
                  <span className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      aria-pressed={attachContext}
                      onClick={() => setAttachContext((v) => !v)}
                      title="Send the page you're on (cluster, namespace, focused resource) with your question"
                      className={cn(
                        'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors',
                        attachContext ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'text-content-subtle hover:bg-surface-sunken hover:text-content',
                      )}
                    >
                      <IconPin /> Context
                    </button>
                    {SLASH.map((c) => (
                      <button
                        key={c.cmd}
                        type="button"
                        title={c.hint}
                        onClick={() => {
                          setInput((v) => (v.startsWith('/') ? v.replace(/^\/\w+\s*/, `${c.cmd} `) : `${c.cmd} ${v}`))
                          inputRef.current?.focus()
                        }}
                        className="hidden h-7 items-center rounded-md px-1.5 font-mono text-[10.5px] text-content-subtle transition-colors hover:bg-surface-sunken hover:text-content lg:inline-flex"
                      >
                        {c.cmd}
                      </button>
                    ))}
                  </span>
                </div>
              ) : null}
              <div className="flex items-end gap-2 rounded-xl bg-surface-app px-3 py-2">
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
                  placeholder={state.configured ? `Ask ${agent?.name ?? 'Adhar'} anything, or type a page name to jump there…` : 'Search pages, apps and settings…'}
                  aria-label="Message Adhar AI"
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
                  ['agent', 'Agent'],
                  ['history', 'History'],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" onClick={() => setRail(id)} className={cn('relative h-7 flex-1 rounded-md text-[11.5px] font-medium transition-colors', rail === id ? 'bg-surface-raised text-content shadow-sm ring-1 ring-edge-default' : 'text-content-muted hover:text-content')}>
                  {label}
                  {id === 'agent' && state.busy && rail !== 'agent' ? <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" /> : null}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {rail === 'navigate' ? (
                <NavRail results={navResults} query={navQuery} active={activeNav} onHover={setActiveNav} onPick={runItem} all={allItems} />
              ) : rail === 'agent' ? (
                <AgentRail />
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

function Welcome({
  configured,
  starters,
  onPick,
  navHint,
  agentName,
}: {
  configured: boolean
  starters: Array<{ label: string; prompt: string }>
  onPick(prompt: string): void
  navHint?: CommandItem
  agentName?: string
}) {
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
              <button key={n.id} type="button" onClick={() => { notif.markRead(n.id); onPick(n.prompt!) }} className="group flex w-full items-center gap-2 rounded-lg bg-surface-raised px-2.5 py-1.5 text-left ring-1 ring-edge-subtle transition-colors hover:ring-violet-300">
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
      <h2 className="mt-4 text-xl font-semibold tracking-tight text-content">
        {configured && agentName ? `${agentName} agent — how can I help?` : 'How can I help?'}
      </h2>
      <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-content-muted">
        {configured
          ? 'I read your cluster, Argo CD, policies and events with your permissions, show what I find as live components, and propose changes you approve — nothing is applied on its own.'
          : 'AI isn’t configured on this cluster yet (set AI_BASE_URL / AI_MODEL). Meanwhile, type any page, app or setting to jump straight to it.'}
      </p>
      {configured ? (
        <div className="mt-6 grid w-full gap-2 sm:grid-cols-2">
          {starters.map((s) => (
            <button key={s.label} type="button" onClick={() => onPick(s.prompt)} className="group rounded-xl border border-edge-default bg-surface-raised p-3 text-left transition-colors hover:border-brand-300 hover:bg-brand-50/40 dark:hover:border-brand-500/40 dark:hover:bg-brand-500/5">
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

/* ─────────── transcript ─────────── */

function EntryView({ entry }: { entry: ChatEntry }) {
  const [copied, setCopied] = useState(false)
  if (entry.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-brand-600 px-4 py-2.5 text-[13.5px] leading-relaxed text-white shadow-sm">
          <div className="whitespace-pre-wrap">{entry.content}</div>
        </div>
      </div>
    )
  }
  const done = entry.toolCalls.filter((t) => t.status !== 'running').length
  return (
    <div className="flex gap-3">
      <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-brand-500 to-accent-500 text-white"><SparkIcon size={13} /></span>
      <div className="min-w-0 flex-1 space-y-2">
        {entry.toolCalls.length ? (
          <div className="flex flex-wrap gap-1.5">
            {entry.toolCalls.map((t) => <ToolChip key={t.id} call={t} />)}
          </div>
        ) : null}

        {entry.content ? (
          <div className="group relative rounded-2xl rounded-tl-md bg-surface-raised px-4 py-3 text-[13.5px] leading-relaxed text-content ring-1 ring-edge-subtle">
            <Markdown text={entry.content} />
            {entry.streaming ? <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-brand-400 align-middle" /> : null}
            {!entry.streaming ? (
              <button
                type="button"
                onClick={() => { void navigator.clipboard?.writeText(entry.content); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
                className="absolute right-2 top-2 rounded-md bg-surface-raised px-1.5 py-0.5 text-[10.5px] text-content-subtle opacity-0 ring-1 ring-edge-default transition-opacity hover:text-content group-hover:opacity-100"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            ) : null}
          </div>
        ) : entry.streaming && !entry.toolCalls.length ? (
          <div className="flex items-center gap-2 py-2 text-[13px] text-content-subtle"><Dots /> thinking…</div>
        ) : null}

        {/* Generative UI — components the agent chose, in arrival order. */}
        {entry.ui.map((block) => <GenerativeBlock key={block.id} block={block} />)}

        {entry.error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-300">{entry.error}</div>
        ) : null}

        {entry.toolCalls.length > 3 && !entry.streaming ? (
          <div className="text-[10.5px] text-content-subtle">{done} of {entry.toolCalls.length} tool calls completed</div>
        ) : null}
      </div>
    </div>
  )
}

function ToolChip({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false)
  const failed = call.status === 'error'
  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
          failed
            ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300'
            : call.status === 'running'
              ? 'border-brand-200 bg-brand-50 text-brand-700 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300'
              : 'border-edge-subtle bg-surface-sunken text-content-muted hover:text-content',
        )}
        title="Show the arguments and result"
      >
        {call.status === 'running' ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> : <IconTool />}
        {toolLabel(call.name, safeArgs(call.args))}
      </button>
      {open ? (
        <span className="mt-1 block max-w-md overflow-auto rounded-lg bg-slate-950 p-2 font-mono text-[10px] leading-relaxed text-slate-100">
          <span className="block text-slate-400">args</span>
          <span className="block whitespace-pre-wrap">{pretty(call.args)}</span>
          {call.result ? (
            <>
              <span className="mt-1 block text-slate-400">result</span>
              <span className="block max-h-40 overflow-auto whitespace-pre-wrap">{pretty(call.result).slice(0, 4000)}</span>
            </>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}

function safeArgs(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || '{}')
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function pretty(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

/** What the agent is doing right now, from its shared state. */
function Thinking({ run }: { run: ReturnType<typeof useAssist>['run'] }) {
  const active = run?.plan?.find((s) => s.status === 'active')
  const label = active ? active.label : run?.tools?.last ? `running ${run.tools.last}` : run?.phase === 'planning' ? 'planning' : 'thinking'
  return (
    <div className="flex items-center gap-2 pl-10 text-[12.5px] text-content-subtle"><Dots /> {label}…</div>
  )
}

/** Human-in-the-loop: the agent stopped to ask the operator something. */
function AskCard() {
  const { pendingAsk } = useAssist()
  const [text, setText] = useState('')
  if (!pendingAsk) return null
  return (
    <div className="ml-10 rounded-xl border border-sky-200 bg-sky-50/70 p-3 dark:border-sky-500/30 dark:bg-sky-500/10">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-sky-700 dark:text-sky-300">The agent needs your decision</div>
      <p className="mt-1 text-[13px] text-content">{pendingAsk.question}</p>
      {pendingAsk.options.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {pendingAsk.options.map((o) => (
            <button key={o} type="button" onClick={() => assistStore.answerAsk(o)} className="rounded-md border border-sky-300 bg-surface-raised px-2.5 py-1 text-[12px] font-medium text-sky-800 hover:bg-sky-100 dark:border-sky-500/40 dark:text-sky-200 dark:hover:bg-sky-500/10">
              {o}
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-2 flex gap-1.5">
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) assistStore.answerAsk(text.trim()) }}
            placeholder="Your answer…"
            className="h-8 flex-1 rounded-md border border-edge-default bg-surface-raised px-2 text-[12.5px] text-content focus:border-sky-400 focus:outline-none"
          />
          <button type="button" disabled={!text.trim()} onClick={() => assistStore.answerAsk(text.trim())} className="h-8 rounded-md bg-sky-600 px-2.5 text-[12px] font-semibold text-white hover:bg-sky-700 disabled:opacity-40">
            Answer
          </button>
        </div>
      )}
    </div>
  )
}

/* ─────────── agent workspace rail ─────────── */

const SEVERITY_DOT: Record<Finding['severity'], string> = {
  critical: 'bg-rose-500',
  warning: 'bg-amber-500',
  info: 'bg-sky-500',
  ok: 'bg-emerald-500',
}

function AgentRail() {
  const { run, agents, agentId, busy } = useAssist()
  const agent = agents.find((a) => a.id === agentId)
  if (!run && !busy) {
    return (
      <div className="space-y-2 px-1 py-2">
        {agent ? (
          <div className="rounded-lg border border-edge-subtle bg-surface-raised p-2.5">
            <div className="text-[12.5px] font-semibold text-content">{agent.name}</div>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-content-muted">{agent.description}</p>
            <div className="mt-1.5 text-[10.5px] text-content-subtle">{agent.tools} tools · reads with your RBAC</div>
          </div>
        ) : null}
        <p className="px-1 text-[11.5px] text-content-subtle">
          While an agent works, its plan and findings appear here.
        </p>
      </div>
    )
  }
  const plan = run?.plan ?? []
  const findings = run?.findings ?? []
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
        <span>{run?.agent?.name ?? agent?.name ?? 'Agent'}</span>
        <span className={cn(run?.phase === 'error' ? 'text-rose-600 dark:text-rose-400' : run?.phase === 'done' ? 'text-emerald-600 dark:text-emerald-400' : 'text-brand-600 dark:text-brand-400')}>
          {run?.phase ?? (busy ? 'working' : 'idle')}
        </span>
      </div>

      {plan.length ? (
        <div>
          <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">Plan</div>
          <ol className="space-y-1">
            {plan.map((s) => <PlanRow key={s.id} step={s} />)}
          </ol>
        </div>
      ) : null}

      {findings.length ? (
        <div>
          <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">Findings · {findings.length}</div>
          <ul className="space-y-1">
            {findings.map((f) => (
              <li key={f.id} className="rounded-lg border border-edge-subtle bg-surface-raised p-2">
                <div className="flex items-start gap-1.5">
                  <span className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', SEVERITY_DOT[f.severity] ?? 'bg-slate-400')} />
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium leading-snug text-content">{f.title}</div>
                    {f.detail ? <div className="mt-0.5 line-clamp-3 text-[11px] leading-relaxed text-content-muted">{f.detail}</div> : null}
                    {f.resource?.name ? (
                      <div className="mt-0.5 truncate font-mono text-[10px] text-content-subtle">
                        {f.resource.kind}/{f.resource.name}{f.resource.namespace ? ` · ${f.resource.namespace}` : ''}
                      </div>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {run?.tools?.called ? (
        <div className="px-1 text-[10.5px] text-content-subtle">
          {run.tools.called} tool call{run.tools.called === 1 ? '' : 's'}{run.tools.last ? ` · last: ${run.tools.last}` : ''}
        </div>
      ) : null}
    </div>
  )
}

function PlanRow({ step }: { step: PlanStep }) {
  const icon =
    step.status === 'done' ? '✓' : step.status === 'failed' ? '✕' : step.status === 'active' ? '' : '○'
  return (
    <li className="flex items-start gap-1.5 px-1 text-[12px]">
      <span
        className={cn(
          'mt-px w-3 shrink-0 text-center font-semibold',
          step.status === 'done' ? 'text-emerald-600 dark:text-emerald-400' : step.status === 'failed' ? 'text-rose-600 dark:text-rose-400' : 'text-content-subtle',
        )}
        aria-hidden
      >
        {step.status === 'active' ? <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" /> : icon}
      </span>
      <span className={cn('min-w-0 leading-snug', step.status === 'done' ? 'text-content-muted line-through decoration-content-subtle/40' : step.status === 'active' ? 'font-medium text-content' : 'text-content-muted')}>
        {step.label}
      </span>
    </li>
  )
}

function toolLabel(name: string, args: Record<string, unknown>): string {
  const a = args as Record<string, string>
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
    case 'update_plan': return 'update plan'
    case 'record_finding': return `finding: ${String(a.title ?? '').slice(0, 40)}`
    case 'render_ui': return `render ${a.component ?? 'ui'}`
    case 'navigate_to': return `open ${a.path ?? ''}`
    case 'open_resource': return `open ${a.kind ?? ''}/${a.name ?? ''}`
    case 'ask_operator': return 'ask the operator'
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
            <button type="button" onClick={() => assistStore.openThread(c.id)} className={cn('min-w-0 flex-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-sunken', state.thread.id === c.id ? 'bg-brand-50 dark:bg-brand-500/10' : '')}>
              <div className="truncate text-[12.5px] font-medium text-content">{c.title}</div>
              <div className="truncate text-[10.5px] text-content-subtle">{c.messages.length} messages · {relTime(c.updatedAt)}</div>
            </button>
            <button type="button" onClick={() => assistStore.deleteThread(c.id)} aria-label="Delete conversation" className="rounded p-1 text-content-subtle opacity-0 hover:bg-surface-sunken hover:text-rose-600 group-hover:opacity-100"><IconTrash /></button>
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
const IconPin = () => <I size={12}><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></I>
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
