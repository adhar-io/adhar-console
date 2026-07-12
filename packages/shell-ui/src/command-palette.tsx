import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { cn } from '@adhar-console/utils'
import { DEFAULT_NAV, type NavItem, type NavSection } from './nav-tree.tsx'

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
  icon?: React.ReactNode
  /** Custom action — runs instead of navigating. */
  onSelect?(): void
  keywords?: string[]
}

/**
 * Keyboard-driven command palette with a built-in AI lane.
 *
 *   • Search mode (default) — instant fuzzy match across the nav + items.
 *   • Ask AI                — at the top of every result list when there's
 *                              a query; pressing Enter on it streams a
 *                              suggestion with structured next-step
 *                              commands derived from the query.
 *
 * Focus UX: the entire modal gets a brand-tinted ring while the input is
 * focused so the user always sees where keyboard focus is, even though the
 * native input outline is suppressed for layout reasons.
 */
export function CommandPalette({
  open,
  onClose,
  items,
  sections = DEFAULT_NAV,
}: CommandPaletteProps) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [aiSession, setAiSession] = useState<AiSession | null>(null)
  const aiHandleRef = useRef<AiStreamHandle | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const lastInput = useRef<'mouse' | 'keyboard'>('keyboard')

  const allItems = useMemo<CommandItem[]>(
    () => (items && items.length ? items : flattenNav(sections)),
    [items, sections],
  )
  const filtered = useMemo(() => filterItems(allItems, query), [allItems, query])

  /**
   * Combined list shown to the user — the AI suggestion is index 0 when
   * a query is present so Enter on a fresh palette runs AI by default.
   */
  type Row =
    | { kind: 'ai'; query: string }
    | { kind: 'cmd'; item: CommandItem }
  const rows = useMemo<Row[]>(() => {
    if (aiSession) return [] // AI takes over the body
    const out: Row[] = []
    if (query.trim().length > 0) {
      out.push({ kind: 'ai', query: query.trim() })
    }
    for (const item of filtered) out.push({ kind: 'cmd', item })
    return out
  }, [aiSession, filtered, query])

  // Reset state whenever open flips. Closing also cancels any in-flight
  // AI stream so its setTimeout chain doesn't bleed into the next session.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      setAiSession(null)
      lastInput.current = 'keyboard'
      const id = requestAnimationFrame(() => inputRef.current?.focus())
      return () => cancelAnimationFrame(id)
    }
    aiHandleRef.current?.cancel()
    aiHandleRef.current = null
  }, [open])

  // Final-cleanup safety net for unmount.
  useEffect(() => {
    return () => {
      aiHandleRef.current?.cancel()
      aiHandleRef.current = null
    }
  }, [])

  // Clamp active index as the list changes.
  useEffect(() => {
    setActive((i) => Math.min(Math.max(i, 0), Math.max(rows.length - 1, 0)))
  }, [rows.length])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (aiSession) {
          aiHandleRef.current?.cancel()
          aiHandleRef.current = null
          setAiSession(null)
        } else {
          onClose()
        }
      } else if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
        e.preventDefault()
        lastInput.current = 'keyboard'
        setActive((i) => Math.min(i + 1, Math.max(rows.length - 1, 0)))
      } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
        e.preventDefault()
        lastInput.current = 'keyboard'
        setActive((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Home') {
        e.preventDefault()
        lastInput.current = 'keyboard'
        setActive(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        lastInput.current = 'keyboard'
        setActive(Math.max(rows.length - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const row = rows[active]
        if (!row) return
        if (row.kind === 'ai') runAi(row.query)
        else runItem(row.item)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, rows, active, aiSession])

  // Keep the active row in view when keyboard navigating.
  useLayoutEffect(() => {
    if (!open || lastInput.current !== 'keyboard') return
    const root = listRef.current
    if (!root) return
    const el = root.querySelector<HTMLElement>(`[data-cmd-idx="${active}"]`)
    if (!el) return
    const top = el.offsetTop
    const bottom = top + el.offsetHeight
    const viewTop = root.scrollTop
    const viewBottom = viewTop + root.clientHeight
    if (top < viewTop) root.scrollTop = top - 4
    else if (bottom > viewBottom) root.scrollTop = bottom - root.clientHeight + 4
  }, [active, open, rows.length])

  function runItem(item: CommandItem) {
    if (item.onSelect) item.onSelect()
    else if (item.to) navigate({ to: item.to, search: item.search as never })
    onClose()
  }

  function runAi(prompt: string) {
    // Cancel any prior in-flight stream so resubmits don't interleave.
    aiHandleRef.current?.cancel()
    setAiSession({ status: 'thinking', prompt, chunks: [], suggestions: [] })
    aiHandleRef.current = streamAi(prompt, allItems, (next) => setAiSession(next))
  }

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[14vh]"
    >
      <div
        className="fade-in absolute inset-0 bg-slate-950/55 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        className={cn(
          'pop-in relative w-full max-w-xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_30px_60px_-15px_rgba(15,23,42,0.35)]',
          'ring-1 ring-slate-900/5 transition-shadow duration-150',
          'focus-within:ring-2 focus-within:ring-brand-500/30 focus-within:ring-offset-2 focus-within:ring-offset-slate-950/30',
        )}
        onMouseMove={() => {
          lastInput.current = 'mouse'
        }}
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-4">
          <span className={cn('shrink-0 transition-colors', aiSession ? 'text-brand-600' : 'text-slate-400')}>
            {aiSession ? <AiSparkIcon /> : <SearchIcon />}
          </span>
          <input
            ref={inputRef}
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder={
              aiSession
                ? 'Press Esc to return to search'
                : 'Search anything · or ask AI'
            }
            value={aiSession ? aiSession.prompt : query}
            disabled={Boolean(aiSession)}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
              lastInput.current = 'keyboard'
            }}
            className={cn(
              'h-12 w-full border-0 bg-transparent text-[15px] text-slate-900 placeholder:text-slate-400',
              'outline-none focus:outline-none focus:ring-0',
              'disabled:cursor-not-allowed disabled:text-slate-500',
            )}
          />
          {!aiSession && query ? (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
              className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30"
              aria-label="Clear search"
            >
              <ClearIcon />
            </button>
          ) : null}
          {aiSession ? (
            <button
              type="button"
              onClick={() => {
                aiHandleRef.current?.cancel()
                aiHandleRef.current = null
                setAiSession(null)
              }}
              className="rounded-md border border-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900"
            >
              Back to search
            </button>
          ) : (
            <kbd className="hidden h-5 items-center rounded border border-slate-200 bg-slate-50 px-1.5 font-mono text-[10px] font-medium text-slate-500 sm:inline-flex">
              esc
            </kbd>
          )}
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-2">
          {aiSession ? (
            <AiPanel
              session={aiSession}
              onPick={(item) => runItem(item)}
              onClose={onClose}
            />
          ) : rows.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                <SearchIcon />
              </div>
              <div className="text-sm font-medium text-slate-900">Type to search or ask AI</div>
              <div className="mt-1 text-xs text-slate-500">
                Pages, projects, settings — or natural language like
                <span className="ml-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
                  show failing pods in production
                </span>
              </div>
            </div>
          ) : (
            <ResultList
              rows={rows}
              activeIndex={active}
              showHeader={!query.trim()}
              onHover={(i) => {
                if (lastInput.current === 'mouse') setActive(i)
              }}
              onPick={(row) => {
                if (row.kind === 'ai') runAi(row.query)
                else runItem(row.item)
              }}
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/80 px-4 py-2 text-[11px] text-slate-500">
          <div className="flex items-center gap-3">
            <KbdHint keys={['↑', '↓']}>navigate</KbdHint>
            <KbdHint keys={['↵']}>{aiSession ? 'select' : 'open'}</KbdHint>
            <KbdHint keys={['esc']}>{aiSession ? 'back' : 'close'}</KbdHint>
            {!aiSession ? (
              <span className="hidden items-center gap-1 sm:flex">
                <span className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700">
                  <AiSparkIcon /> AI
                </span>
                <span>on top result</span>
              </span>
            ) : null}
          </div>
          <div className="hidden font-mono tabular-nums sm:block">
            {aiSession
              ? aiSession.status === 'thinking'
                ? 'thinking…'
                : `${aiSession.suggestions.length} action${aiSession.suggestions.length === 1 ? '' : 's'}`
              : `${rows.filter((r) => r.kind === 'cmd').length} result${rows.filter((r) => r.kind === 'cmd').length === 1 ? '' : 's'}`}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ───────────────────── result list ───────────────────── */

function ResultList({
  rows,
  activeIndex,
  showHeader,
  onHover,
  onPick,
}: {
  rows: ({ kind: 'ai'; query: string } | { kind: 'cmd'; item: CommandItem })[]
  activeIndex: number
  showHeader: boolean
  onHover(i: number): void
  onPick(row: { kind: 'ai'; query: string } | { kind: 'cmd'; item: CommandItem }): void
}) {
  const out: React.ReactNode[] = []
  let lastGroup: string | undefined

  if (showHeader && rows.length) {
    out.push(
      <div
        key="__intro"
        className="px-4 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400"
      >
        Suggested
      </div>,
    )
  }

  rows.forEach((row, i) => {
    const isActive = i === activeIndex
    if (row.kind === 'ai') {
      out.push(
        <button
          key="__ai"
          data-cmd-idx={i}
          type="button"
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(row)}
          className={cn(
            'group relative mx-2 flex w-[calc(100%-1rem)] items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors',
            isActive
              ? 'bg-brand-50 text-brand-900 ring-1 ring-inset ring-brand-200'
              : 'text-slate-700 hover:bg-slate-50',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-brand-600 transition-opacity',
              isActive ? 'opacity-100' : 'opacity-0',
            )}
          />
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-brand-600">
            <AiSparkIcon />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold">Ask AI</div>
            <div className="truncate text-[11px] text-slate-500">"{row.query}"</div>
          </div>
          <span className="hidden shrink-0 text-[10px] font-medium uppercase tracking-wider text-brand-700 sm:inline">
            beta
          </span>
          <span
            className={cn(
              'shrink-0 text-brand-600 transition-opacity',
              isActive ? 'opacity-100' : 'opacity-0',
            )}
          >
            <ReturnIcon />
          </span>
        </button>,
      )
      return
    }

    const groupLabel = row.item.group
    if (groupLabel && groupLabel !== lastGroup && !showHeader) {
      lastGroup = groupLabel
      out.push(
        <div
          key={`__h_${groupLabel}_${i}`}
          className="px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400 first:pt-1"
        >
          {groupLabel}
        </div>,
      )
    } else if (groupLabel) {
      lastGroup = groupLabel
    }

    out.push(
      <button
        key={row.item.id}
        data-cmd-idx={i}
        type="button"
        onMouseEnter={() => onHover(i)}
        onClick={() => onPick(row)}
        className={cn(
          'group relative mx-2 flex w-[calc(100%-1rem)] items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors',
          isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-700 hover:bg-slate-50',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-brand-600 transition-opacity',
            isActive ? 'opacity-100' : 'opacity-0',
          )}
        />
        <span
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 transition-colors',
            isActive ? 'text-slate-900' : 'group-hover:text-slate-700',
            '[&>svg]:h-4 [&>svg]:w-4',
          )}
        >
          {row.item.icon ?? <DotIcon />}
        </span>
        <div className="min-w-0 flex-1">
          <div className={cn('truncate text-[13px]', isActive ? 'font-semibold' : 'font-medium')}>
            {row.item.label}
          </div>
          {row.item.description ? (
            <div className="truncate text-[11px] text-slate-500">{row.item.description}</div>
          ) : null}
        </div>
        {row.item.group && showHeader ? (
          <span className="hidden shrink-0 text-[10px] font-medium uppercase tracking-wider text-slate-400 sm:inline">
            {row.item.group}
          </span>
        ) : null}
        <span
          className={cn(
            'shrink-0 text-slate-400 transition-opacity',
            isActive ? 'opacity-100' : 'opacity-0',
          )}
        >
          <ReturnIcon />
        </span>
      </button>,
    )
  })
  return <div className="space-y-px">{out}</div>
}

