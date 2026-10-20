import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@adhar/utils'
import { type Compiled, FIELD_DOCS, type QlContext, type Suggestion, suggest } from '../data/work-ql.ts'
import { IconSearch, Kbd, Popover } from './work-ui.tsx'

/**
 * The WQL bar: a single-line query editor with context-aware autocomplete
 * (fields → operators → values from Plane metadata → AND/OR/ORDER BY), inline
 * errors and warnings, and quick-filter chips that AND onto the query.
 * Enter runs the query (or accepts the highlighted suggestion); `/` focuses it.
 */

export interface QuickFilter {
  id: string
  label: string
  jql: string
}

export const QUICK_FILTERS: QuickFilter[] = [
  { id: 'mine', label: 'Only my items', jql: 'assignee = me()' },
  { id: 'unassigned', label: 'Unassigned', jql: 'assignee is empty' },
  { id: 'sprint', label: 'Current sprint', jql: 'sprint in openSprints()' },
  { id: 'open', label: 'Open', jql: 'category not in (completed, cancelled)' },
  { id: 'high', label: 'High priority', jql: 'priority in (urgent, high)' },
  { id: 'overdue', label: 'Overdue', jql: 'due < today() AND category not in (completed, cancelled)' },
  { id: 'week', label: 'Due this week', jql: 'due <= endOfWeek() AND category not in (completed, cancelled)' },
  { id: 'recent', label: 'Updated in 7 days', jql: 'updated >= -7d' },
]

