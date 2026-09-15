import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@adhar-console/utils'
import { assistStore, useAssist, type UiBlock } from '../agui/store.ts'
import { GenerativeBlock } from '../agui/generative.tsx'
import { useSelection } from '../selection-store.ts'
import { DEFAULT_NAV, type NavSection } from '../nav-tree.tsx'
import { Composer, type ContextChip, type SlashCommand } from './composer.tsx'
import { Inspector, type InspectorTab } from './inspector.tsx'
import { ThreadsRail } from './threads.tsx'
import { Transcript } from './transcript.tsx'
import { Welcome } from './welcome.tsx'
import { filterItems, flattenNav, looksLikeNavigation, type CommandItem } from './nav.ts'
import { IconCanvas, IconExpand, IconKeyboard, IconPanelRight, IconShrink, IconSidebar, IconX, SparkIcon } from './icons.tsx'

/**
 * Adhar AI — the surface.
 *
 * A workspace, not a chat box: conversations on the left, the conversation
 * in the middle, and on the right everything about it that is not prose —
 * the live run, the knowledge it draws on, the tools it really has, the
 * visuals it produced, and the console's own pages. Both side rails collapse
 * and the choice is remembered, so on a laptop it is a focused chat and on a
 * wide screen it is a cockpit.
 *
 * Router-free by design: navigation is a callback the host supplies, which is
 * what lets the whole surface render in a harness with no router and no
 * server behind it.
 */
export interface AssistSurfaceProps {
  onClose(): void
  onNavigate(to: string, search?: Record<string, unknown>): void
  items?: CommandItem[]
  sections?: NavSection[]
}

const LAYOUT_KEY = 'adhar.assist.layout.v1'

interface Layout {
  threads: boolean
  inspector: boolean
  /** Edge to edge, no margins — the surface as an app of its own. */
  full: boolean
}

function loadLayout(): Layout {
  try {
    const raw = globalThis.localStorage?.getItem(LAYOUT_KEY)
    if (raw) return { threads: true, inspector: true, full: false, ...(JSON.parse(raw) as object) }
  } catch { /* fall through */ }
  return { threads: true, inspector: true, full: false }
}

const SHORTCUTS: Array<[string, string]> = [
  ['⏎', 'Send'],
  ['⇧⏎', 'New line'],
  ['⌘⏎', 'Open the matched page'],
  ['/', 'Commands'],
  ['@', 'Switch agent'],
  ['⌘⇧O', 'New conversation'],
  ['⌘⇧F', 'Fullscreen'],
  ['⌘[', 'Toggle conversations'],
  ['⌘]', 'Toggle inspector'],
  ['⌘/', 'Focus the composer'],
  ['Esc', 'Close'],
]

