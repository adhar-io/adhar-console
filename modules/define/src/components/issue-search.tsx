import { useEffect, useRef, useState } from 'react'
import { Spinner } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import { useIssueSearch } from '../data/plane.ts'

/**
 * Search work items by title, number or `KEY-123` through Plane's workspace
 * search. Used to pick a related or duplicate issue, and to jump to any issue
 * from the Issues toolbar. Arrow keys move, Enter picks, Escape clears.
 */
export function IssueSearch({
  onPick,
  project,
  exclude = [],
  placeholder = 'Search by title, number or KEY-123…',
  autoFocus = false,
  className,
}: {
  onPick(hit: plane.SearchHit): void
  /** Limit to one project; omit for the whole workspace. */
  project?: string
  exclude?: string[]
  placeholder?: string
  autoFocus?: boolean
  className?: string
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const search = useIssueSearch(q, { project, limit: 12 })
  const hits = (search.data ?? []).filter((h) => !exclude.includes(h.id))

  useEffect(() => setActive(0), [q])
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    globalThis.addEventListener('pointerdown', onDown)
    return () => globalThis.removeEventListener('pointerdown', onDown)
  }, [open])

  const pick = (h: plane.SearchHit) => {
    onPick(h)
    setQ('')
    setOpen(false)
  }

  return (
    <div ref={ref} className={cn('relative', className)}>
      <input
        autoFocus={autoFocus}
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((a) => Math.min(a + 1, hits.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => Math.max(a - 1, 0))
          } else if (e.key === 'Enter' && hits[active]) {
            e.preventDefault()
            pick(hits[active])
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            setQ('')
            setOpen(false)
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="block h-9 w-full rounded-lg border border-edge-default bg-surface-app px-3 text-[13px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
      />
      {open && q.trim().length >= 2 ? (
        <div className="absolute left-0 right-0 top-full z-60 mt-1 max-h-72 overflow-y-auto rounded-xl border border-edge-default bg-surface-raised p-1 shadow-xl">
          {search.isLoading ? (
            <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-content-muted"><Spinner size={12} /> Searching…</div>
          ) : hits.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-content-muted">No work items match “{q.trim()}”.</div>
          ) : (
            <ul role="listbox">
              {hits.map((h, i) => (
                <li key={h.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(h)}
                    className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]', i === active ? 'bg-surface-sunken' : '')}
                  >
                    <span className="shrink-0 font-mono text-[11px] text-content-subtle">{h.project__identifier}-{h.sequence_id}</span>
                    <span className="min-w-0 flex-1 truncate text-content">{h.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