/* ───────────────────── AI panel ───────────────────── */

interface AiSession {
  prompt: string
  status: 'thinking' | 'streaming' | 'done'
  /** Tokens streamed so far. */
  chunks: string[]
  /** Action suggestions surfaced alongside the answer. */
  suggestions: CommandItem[]
}

function AiPanel({
  session,
  onPick,
  onClose,
}: {
  session: AiSession
  onPick(item: CommandItem): void
  onClose(): void
}) {
  const text = session.chunks.join('')
  return (
    <div className="space-y-4 px-4 py-3">
      <div className="rounded-xl border border-slate-100 bg-slate-50/80 px-3 py-2 text-[12px] text-slate-700">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
          You
        </span>
        <div className="mt-0.5 text-[13px] text-slate-900">{session.prompt}</div>
      </div>

      <div className="rounded-xl border border-brand-100 bg-brand-50/40 p-3">
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-700">
          <AiSparkIcon />
          AI
          {session.status === 'thinking' ? (
            <span className="flex items-center gap-1 text-slate-500">
              <ThinkingDots /> thinking
            </span>
          ) : null}
        </div>
        <div className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-slate-800">
          {text || '\u00a0'}
          {session.status !== 'done' && text ? <span className="ml-0.5 inline-block h-3.5 w-1.5 -translate-y-px animate-pulse bg-brand-500/80 align-middle" /> : null}
        </div>
        {session.suggestions.length ? (
          <div className="mt-3 border-t border-brand-200/60 pt-3">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
              Suggested actions
            </div>
            <div className="space-y-1">
              {session.suggestions.map((s, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => onPick(s)}
                  className="flex w-full items-center gap-2.5 rounded-md border border-transparent bg-white px-2.5 py-1.5 text-left text-[12px] text-slate-800 transition-colors hover:border-brand-300 hover:bg-brand-50"
                >
                  <span className="flex h-5 w-5 items-center justify-center text-brand-600 [&>svg]:h-4 [&>svg]:w-4">
                    {s.icon ?? <DotIcon />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{s.label}</div>
                    {s.description ? (
                      <div className="truncate text-[11px] text-slate-500">{s.description}</div>
                    ) : null}
                  </div>
                  <span className="text-slate-400">
                    <ReturnIcon />
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {session.status === 'done' ? (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-slate-800"
          >
            Done
          </button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Stub LLM — synthesizes a structured "answer" from the prompt by matching
 * keywords against the registered nav items, then streams it as if it were
 * generated. The contract is identical to a real `/api/ai/console` BFF
 * endpoint (prompt → answer text + action commands), so swapping the
 * runtime is one place when the backend lands.
 */
/** Result of `streamAi` — call `cancel()` to abort an in-flight stream
 *  (e.g. when the palette closes or the user resubmits). All scheduled
 *  ticks are cleared and `onUpdate` will not fire after cancellation. */
interface AiStreamHandle {
  cancel(): void
}

function streamAi(
  prompt: string,
  catalog: CommandItem[],
  onUpdate: (s: AiSession) => void,
): AiStreamHandle {
  const matches = matchActions(prompt, catalog).slice(0, 4)
  const answer = composeAnswer(prompt, matches)
  const tokens = tokenize(answer)

  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const chunks: string[] = []
  let i = 0

  const tick = () => {
    if (cancelled) return
    if (i >= tokens.length) {
      onUpdate({ prompt, status: 'done', chunks, suggestions: matches })
      return
    }
    chunks.push(tokens[i++])
    onUpdate({
      prompt,
      status: 'streaming',
      chunks: [...chunks],
      suggestions: matches,
    })
    timer = setTimeout(tick, 18 + Math.random() * 22)
  }

  // Brief "thinking" pause before the first token.
  timer = setTimeout(() => {
    if (cancelled) return
    onUpdate({ prompt, status: 'streaming', chunks: [], suggestions: matches })
    tick()
  }, 350)

  return {
    cancel() {
      cancelled = true
      if (timer != null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}

function tokenize(s: string): string[] {
  // Stream a few characters at a time for a typewriter feel.
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    const len = 2 + Math.floor(Math.random() * 3)
    out.push(s.slice(i, i + len))
    i += len
  }
  return out
}

function matchActions(prompt: string, catalog: CommandItem[]): CommandItem[] {
  const q = prompt.toLowerCase()
  const tokens = q.split(/\W+/).filter((t) => t.length > 2)
  return catalog
    .map((item) => {
      const haystack = `${item.label} ${item.description ?? ''} ${(item.keywords ?? []).join(' ')}`.toLowerCase()
      let score = 0
      for (const t of tokens) if (haystack.includes(t)) score += 5
      if (haystack.includes(q)) score += 50
      return { item, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item)
}

function composeAnswer(prompt: string, matches: CommandItem[]): string {
  const lines: string[] = []
  if (matches.length === 0) {
    lines.push(
      `I couldn't find a built-in action that matches "${prompt}".`,
      '',
      `Try one of the lifecycle phases (Define, Develop, Deliver, Discover) or open the Platform dashboard for cluster-wide actions.`,
    )
    return lines.join('\n')
  }
  const top = matches[0]
  lines.push(
    `Here's what I'd do for "${prompt}":`,
    '',
    `1. Open ${top.label}${top.description ? ` — ${top.description.toLowerCase()}` : ''}.`,
  )
  if (matches[1]) {
    lines.push(`2. Cross-reference with ${matches[1].label} to confirm impact.`)
  }
  if (matches[2]) {
    lines.push(`3. If needed, jump to ${matches[2].label} for follow-up.`)
  }
  lines.push('', 'Pick a suggested action below to navigate there now.')
  return lines.join('\n')
}

/* ───────────────────── kbd / icons ───────────────────── */

function KbdHint({ keys, children }: { keys: string[]; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
      <span>{children}</span>
    </span>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-slate-200 bg-white px-1 font-sans text-[10px] font-medium leading-none text-slate-600 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      {children}
    </kbd>
  )
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

function ClearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </svg>
  )
}

function ReturnIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="9 10 4 15 9 20" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
    </svg>
  )
}

function DotIcon() {
  return (
    <svg width="6" height="6" viewBox="0 0 6 6" aria-hidden>
      <circle cx="3" cy="3" r="2" fill="currentColor" />
    </svg>
  )
}

function AiSparkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2 13.6 8.4 20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6L12 2Z" />
      <path d="M19 16 19.6 18 21.5 18.5 19.6 19 19 21 18.4 19 16.5 18.5 18.4 18 19 16Z" />
    </svg>
  )
}

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      <span className="h-1 w-1 animate-bounce rounded-full bg-brand-400 [animation-delay:-0.2s]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-brand-400 [animation-delay:-0.1s]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-brand-400" />
    </span>
  )
}

/* ───────────────────── nav flatten + filter ───────────────────── */

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
  if (label === needle) return 100
  if (label.startsWith(needle)) return 50
  if (label.includes(needle)) return 25
  if (item.description?.toLowerCase().includes(needle)) return 10
  if (item.keywords?.some((k) => k.toLowerCase().includes(needle))) return 8
  return 0
}
