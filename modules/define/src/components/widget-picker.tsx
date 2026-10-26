import { type ReactNode, useMemo, useState } from 'react'
import { Button, Modal, SearchInput } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { SIZE_LABEL, type WidgetCategory, type WidgetDef, WIDGETS, type WidgetType } from '../data/dashboard-layout.ts'

/**
 * The widget gallery shown from Customize → Add widgets: every widget with a
 * small preview of what it draws, its description and default width. A
 * widget already on the dashboard can be removed from here too.
 */
export function WidgetPicker({ open, onClose, present, onAdd, onRemove }: {
  open: boolean
  onClose(): void
  present: ReadonlySet<WidgetType>
  onAdd(type: WidgetType): void
  onRemove(type: WidgetType): void
}) {
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<WidgetCategory | 'all'>('all')
  const cats = useMemo(() => [...new Set(WIDGETS.map((w) => w.category))], [])
  const f = q.trim().toLowerCase()
  const shown = WIDGETS.filter((w) => (cat === 'all' || w.category === cat) && (!f || `${w.title} ${w.description}`.toLowerCase().includes(f)))
  const available = WIDGETS.filter((w) => !present.has(w.type)).length

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="xl"
      title="Add widgets"
      description={available ? `${available} more widget${available === 1 ? '' : 's'} available. Added widgets go to the end of the dashboard — drag them into place.` : 'Every widget is on your dashboard.'}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <SearchInput value={q} onChange={setQ} placeholder="Search widgets…" block />
          </div>
          <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 sm:pb-0" role="tablist" aria-label="Widget category">
            {(['all', ...cats] as const).map((c) => (
              <button
                key={c}
                type="button"
                role="tab"
                aria-selected={cat === c}
                onClick={() => setCat(c)}
                className={cn(
                  'shrink-0 rounded-full border px-3 py-1 text-[12px] font-medium transition-colors',
                  cat === c
                    ? 'border-brand-400 bg-brand-50 text-brand-800 dark:border-brand-500/50 dark:bg-brand-500/15 dark:text-brand-200'
                    : 'border-edge-default text-content-muted hover:border-edge-strong hover:text-content',
                )}
              >
                {c === 'all' ? 'All' : c}
              </button>
            ))}
          </div>
        </div>
        {shown.length
          ? (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map((w) => <PickerCard key={w.type} def={w} on={present.has(w.type)} onAdd={() => onAdd(w.type)} onRemove={() => onRemove(w.type)} />)}
            </ul>
          )
          : <p className="py-10 text-center text-[13px] text-content-muted">No widget matches “{q}”.</p>}
      </div>
    </Modal>
  )
}

function PickerCard({ def, on, onAdd, onRemove }: { def: WidgetDef; on: boolean; onAdd(): void; onRemove(): void }) {
  return (
    <li
      className={cn(
        'group flex flex-col overflow-hidden rounded-xl border bg-surface-raised transition-all',
        on ? 'border-brand-300/70 dark:border-brand-500/40' : 'border-edge-default hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-md',
      )}
    >
      <div className={cn('relative flex h-28 items-end justify-center border-b pb-3 border-edge-subtle', on ? 'bg-brand-50/60 dark:bg-brand-500/10' : 'bg-surface-sunken/50')}>
        <WidgetPreview type={def.type} />
        {on
          ? (
            <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-surface-raised px-2 py-0.5 text-[10px] font-semibold text-brand-700 shadow-sm ring-1 ring-brand-200 dark:text-brand-200 dark:ring-brand-500/40">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
              On dashboard
            </span>
          )
          : null}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="truncate text-[13px] font-semibold text-content">{def.title}</h4>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-content-subtle">{def.category}</span>
        </div>
        <p className="flex-1 text-[12px] leading-snug text-content-muted">{def.description}</p>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11px] text-content-subtle">{SIZE_LABEL[def.size]}</span>
          {on
            ? <Button size="sm" variant="ghost" onClick={onRemove}>Remove</Button>
            : <Button size="sm" variant="primary" onClick={onAdd}>Add</Button>}
        </div>
      </div>
    </li>
  )
}

/* ───── previews: a small, theme-tinted sketch of what each widget draws ───── */

type PreviewKind = 'stats' | 'list' | 'cards' | 'segment' | 'bars' | 'line' | 'gauge' | 'meters' | 'notes' | 'inbox'

const PREVIEW: Record<WidgetType, PreviewKind> = {
  counters: 'stats',
  'my-open': 'list',
  'due-soon': 'list',
  'active-sprints': 'cards',
  'by-state': 'segment',
  'by-priority': 'bars',
  'by-assignee': 'bars',
  'created-resolved': 'line',
  'bug-trend': 'line',
  'cycle-time': 'gauge',
  blocked: 'list',
  intake: 'inbox',
  recent: 'list',
  releases: 'meters',
  okrs: 'meters',
  notes: 'notes',
}

export function WidgetPreview({ type, className }: { type: WidgetType; className?: string }) {
  return (
    <svg viewBox="0 0 120 64" className={cn('h-16 w-32 text-brand-500 dark:text-brand-300', className)} aria-hidden>
      {SKETCH[PREVIEW[type]]}
    </svg>
  )
}