export function AssistSurface({ onClose, onNavigate, items, sections = DEFAULT_NAV }: AssistSurfaceProps) {
  const state = useAssist()
  const selection = useSelection()
  const [input, setInput] = useState('')
  const [layout, setLayout] = useState(loadLayout)
  const [tab, setTab] = useState<InspectorTab>('run')
  const [canvas, setCanvas] = useState(false)
  const [attachContext, setAttachContext] = useState(true)
  const [activeNav, setActiveNav] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  useEffect(() => {
    try { globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify(layout)) } catch { /* ignore */ }
  }, [layout])

  // The agent to show for THIS conversation. A thread remembers who answered
  // it; the switcher's selection only applies once there is a new thread to
  // apply it to — otherwise reopening an old Delivery thread would relabel
  // every turn as whichever agent is currently selected.
  const threadAgentId = state.thread.messages.length ? state.thread.agentId || state.agentId : state.agentId
  const agent = state.agents.find((a) => a.id === threadAgentId) ?? state.agents.find((a) => a.id === state.agentId)
  const allItems = useMemo<CommandItem[]>(() => (items && items.length ? items : flattenNav(sections)), [items, sections])
  const navQuery = input.startsWith('/go ') ? input.slice(4) : input.startsWith('/') || input.startsWith('@') ? '' : input
  const navResults = useMemo(() => filterItems(allItems, navQuery).slice(0, 12), [allItems, navQuery])
  const navHint = navResults[activeNav] ?? navResults[0]
  const page = typeof location !== 'undefined' ? location.pathname : ''
  const pageItem = useMemo(() => allItems.find((i) => i.to && page.startsWith(i.to) && i.to !== '/') ?? allItems.find((i) => i.to === page), [allItems, page])

  useEffect(() => setActiveNav(0), [navQuery])

  // Typing a page name promotes the navigate lane; a question leaves the
  // inspector where it was. Both are derived from the input, not toggled.
  useEffect(() => {
    if (navQuery.trim() && (input.startsWith('/go ') || looksLikeNavigation(navQuery, navHint?.label) || !state.configured)) setTab('navigate')
    else if (tab === 'navigate' && !navQuery.trim()) setTab('run')
  }, [navQuery, input, navHint?.label, state.configured]) // eslint-disable-line react-hooks/exhaustive-deps

  // A run underway or a question pending is worth showing.
  useEffect(() => {
    if (state.busy || state.pendingAsk) setTab('run')
  }, [state.busy, state.pendingAsk])

  // Asking something new means you want the answer, not the board.
  useEffect(() => {
    if (state.busy) setCanvas(false)
  }, [state.busy])

  useLayoutEffect(() => {
    if (canvas) return
    const el = threadRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [state.thread.messages, state.run, canvas])

  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [state.thread.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      if ((e.metaKey || e.ctrlKey) && e.key === '/') { e.preventDefault(); inputRef.current?.focus() }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); assistStore.newThread(); setInput('') }
      if ((e.metaKey || e.ctrlKey) && e.key === '[') { e.preventDefault(); setLayout((l) => ({ ...l, threads: !l.threads })) }
      if ((e.metaKey || e.ctrlKey) && e.key === ']') { e.preventDefault(); setLayout((l) => ({ ...l, inspector: !l.inspector })) }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setLayout((l) => ({ ...l, full: !l.full })) }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])

  const canvasBlocks = useMemo<UiBlock[]>(
    () => state.thread.messages.flatMap((m) => m.ui).filter((b) => b.component !== 'proposal').reverse(),
    [state.thread.messages],
  )

  const runItem = useCallback((item: CommandItem) => {
    if (item.onSelect) item.onSelect()
    else if (item.to) onNavigate(item.to, item.search)
    onClose()
  }, [onNavigate, onClose])

  const send = (text: string) => {
    if (!text.trim() || state.busy) return
    stickToBottom.current = true
    if (!attachContext) assistStore.setContext(undefined)
    assistStore.send(text)
  }

  const commands: SlashCommand[] = useMemo(() => [
    { cmd: '/new', hint: 'Start a fresh conversation', run: () => { assistStore.newThread() } },
    { cmd: '/go', hint: 'Jump to a page — /go pods', run: (rest) => `/go ${rest}` },
    { cmd: '/agent', hint: 'Switch agent — /agent delivery', run: (rest) => {
      const hit = state.agents.find((a) => a.id === rest.trim() || a.name.toLowerCase().startsWith(rest.trim().toLowerCase()))
      if (hit) assistStore.setAgent(hit.id)
      else return '@'
    } },
    { cmd: '/knowledge', hint: 'Search what the platform knows — /knowledge gateway', run: (rest) => { setLayout((l) => ({ ...l, inspector: true })); setTab('knowledge'); void assistStore.searchKnowledge(rest) } },
    { cmd: '/canvas', hint: 'Lay out every visual from this conversation', run: () => { if (canvasBlocks.length) setCanvas(true) } },
    { cmd: '/tools', hint: 'What the runtime can actually do', run: () => { setLayout((l) => ({ ...l, inspector: true })); setTab('tools') } },
    { cmd: '/readonly', hint: 'Autonomy: investigate only', run: () => assistStore.setAutonomy('read-only') },
    { cmd: '/suggest', hint: 'Autonomy: describe the change it would make', run: () => assistStore.setAutonomy('suggest') },
    { cmd: '/propose', hint: 'Autonomy: open a pull request for review', run: () => assistStore.setAutonomy('approve-to-apply') },
  ], [state.agents, canvasBlocks.length])

  const submit = () => {
    const text = input.trim()
    if (!text) return
    if (text.startsWith('/go')) { if (navHint) runItem(navHint); return }
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.split(/\s+/)
      const hit = commands.find((c) => c.cmd === cmd)
      if (hit) { const left = hit.run(rest.join(' ')); setInput(typeof left === 'string' ? left : ''); return }
    }
    if (!state.configured) { if (navHint) runItem(navHint); return }
    setInput('')
    send(text)
  }

  const chips: ContextChip[] = [
    pageItem ? { key: 'page', label: 'page', value: pageItem.label } : null,
    { key: 'cluster', label: 'cluster', value: selection.cluster || 'local' },
    { key: 'namespace', label: 'namespace', value: selection.namespace || 'all' },
    state.context?.name ? { key: 'resource', label: state.context.kind ?? state.context.resource, value: state.context.name } : null,
  ].filter(Boolean) as ContextChip[]

  const hasThread = state.thread.messages.length > 0
  const runtime = state.runtime
  const runtimeLine = runtime?.configured && runtime.reachable
    ? `${runtime.mcp?.connected.length ?? 0} MCP servers · ${runtime.tools?.length ?? 0} tools${runtime.rag ? ` · knowledge ${runtime.rag}` : ''}`
    : state.model ?? ''

  return (
    <div role="dialog" aria-modal="true" aria-label="Adhar AI" className={cn('fixed inset-0 z-[70] flex items-center justify-center', layout.full ? 'p-0' : 'p-2 sm:p-4')}>
      <div className="fade-in absolute inset-0 bg-scrim/45 backdrop-blur-[3px]" onClick={onClose} aria-hidden />
      <div
        className={cn(
          'pop-in relative flex w-full flex-col overflow-hidden bg-surface-app transition-[border-radius] duration-200',
          layout.full
            ? 'h-full max-w-none rounded-none'
            : 'h-[94vh] max-w-[1500px] rounded-2xl border border-edge-default shadow-[0_48px_96px_-24px_rgba(15,23,42,0.55)]',
        )}
      >
        {/* ═══ header ═══ */}
        <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-edge-subtle bg-surface-raised/80 px-3.5 backdrop-blur">
          <IconToggle on={layout.threads} onClick={() => setLayout((l) => ({ ...l, threads: !l.threads }))} title="Toggle conversations (⌘[)"><IconSidebar /></IconToggle>
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-linear-to-br from-brand-500 to-accent-500 text-white shadow-sm">
            <SparkIcon size={15} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[14px] font-semibold tracking-tight text-content">
              Adhar AI
              {state.configured ? <span className="rounded bg-surface-sunken px-1 py-px font-mono text-[9px] font-medium uppercase tracking-wider text-content-subtle">AG-UI</span> : null}
              {runtime?.configured ? (
                <span className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[9.5px] font-medium', runtime.reachable ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300')}>
                  <span className={cn('h-1.5 w-1.5 rounded-full', runtime.reachable ? 'bg-emerald-500' : 'bg-rose-500')} /> runtime
                </span>
              ) : null}
            </div>
            <div className="truncate text-[11px] text-content-subtle">
              {state.configured ? runtimeLine || 'reads with your RBAC · changes become pull requests' : 'AI not configured — search & navigate still work'}
            </div>
          </div>

          <div className="ml-auto flex items-center gap-1">
            {canvasBlocks.length ? (
              <HeaderBtn onClick={() => setCanvas((v) => !v)} title={canvas ? 'Back to the conversation' : `Lay out all ${canvasBlocks.length} visuals side by side`} active={canvas}>
                <IconCanvas /> Canvas <span className="tabular-nums opacity-60">{canvasBlocks.length}</span>
              </HeaderBtn>
            ) : null}
            {/* "New" left the header: it lives in the conversations rail and on
                ⌘⇧O, and a top bar earns its slots with controls that change
                the SURFACE, not the thread. */}
            <IconToggle on={layout.inspector} onClick={() => setLayout((l) => ({ ...l, inspector: !l.inspector }))} title="Toggle inspector (⌘])"><IconPanelRight /></IconToggle>
            <IconToggle on={layout.full} onClick={() => setLayout((l) => ({ ...l, full: !l.full }))} title={layout.full ? 'Exit fullscreen (⌘⇧F)' : 'Fullscreen (⌘⇧F)'}>
              {layout.full ? <IconShrink /> : <IconExpand />}
            </IconToggle>
            <ShortcutsMenu />
            <button type="button" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)" className="ml-0.5 flex h-8 w-8 items-center justify-center rounded-lg text-content-subtle transition-colors hover:bg-surface-sunken hover:text-content"><IconX /></button>
          </div>
        </header>

        {/* ═══ body ═══ */}
        <div
          className="grid min-h-0 flex-1"
          style={{ gridTemplateColumns: `${layout.threads ? '256px' : '0px'} minmax(0,1fr) ${layout.inspector ? '340px' : '0px'}` }}
        >
          <div className={cn('min-h-0 overflow-hidden transition-[width]', !layout.threads && 'hidden')}>
            <ThreadsRail />
          </div>

          <section className="flex min-h-0 flex-col">
            <div
              ref={threadRef}
              onScroll={(e) => { const el = e.currentTarget; stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48 }}
              className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-8"
            >
              {canvas && canvasBlocks.length ? (
                <CanvasBoard blocks={canvasBlocks} />
              ) : !hasThread ? (
                <Welcome
                  configured={state.configured}
                  agent={agent}
                  agents={state.agents}
                  onPick={(p) => send(p)}
                  onAgent={(id) => assistStore.setAgent(id)}
                  navHint={navHint}
                  findings={state.operatorFindings}
                  runtime={runtime}
                />
              ) : (
                <Transcript
                  messages={state.thread.messages}
                  busy={state.busy}
                  run={state.run}
                  agentName={agent?.name}
                  accent={agent?.accent}
                  onAsk={(text) => { setInput(text); inputRef.current?.focus() }}
                  onCanvas={() => setCanvas(true)}
                  onSend={(text) => send(text)}
                />
              )}
            </div>

            <Composer
              value={input}
              onChange={setInput}
              onSubmit={submit}
              onStop={() => assistStore.stop()}
              busy={state.busy}
              configured={state.configured}
              agents={state.agents}
              agentId={state.agentId}
              onAgent={(id) => assistStore.setAgent(id)}
              autonomy={state.autonomy}
              onAutonomy={(a) => assistStore.setAutonomy(a)}
              chips={chips}
              attachContext={attachContext}
              onToggleContext={() => setAttachContext((v) => !v)}
              navHint={navQuery.trim() ? navHint : undefined}
              onOpenNavHint={() => { if (navHint) runItem(navHint) }}
              commands={commands}
              inputRef={inputRef}
              onArrow={(dir) => setActiveNav((i) => Math.max(0, Math.min(navResults.length - 1, i + dir)))}
            />
          </section>

          <div className={cn('min-h-0 overflow-hidden', !layout.inspector && 'hidden')}>
            <Inspector
              tab={tab}
              onTab={setTab}
              nav={{ results: navResults, query: navQuery, active: activeNav, all: allItems, onHover: setActiveNav, onPick: runItem }}
              canvasBlocks={canvasBlocks}
              onAskAbout={(text) => { setInput(text); inputRef.current?.focus() }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Every visual in the thread, laid out as a board. The transcript is the
 * right place to READ an answer and the wrong place to COMPARE two of them —
 * by the third chart the first has scrolled away. Same blocks, same fidelity,
 * newest first.
 */
function CanvasBoard({ blocks }: { blocks: UiBlock[] }) {
  const WIDE = new Set(['topology', 'diff', 'time-series', 'table', 'log-viewer', 'heatmap', 'events-scan'])
  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-3 flex items-baseline justify-between px-0.5">
        <h2 className="text-[13px] font-semibold text-content">Canvas</h2>
        <span className="text-[11px] text-content-subtle">{blocks.length} visual{blocks.length === 1 ? '' : 's'} from this conversation</span>
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {blocks.map((b) => (
          <div key={b.id} className={cn('min-w-0', WIDE.has(b.component) ? 'lg:col-span-2' : '')}>
            <GenerativeBlock block={b} />
          </div>
        ))}
      </div>
    </div>
  )
}

