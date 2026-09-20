import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { cn } from '@adhar-console/utils'
import { assistStore, useAssist, type UiBlock } from '../agui/store.ts'
import { GenerativeBlock } from '../agui/generative.tsx'
import { useSelection } from '../selection-store.ts'
import { DEFAULT_NAV, type NavSection } from '../nav-tree.tsx'
import { useElementWidth } from '../use-element-size.ts'
import { useMediaQuery } from '../use-media-query.ts'
import { Composer, type ContextChip, type SlashCommand } from './composer.tsx'
import { Inspector, type InspectorTab } from './inspector.tsx'
import { ThreadsRail } from './threads.tsx'
import { Transcript } from './transcript.tsx'
import { Welcome } from './welcome.tsx'
import { filterItems, flattenNav, looksLikeNavigation, type CommandItem } from './nav.ts'
import { IconCanvas, IconExpand, IconKeyboard, IconPanelRight, IconShrink, IconSidebar, IconX } from './icons.tsx'
import { AdharAiMark } from './mark.tsx'

/**
 * Adhar AI — the surface.
 *
 * A workspace, not a chat box: conversations on the left, the conversation
 * in the middle, and on the right everything about it that is not prose —
 * the live run, the knowledge it draws on, the tools it really has, the
 * visuals it produced, and the console's own pages.
 *
 * It renders in two places from one component:
 *   • `overlay` — the ⌘K palette, a modal over whatever page you were on;
 *   • `page`    — /ai, a first-class page that fills the console frame.
 *
 * And in as many shapes as it has room for. The rails are columns when they
 * FIT and slide-over sheets when they do not, and "fit" is measured on this
 * component's own width — not the window's. The distinction is the whole
 * point: the shell's sidebar is 256px open and 64px collapsed, so the same
 * 1024px window gives this surface either 768px or 960px. Keyed to the
 * viewport it claimed three columns at 768px and rendered the conversation at
 * 172px, and collapsing the sidebar was the only way to get it back — which
 * is what "collapsing breaks the layout" looked like from the outside.
 *
 * So: a rail becomes a column only while the conversation keeps
 * `MIN_CONVERSATION`, the inspector yielding last because a live run is what
 * you watch. Below that everything is a sheet and the composer pins to the
 * bottom above the home indicator. Same store, same components, and no
 * arrangement in which the conversation is a gutter.
 *
 * Router-free by design: navigation is a callback the host supplies, which is
 * what lets the whole surface render in a harness with no router and no
 * server behind it.
 */
export interface AssistSurfaceProps {
  variant?: 'overlay' | 'page'
  /** Overlay: close it. Page: leave it (the host decides where to). */
  onClose?(): void
  onNavigate(to: string, search?: Record<string, unknown>): void
  items?: CommandItem[]
  sections?: NavSection[]
}

/*
 * v2 because the DEFAULT changed, and v1 cannot be migrated.
 *
 * The layout is written to storage by an effect on every change — including
 * the very first render — so every existing user has `{threads:true,
 * inspector:true}` stored whether or not they ever touched a toggle. There is
 * no way to tell a preference from a default that got persisted, so keeping
 * the old key would leave both rails open for everyone forever and the new
 * default would only ever apply to brand-new browsers. A new key forgets the
 * ambiguity once; anything set deliberately after this is honoured.
 */
const LAYOUT_KEY = 'adhar.assist.layout.v2'

interface Layout {
  threads: boolean
  inspector: boolean
  /** Edge to edge, no margins — the overlay as an app of its own. */
  full: boolean
}

/**
 * Both rails start closed.
 *
 * The conversation is self-sufficient: the live run renders inline as the
 * working card, and a question the agent puts to you renders inline as the
 * ask card. Nothing that blocks you lives only in a rail. So the rails are
 * genuinely supplementary — history you might want, and detail you might
 * want — and opening with both is three columns of chrome around the thing
 * you actually came to do.
 *
 * They are one keystroke away (⌘[ and ⌘]) and one click away in the header,
 * and the choice sticks once made.
 */
const CLOSED: Layout = { threads: false, inspector: false, full: false }