const line = 'fill-none stroke-current'
const soft = 'fill-current opacity-20'
const mid = 'fill-current opacity-45'
const solid = 'fill-current opacity-80'
const SKETCH: Record<PreviewKind, ReactNode> = {
  stats: (
    <>
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x={4 + i * 39} y={10} width={34} height={44} rx={5} className={soft} />
          <rect x={10 + i * 39} y={18} width={16} height={3} rx={1.5} className={mid} />
          <rect x={10 + i * 39} y={28} width={12} height={14} rx={2} className={solid} />
        </g>
      ))}
    </>
  ),
  list: (
    <>
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <circle cx={10} cy={12 + i * 13} r={3} className={i === 0 ? solid : mid} />
          <rect x={18} y={10 + i * 13} width={60 - i * 8} height={4} rx={2} className={mid} />
          <rect x={92} y={9 + i * 13} width={22} height={6} rx={3} className={soft} />
        </g>
      ))}
    </>
  ),
  cards: (
    <>
      {[0, 1].map((i) => (
        <g key={i}>
          <rect x={4 + i * 58} y={8} width={54} height={48} rx={5} className={soft} />
          <rect x={10 + i * 58} y={15} width={26} height={4} rx={2} className={mid} />
          <rect x={10 + i * 58} y={40} width={40} height={4} rx={2} className={soft} />
          <rect x={10 + i * 58} y={40} width={24 - i * 8} height={4} rx={2} className={solid} />
          <path d={`M${12 + i * 58} 24 L${24 + i * 58} 28 L${36 + i * 58} 31 L${48 + i * 58} 35`} className={line} strokeWidth={1.6} />
        </g>
      ))}
    </>
  ),
  segment: (
    <>
      <rect x={6} y={22} width={30} height={12} rx={3} className={soft} />
      <rect x={38} y={22} width={22} height={12} rx={3} className={mid} />
      <rect x={62} y={22} width={34} height={12} rx={3} className={solid} />
      <rect x={98} y={22} width={16} height={12} rx={3} className={mid} />
      {[0, 1, 2].map((i) => <rect key={i} x={6 + i * 38} y={42} width={28} height={4} rx={2} className={soft} />)}
    </>
  ),
  bars: (
    <>
      {[54, 40, 30, 18, 10].map((w, i) => (
        <g key={i}>
          <rect x={6} y={8 + i * 10} width={24} height={4} rx={2} className={soft} />
          <rect x={36} y={7 + i * 10} width={w + 20} height={6} rx={3} className={i === 0 ? solid : mid} />
        </g>
      ))}
    </>
  ),
  line: (
    <>
      <path d="M6 54 H114" className={line} strokeWidth={1} opacity={0.25} />
      <path d="M6 50 C 30 44, 40 30, 60 26 S 96 12, 114 8" className={line} strokeWidth={2} opacity={0.45} />
      <path d="M6 54 C 30 50, 44 42, 62 38 S 98 24, 114 20" className={line} strokeWidth={2.2} />
      <path d="M6 54 C 30 50, 44 42, 62 38 S 98 24, 114 20 V54 Z" className={soft} />
    </>
  ),
  gauge: (
    <>
      <rect x={6} y={10} width={50} height={44} rx={5} className={soft} />
      <rect x={64} y={10} width={50} height={44} rx={5} className={soft} />
      <rect x={14} y={20} width={20} height={3} rx={1.5} className={mid} />
      <rect x={72} y={20} width={20} height={3} rx={1.5} className={mid} />
      <rect x={14} y={30} width={26} height={14} rx={2} className={solid} />
      <rect x={72} y={30} width={18} height={14} rx={2} className={solid} />
    </>
  ),
  meters: (
    <>
      {[70, 46, 88].map((w, i) => (
        <g key={i}>
          <rect x={6} y={8 + i * 18} width={50} height={4} rx={2} className={mid} />
          <rect x={96} y={8 + i * 18} width={18} height={4} rx={2} className={soft} />
          <rect x={6} y={15 + i * 18} width={108} height={4} rx={2} className={soft} />
          <rect x={6} y={15 + i * 18} width={w} height={4} rx={2} className={solid} />
        </g>
      ))}
    </>
  ),
  notes: (
    <>
      {[0, 1, 2].map((i) => (
        <g key={i} transform={`rotate(${[-4, 2, -1][i]} ${22 + i * 38} 32)`}>
          <rect x={6 + i * 38} y={10} width={32} height={42} rx={3} className={i === 1 ? mid : soft} />
          <rect x={11 + i * 38} y={18} width={20} height={3} rx={1.5} className={solid} />
          <rect x={11 + i * 38} y={25} width={16} height={3} rx={1.5} className={mid} />
        </g>
      ))}
    </>
  ),
  inbox: (
    <>
      <rect x={30} y={8} width={60} height={48} rx={6} className={soft} />
      <path d="M30 36 H48 L54 44 H66 L72 36 H90" className={line} strokeWidth={2} />
      <rect x={42} y={16} width={36} height={4} rx={2} className={mid} />
      <rect x={42} y={24} width={26} height={4} rx={2} className={solid} />
    </>
  ),
}