function IconToggle({ on, onClick, title, children }: { on: boolean; onClick(): void; title: string; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title} aria-pressed={on} className={cn('flex h-8 w-8 items-center justify-center rounded-lg transition-colors', on ? 'text-content hover:bg-surface-sunken' : 'text-content-subtle hover:bg-surface-sunken hover:text-content')}>
      {children}
    </button>
  )
}

/** Every key the surface understands, one click away — discoverable, not memorised. */
function ShortcutsMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey, true) }
  }, [open])
  return (
    <div ref={ref} className="relative">
      <IconToggle on={open} onClick={() => setOpen((o) => !o)} title="Keyboard shortcuts"><IconKeyboard /></IconToggle>
      {open ? (
        <div className="pop-in absolute right-0 top-full z-30 mt-1.5 w-64 overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-xl shadow-black/10">
          <div className="border-b border-edge-subtle px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Shortcuts</div>
          <ul className="p-1.5">
            {SHORTCUTS.map(([k, what]) => (
              <li key={k} className="flex items-center justify-between gap-3 rounded-md px-1.5 py-1 text-[12px]">
                <span className="text-content-muted">{what}</span>
                <kbd className="rounded border border-edge-default bg-surface-sunken px-1.5 py-px font-mono text-[10.5px] text-content">{k}</kbd>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function HeaderBtn({ children, onClick, title, active = false }: { children: React.ReactNode; onClick(): void; title: string; active?: boolean }) {
  return (
    <button type="button" onClick={onClick} title={title} className={cn('inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors', active ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300' : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong hover:text-content')}>
      {children}
    </button>
  )
}