function loadLayout(): Layout {
  try {
    const raw = globalThis.localStorage?.getItem(LAYOUT_KEY)
    if (raw) return { ...CLOSED, ...(JSON.parse(raw) as object) }
  } catch { /* fall through */ }
  return CLOSED
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

/** Rail widths, and the floor below which the conversation stops being one. */
const RAIL_THREADS = 256
const RAIL_INSPECTOR = 340
const MIN_CONVERSATION = 420

export function AssistSurface({ variant = 'overlay', onClose, onNavigate, items, sections = DEFAULT_NAV }: AssistSurfaceProps) {
  const state = useAssist()
  const selection = useSelection()
  const frameRef = useRef<HTMLDivElement>(null)
  const frameWidth = useElementWidth(frameRef)
  /*
   * Is this a phone? A VIEWPORT question, deliberately — it decides whether the
   * overlay goes edge to edge, and the overlay's own width is what the frame
   * measurement then reports. Deriving it from the frame would be circular:
   * narrow → edge-to-edge → wide → windowed → narrow.
   */
  const phone = !useMediaQuery('(min-width: 640px)')

  /*
   * What fits. Before the first measurement `frameWidth` is 0 — treat that as
   * the narrow case so the server and first paint agree, then settle.
   */
  const fits = useMemo(() => {
    const w = frameWidth || 0
    if (w === 0) return { threads: false, inspector: false }
    const inspector = w - RAIL_INSPECTOR >= MIN_CONVERSATION
    const threads = inspector && w - RAIL_INSPECTOR - RAIL_THREADS >= MIN_CONVERSATION
    return { threads, inspector }
  }, [frameWidth])
  const [input, setInput] = useState('')
  const [layout, setLayout] = useState(loadLayout)
  // On a phone the rails are sheets: closed by default, never remembered —
  // a sheet that reopens itself on every visit is a modal you did not ask for.
  const [sheet, setSheet] = useState<'threads' | 'inspector' | null>(null)
  const [tab, setTab] = useState<InspectorTab>('run')
  const [canvas, setCanvas] = useState(false)
  const [attachContext, setAttachContext] = useState(true)
  const [activeNav, setActiveNav] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const overlay = variant === 'overlay'

  useEffect(() => {
    try { globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify(layout)) } catch { /* ignore */ }
  }, [layout])

  // The agent to show for THIS conversation. A thread remembers who answered
  // it; the switcher's selection only applies once there is a new thread to
  // apply it to.
  const threadAgentId = state.thread.messages.length ? state.thread.agentId || state.agentId : state.agentId
  const agent = state.agents.find((a) => a.id === threadAgentId) ?? state.agents.find((a) => a.id === state.agentId)
  const allItems = useMemo<CommandItem[]>(() => (items && items.length ? items : flattenNav(sections)), [items, sections])
  const navQuery = input.startsWith('/go ') ? input.slice(4) : input.startsWith('/') || input.startsWith('@') ? '' : input
  const navResults = useMemo(() => filterItems(allItems, navQuery).slice(0, 12), [allItems, navQuery])
  const navHint = navResults[activeNav] ?? navResults[0]
  const page = typeof location !== 'undefined' ? location.pathname : ''
  const pageItem = useMemo(() => allItems.find((i) => i.to && page.startsWith(i.to) && i.to !== '/' && i.to !== '/ai') ?? allItems.find((i) => i.to === page), [allItems, page])

  useEffect(() => setActiveNav(0), [navQuery])

  // Typing a page name promotes the navigate lane; a question leaves the
  // inspector where it was. Both are derived from the input, not toggled.
  useEffect(() => {
    if (navQuery.trim() && (input.startsWith('/go ') || looksLikeNavigation(navQuery, navHint?.label) || !state.configured)) setTab('navigate')
    else if (tab === 'navigate' && !navQuery.trim()) setTab('run')
  }, [navQuery, input, navHint?.label, state.configured]) // eslint-disable-line react-hooks/exhaustive-deps

  // A run underway or a question pending is worth showing — on a laptop. On a
  // phone the answer is what you are watching; the rail stays out of the way.
  useEffect(() => {
    if (state.busy || state.pendingAsk) setTab('run')
  }, [state.busy, state.pendingAsk])

  // Asking something new means you want the answer, not the board.
  useEffect(() => {
    if (state.busy) { setCanvas(false); setSheet(null) }
  }, [state.busy])

  useLayoutEffect(() => {
    if (canvas) return
    const el = threadRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [state.thread.messages, state.run, canvas])

  // Autofocus is a desktop courtesy; on a phone it summons the keyboard over
  // the conversation before anyone has read it.
  useEffect(() => {
    if (phone) return
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [state.thread.id, phone])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (sheet) { e.preventDefault(); setSheet(null); return }
        if (overlay && onClose) { e.preventDefault(); onClose() }
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '/') { e.preventDefault(); inputRef.current?.focus() }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); assistStore.newThread(); setInput('') }
      if ((e.metaKey || e.ctrlKey) && e.key === '[') { e.preventDefault(); toggleRail('threads') }
      if ((e.metaKey || e.ctrlKey) && e.key === ']') { e.preventDefault(); toggleRail('inspector') }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f' && overlay) { e.preventDefault(); setLayout((l) => ({ ...l, full: !l.full })) }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }) // deliberately unmemoised: closes over the latest `sheet`, `fits`, `overlay`

  /** A rail is a column only when the operator wants it AND it fits. */
  const asColumn = (rail: 'threads' | 'inspector') => fits[rail] && layout[rail]
  const toggleRail = (rail: 'threads' | 'inspector') => {
    if (fits[rail]) setLayout((l) => ({ ...l, [rail]: !l[rail] }))
    else setSheet((s) => (s === rail ? null : rail))
  }
  const railOn = (rail: 'threads' | 'inspector') => (fits[rail] ? layout[rail] : sheet === rail)

  const canvasBlocks = useMemo<UiBlock[]>(
    () => state.thread.messages.flatMap((m) => m.ui).filter((b) => b.component !== 'proposal').reverse(),
    [state.thread.messages],
  )

  const runItem = useCallback((item: CommandItem) => {
    if (item.onSelect) item.onSelect()
    else if (item.to) onNavigate(item.to, item.search)
    setSheet(null)
    if (overlay) onClose?.()
  }, [onNavigate, onClose, overlay])

  const send = (text: string) => {
    if (!text.trim() || state.busy) return
    stickToBottom.current = true
    if (!attachContext) assistStore.setContext(undefined)
    assistStore.send(text)
  }

  const openInspector = (t: InspectorTab) => {
    setTab(t)
    if (fits.inspector) setLayout((l) => ({ ...l, inspector: true }))
    else setSheet('inspector')
  }

  const commands: SlashCommand[] = useMemo(() => [
    { cmd: '/new', hint: 'Start a fresh conversation', run: () => { assistStore.newThread() } },
    { cmd: '/go', hint: 'Jump to a page — /go pods', run: (rest) => `/go ${rest}` },
    { cmd: '/agent', hint: 'Switch agent — /agent delivery', run: (rest) => {
      const hit = state.agents.find((a) => a.id === rest.trim() || a.name.toLowerCase().startsWith(rest.trim().toLowerCase()))
      if (hit) assistStore.setAgent(hit.id)
      else return '@'
    } },
    { cmd: '/knowledge', hint: 'Search what the platform knows — /knowledge gateway', run: (rest) => { openInspector('knowledge'); void assistStore.searchKnowledge(rest) } },
    { cmd: '/canvas', hint: 'Lay out every visual from this conversation', run: () => { if (canvasBlocks.length) setCanvas(true) } },
    { cmd: '/tools', hint: 'What the runtime can actually do', run: () => openInspector('tools') },
    { cmd: '/readonly', hint: 'Autonomy: investigate only', run: () => assistStore.setAutonomy('read-only') },
    { cmd: '/suggest', hint: 'Autonomy: describe the change it would make', run: () => assistStore.setAutonomy('suggest') },
    { cmd: '/propose', hint: 'Autonomy: open a pull request for review', run: () => assistStore.setAutonomy('approve-to-apply') },
  ], [state.agents, canvasBlocks.length, fits.inspector]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const askInComposer = (text: string) => { setInput(text); setSheet(null); inputRef.current?.focus() }

  const threadsRail = <ThreadsRail onPicked={() => setSheet(null)} />
  const inspector = (
    <Inspector
      tab={tab}
      onTab={setTab}
      nav={{ results: navResults, query: navQuery, active: activeNav, all: allItems, onHover: setActiveNav, onPick: runItem }}
      canvasBlocks={canvasBlocks}
      onAskAbout={askInComposer}
    />
  )

  const frame = (
    <>
      {/*
        ═══ header ═══

        OVERLAY ONLY. Launched over whatever the user was doing, the overlay
        has to say what it is and offer a way out, so it keeps the full
        identity block.

        The PAGE has no header at all. Reaching /ai from the sidebar already
        puts "Adhar AI" in the nav and in the breadcrumb, and the app's own
        topbar sits directly above — a third bar restating it was a frame
        around the conversation rather than part of it. The rail toggles it
        used to hold move into the body as floating controls (see RailPeek):
        they take no layout height, so the conversation starts at the top of
        the page, but the rails stay reachable by mouse and not only by
        ⌘[ / ⌘].
      */}
      {overlay ? (
      <header
        className={cn(
          'flex shrink-0 items-center gap-2 sm:gap-3',
          overlay
            ? 'h-[52px] border-b border-edge-subtle bg-surface-raised/80 px-2 backdrop-blur sm:px-3.5'
            : 'h-11 px-2 sm:px-3',
        )}
      >
        <IconToggle on={railOn('threads')} onClick={() => toggleRail('threads')} title="Conversations (⌘[)"><IconSidebar /></IconToggle>
        {overlay ? <AdharAiMark size={30} busy={state.busy} /> : null}
        <div className={cn('min-w-0', !overlay && 'sr-only')}>
          <div className="flex items-center gap-1.5 text-[14px] font-semibold tracking-tight text-content">
            Adhar AI
            {state.configured ? <span className="hidden rounded bg-surface-sunken px-1 py-px font-mono text-[9px] font-medium uppercase tracking-wider text-content-subtle sm:inline">AG-UI</span> : null}
            {runtime?.configured ? (
              <span
                title={runtime.reachable ? 'adhar-ai runtime reachable' : 'adhar-ai runtime unreachable'}
                className={cn('inline-flex items-center gap-1 rounded-full text-[9.5px] font-medium sm:px-1.5 sm:py-px', runtime.reachable ? 'text-emerald-700 sm:bg-emerald-50 dark:text-emerald-300 dark:sm:bg-emerald-500/10' : 'text-rose-700 sm:bg-rose-50 dark:text-rose-300 dark:sm:bg-rose-500/10')}
              >
                <span className={cn('h-2 w-2 rounded-full sm:h-1.5 sm:w-1.5', runtime.reachable ? 'bg-emerald-500' : 'bg-rose-500')} /> <span className="hidden sm:inline">runtime</span>
              </span>
            ) : null}
          </div>
          <div className="hidden truncate text-[11px] text-content-subtle sm:block">
            {state.configured ? runtimeLine || 'reads with your RBAC · changes become pull requests' : 'AI not configured — search & navigate still work'}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
          {canvasBlocks.length ? (
            <HeaderBtn onClick={() => setCanvas((v) => !v)} title={canvas ? 'Back to the conversation' : `Lay out all ${canvasBlocks.length} visuals side by side`} active={canvas}>
              <IconCanvas /> <span className="hidden sm:inline">Canvas</span> <span className="tabular-nums opacity-60">{canvasBlocks.length}</span>
            </HeaderBtn>
          ) : null}
          <IconToggle on={railOn('inspector')} onClick={() => toggleRail('inspector')} title="Inspector (⌘])"><IconPanelRight /></IconToggle>
          {overlay && !phone ? (
            <IconToggle on={layout.full} onClick={() => setLayout((l) => ({ ...l, full: !l.full }))} title={layout.full ? 'Exit fullscreen (⌘⇧F)' : 'Fullscreen (⌘⇧F)'}>
              {layout.full ? <IconShrink /> : <IconExpand />}
            </IconToggle>
          ) : null}
          {!phone ? <ShortcutsMenu /> : null}
          {onClose ? (
            <button type="button" onClick={onClose} aria-label={overlay ? 'Close (Esc)' : 'Leave Adhar AI'} title={overlay ? 'Close (Esc)' : 'Leave Adhar AI'} className="ml-0.5 flex h-8 w-8 items-center justify-center rounded-lg text-content-subtle transition-colors hover:bg-surface-sunken hover:text-content"><IconX /></button>
          ) : null}
        </div>
      </header>
      ) : null}

      {/* ═══ body ═══ */}
      <div
        className="relative grid min-h-0 flex-1"
        style={{
          gridTemplateColumns: [
            asColumn('threads') ? `${RAIL_THREADS}px` : null,
            'minmax(0,1fr)',
            asColumn('inspector') ? `${RAIL_INSPECTOR}px` : null,
          ].filter(Boolean).join(' '),
        }}
      >
        {asColumn('threads') ? <div className="min-h-0 overflow-hidden">{threadsRail}</div> : null}

        {/*
          The page's only chrome: two quiet toggles floating over the top
          corners of the conversation. They replace the removed header bar —
          same controls, no band, no height taken from the transcript.
        */}
        {!overlay ? (
          <>
            {!asColumn('threads') ? (
              <div className="absolute left-2 top-2 z-20">
                <RailPeek onClick={() => toggleRail('threads')} title="Conversations (⌘[)">
                  <IconSidebar />
                </RailPeek>
              </div>
            ) : null}
            {!asColumn('inspector') ? (
              <div className="absolute right-2 top-2 z-20">
                <RailPeek onClick={() => toggleRail('inspector')} title="Inspector (⌘])">
                  <IconPanelRight />
                </RailPeek>
              </div>
            ) : null}
          </>
        ) : null}

        <section className="flex min-h-0 flex-col">
          <div
            ref={threadRef}
            onScroll={(e) => { const el = e.currentTarget; stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48 }}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-5 sm:py-5 md:px-8"
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
                onAsk={askInComposer}
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

        {asColumn('inspector') ? <div className="min-h-0 overflow-hidden">{inspector}</div> : null}

        {/* Whatever does not fit as a column opens as a sheet over the conversation. */}
        {sheet && !asColumn(sheet) ? (
          <Sheet side={sheet === 'threads' ? 'left' : 'right'} onClose={() => setSheet(null)} label={sheet === 'threads' ? 'Conversations' : 'Inspector'}>
            {sheet === 'threads' ? threadsRail : inspector}
          </Sheet>
        ) : null}
      </div>
    </>
  )

  if (!overlay) {
    return (
      <div ref={frameRef} className="flex h-full min-h-0 flex-col bg-surface-app" aria-label="Adhar AI">
        {frame}
      </div>
    )
  }

  const edge = layout.full || phone
  return (
    <div role="dialog" aria-modal="true" aria-label="Adhar AI" className={cn('fixed inset-0 z-[70] flex items-center justify-center', edge ? 'p-0' : 'p-2 sm:p-4')}>
      <div className="fade-in absolute inset-0 bg-scrim/45 backdrop-blur-[3px]" onClick={onClose} aria-hidden />
      <div
        ref={frameRef}
        className={cn(
          'pop-in relative flex w-full flex-col overflow-hidden bg-surface-app transition-[border-radius] duration-200',
          edge
            ? 'h-dvh max-w-none rounded-none'
            : 'h-[94vh] max-w-[1500px] rounded-2xl border border-edge-default shadow-[0_48px_96px_-24px_rgba(15,23,42,0.55)]',
        )}
      >
        {frame}
      </div>
    </div>
  )
}