export function IssueQueryBar({
  value,
  onRun,
  ctx,
  compiled,
  inputRef,
  quick,
  onQuick,
  count,
  total,
  busy,
}: {
  value: string
  onRun(jql: string): void
  ctx: QlContext
  compiled: Compiled
  inputRef?: RefObject<HTMLInputElement | null>
  quick: string[]
  onQuick(ids: string[]): void
  count: number
  total: number
  busy?: boolean
}) {
  const [draft, setDraft] = useState(value)
  const [cursor, setCursor] = useState(value.length)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [helpOpen, setHelpOpen] = useState(false)
  const own = useRef<HTMLInputElement>(null)
  const input = inputRef ?? own
  const helpRef = useRef<HTMLButtonElement>(null)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => setDraft(value), [value])

  const sugg = useMemo(() => suggest(draft, cursor, ctx), [draft, cursor, ctx])
  useEffect(() => setActive(0), [sugg.from, sugg.items.length])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    globalThis.addEventListener('pointerdown', onDown)
    return () => globalThis.removeEventListener('pointerdown', onDown)
  }, [open])

  const apply = (s: Suggestion) => {
    const before = draft.slice(0, sugg.from)
    const after = draft.slice(sugg.to)
    const needsSpace = !after.startsWith(' ')
    const next = `${before}${s.insert}${needsSpace ? ' ' : ''}${after.replace(/^\s/, '')}`
    const pos = before.length + s.insert.length + 1
    setDraft(next)
    setCursor(pos)
    requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.setSelectionRange(pos, pos)
    })
  }

  const syncCursor = () => setCursor(input.current?.selectionStart ?? draft.length)
  const dirty = draft.trim() !== value.trim()
  const showList = open && sugg.items.length > 0

  return (
    <div className="space-y-1.5">
      <div ref={wrap} className="relative">
        <div className={cn('flex h-9 items-center gap-2 rounded-lg border bg-surface-raised pl-2.5 pr-1 shadow-sm transition-colors focus-within:ring-2 focus-within:ring-brand-400/20', compiled.errors.length ? 'border-rose-400' : 'border-edge-default focus-within:border-brand-400')}>
          <span className="text-content-subtle"><IconSearch /></span>
          <input
            ref={input}
            value={draft}
            spellCheck={false}
            autoComplete="off"
            aria-label="Work item query"
            placeholder='Search or query — e.g. status in (Todo, "In Progress") AND assignee = me ORDER BY priority'
            onChange={(e) => {
              setDraft(e.target.value)
              setCursor(e.target.selectionStart ?? e.target.value.length)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onClick={syncCursor}
            onKeyUp={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') syncCursor()
            }}
            onKeyDown={(e) => {
              if (showList && e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(a + 1, sugg.items.length - 1))
              } else if (showList && e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, 0))
              } else if (showList && e.key === 'Tab') {
                e.preventDefault()
                apply(sugg.items[active])
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (showList && dirty && draft.slice(sugg.from, cursor).length > 0) {
                  apply(sugg.items[active])
                  return
                }
                setOpen(false)
                onRun(draft.trim())
              } else if (e.key === 'Escape') {
                if (open) {
                  e.stopPropagation()
                  setOpen(false)
                } else {
                  setDraft(value)
                  input.current?.blur()
                }
              }
            }}
            className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-content placeholder:font-sans placeholder:text-content-subtle focus:outline-none"
          />
          {draft ? (
            <button type="button" aria-label="Clear query" onClick={() => { setDraft(''); onRun('') }} className="rounded px-1 text-content-subtle hover:text-content">×</button>
          ) : null}
          {dirty ? (
            <button type="button" onClick={() => onRun(draft.trim())} className="rounded-md bg-brand-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-brand-700">Run ↵</button>
          ) : (
            <span className="hidden pr-1 sm:inline"><Kbd>/</Kbd></span>
          )}
          <button ref={helpRef} type="button" onClick={() => setHelpOpen((o) => !o)} className="rounded-md px-1.5 py-1 text-[11px] font-medium text-content-muted hover:bg-surface-sunken hover:text-content" aria-label="Query syntax help">
            WQL ?
          </button>
        </div>
        {showList ? (
          <ul role="listbox" className="absolute left-0 right-0 top-full z-40 mt-1 max-h-72 overflow-y-auto rounded-xl border border-edge-default bg-surface-raised p-1 shadow-xl sm:right-auto sm:min-w-[22rem]">
            {sugg.items.map((s, i) => (
              <li key={`${s.kind}-${s.label}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => apply(s)}
                  className={cn('flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left', i === active ? 'bg-surface-sunken' : '')}
                >
                  <span className={cn('w-14 shrink-0 text-[9.5px] font-semibold uppercase tracking-wider', KIND_TONE[s.kind])}>{s.kind}</span>
                  <span className="font-mono text-[12.5px] text-content">{s.label}</span>
                  {s.detail ? <span className="ml-auto truncate pl-2 text-[11px] text-content-subtle">{s.detail}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {compiled.errors.length || compiled.warnings.length ? (
        <div className="space-y-0.5 text-[11.5px]">
          {compiled.errors.map((e, i) => <p key={`e${i}`} className="text-rose-700 dark:text-rose-300">⚠ {e.message}</p>)}
          {compiled.warnings.map((w, i) => <p key={`w${i}`} className="text-amber-700 dark:text-amber-300">{w}</p>)}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-0.5 text-[11px] text-content-subtle">Quick filters</span>
        {QUICK_FILTERS.map((f) => {
          const on = quick.includes(f.id)
          return (
            <button
              key={f.id}
              type="button"
              aria-pressed={on}
              title={f.jql}
              onClick={() => onQuick(on ? quick.filter((x) => x !== f.id) : [...quick, f.id])}
              className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors', on ? 'border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-500/15 dark:text-brand-200' : 'border-edge-default text-content-muted hover:border-edge-strong hover:text-content')}
            >
              {f.label}
            </button>
          )
        })}
        {quick.length ? <button type="button" onClick={() => onQuick([])} className="px-1 text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">Clear</button> : null}
        <span className="ml-auto text-[11px] tabular-nums text-content-subtle">{busy ? 'Refreshing… ' : ''}{count} of {total}</span>
      </div>

      <Popover anchor={helpRef} open={helpOpen} onClose={() => setHelpOpen(false)} width={460} align="end">
        <div className="overflow-y-auto p-3 text-[12px] leading-relaxed">
          <p className="font-semibold text-content">Work query language (WQL)</p>
          <p className="mt-1 text-content-muted">JQL-style. Combine with AND / OR / NOT and parentheses; bare words search titles and descriptions. Plane's API can't filter, so queries run in your browser over the loaded projects.</p>
          <pre className="mt-2 whitespace-pre-wrap rounded-md bg-surface-sunken p-2 font-mono text-[11px] text-content">{`project = CON AND status in (Todo, "In Progress")
  AND assignee = me AND label = bug ORDER BY priority
sprint in openSprints() AND estimate is empty
due < today() AND category != completed ORDER BY due
project in (CON, OPS) AND updated >= -7d`}</pre>
          <table className="mt-2 w-full">
            <tbody>
              {FIELD_DOCS.map((f) => (
                <tr key={f.field} className="align-top">
                  <td className="py-0.5 pr-3 font-mono text-[11px] text-content">{f.field}</td>
                  <td className="py-0.5 text-[11px] text-content-muted">{f.hint}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-content-muted">
            Operators: <code>= != ~ !~ &gt; &gt;= &lt; &lt;= in, not in, is empty, is not empty</code>. Functions: <code>me() now() today() startOfWeek() endOfWeek() startOfMonth() endOfMonth() openSprints() futureSprints() closedSprints()</code>. Relative dates: <code>-7d +2w -1m</code>. Sort: <code>ORDER BY priority, due DESC</code> (priority ascending = most urgent first).
          </p>
        </div>
      </Popover>
    </div>
  )
}

const KIND_TONE: Record<Suggestion['kind'], string> = {
  field: 'text-brand-700 dark:text-brand-300',
  operator: 'text-violet-700 dark:text-violet-300',
  value: 'text-emerald-700 dark:text-emerald-300',
  keyword: 'text-amber-700 dark:text-amber-300',
  function: 'text-sky-700 dark:text-sky-300',
  sort: 'text-content-muted',
}