/**
 * A rail as a phone sheet: slides in from its side over the conversation,
 * scrim behind it, Esc or a tap outside closes it. Positioned inside the
 * surface (which is already a fixed layer), so no portal is needed.
 */
function Sheet({ side, label, onClose, children }: { side: 'left' | 'right'; label: string; onClose(): void; children: ReactNode }) {
  return (
    <div className="absolute inset-0 z-20 flex" role="dialog" aria-modal="true" aria-label={label}>
      <button type="button" aria-label={`Close ${label.toLowerCase()}`} onClick={onClose} className="fade-in absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" />
      <div className={cn('rise-in relative flex h-full w-[min(88vw,360px)] flex-col overflow-hidden bg-surface-app shadow-2xl', side === 'left' ? 'mr-auto border-r border-edge-default' : 'ml-auto border-l border-edge-default')}>
        {children}
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

function IconToggle({ on, onClick, title, children }: { on: boolean; onClick(): void; title: string; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title} aria-pressed={on} className={cn('flex h-9 w-9 items-center justify-center rounded-lg transition-colors sm:h-8 sm:w-8', on ? 'text-content hover:bg-surface-sunken' : 'text-content-subtle hover:bg-surface-sunken hover:text-content')}>
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

/**
 * A rail toggle for the header-less page variant.
 *
 * Deliberately low-contrast and small: it sits ON the conversation rather
 * than in a bar of its own, so it has to be findable without competing with
 * the content. It disappears once its rail is open — the rail's own close
 * control takes over, and leaving both visible put two "close this" affordances
 * side by side.
 */
function RailPeek({ children, onClick, title }: { children: ReactNode; onClick(): void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-8 w-8 items-center justify-center rounded-lg border border-edge-subtle bg-surface-raised/70 text-content-subtle shadow-sm backdrop-blur transition-colors hover:border-edge-default hover:bg-surface-raised hover:text-content"
    >
      {children}
    </button>
  )
}

function HeaderBtn({ children, onClick, title, active = false }: { children: ReactNode; onClick(): void; title: string; active?: boolean }) {
  return (
    <button type="button" onClick={onClick} title={title} className={cn('inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[12px] font-medium transition-colors sm:px-2.5', active ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300' : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong hover:text-content')}>
      {children}
    </button>
  )
}
