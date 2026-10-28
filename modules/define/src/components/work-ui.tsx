import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { EmptyState, Spinner } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import { memberDisplayName, memberInitials, planeError } from '../data/plane.ts'
import { retryAfterSeconds } from '../data/work-bulk.ts'

/**
 * Shared atoms for the work-item surfaces: avatars, state / priority marks,
 * an anchored popover that escapes scroll containers, searchable pick menus,
 * keyboard shortcuts, and honest Plane error states.
 */

/* ───── people ───── */

export function Avatar({ member, size = 20, title }: { member?: plane.Member; size?: number; title?: string }) {
  const name = memberDisplayName(member)
  const src = member?.member?.avatar ?? member?.avatar ?? undefined
  const style = { width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.42)) }
  if (src && /^https?:\/\//.test(src)) {
    return <img src={src} alt="" title={title ?? name} style={style} className="shrink-0 rounded-full object-cover ring-2 ring-surface-raised" />
  }
  return (
    <span title={title ?? name} style={style} className="flex shrink-0 items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-800 ring-2 ring-surface-raised dark:bg-brand-500/20 dark:text-brand-200">
      {member ? memberInitials(member) : '?'}
    </span>
  )
}

export function AvatarStack({ members, max = 3, size = 20 }: { members: plane.Member[]; max?: number; size?: number }) {
  if (!members.length) return null
  return (
    <span className="flex items-center -space-x-1.5">
      {members.slice(0, max).map((m) => <Avatar key={m.id} member={m} size={size} />)}
      {members.length > max ? (
        <span style={{ width: size, height: size }} className="flex items-center justify-center rounded-full bg-surface-sunken text-[9px] font-semibold text-content-muted ring-2 ring-surface-raised">
          +{members.length - max}
        </span>
      ) : null}
    </span>
  )
}

/* ───── state / priority ───── */

export function StateDot({ state, size = 10 }: { state?: Pick<plane.State, 'color' | 'group' | 'name'>; size?: number }) {
  const color = state?.color ?? 'var(--color-edge-strong)'
  const g = state?.group
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden className="shrink-0">
      {g === 'completed' ? (
        <>
          <circle cx="6" cy="6" r="5.5" fill={color} />
          <path d="M3.5 6.2l1.7 1.6 3.3-3.4" stroke="white" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </>
      ) : g === 'cancelled' ? (
        <>
          <circle cx="6" cy="6" r="5.5" fill={color} />
          <path d="M4 4l4 4M8 4l-4 4" stroke="white" strokeWidth="1.4" strokeLinecap="round" />
        </>
      ) : g === 'started' ? (
        <>
          <circle cx="6" cy="6" r="5" fill="none" stroke={color} strokeWidth="1.5" />
          <path d="M6 1a5 5 0 0 1 0 10z" fill={color} />
        </>
      ) : g === 'backlog' ? (
        <circle cx="6" cy="6" r="5" fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="2 1.6" />
      ) : (
        <circle cx="6" cy="6" r="5" fill="none" stroke={color} strokeWidth="1.5" />
      )}
    </svg>
  )
}

export const PRIORITIES: plane.Priority[] = ['urgent', 'high', 'medium', 'low', 'none']
export const PRIORITY_LABEL: Record<plane.Priority, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'No priority' }
const PRIORITY_TONE: Record<plane.Priority, string> = {
  urgent: 'text-rose-600 dark:text-rose-400',
  high: 'text-orange-500 dark:text-orange-400',
  medium: 'text-amber-500 dark:text-amber-300',
  low: 'text-sky-500 dark:text-sky-400',
  none: 'text-content-subtle',
}

export function PriorityIcon({ priority, size = 14 }: { priority: plane.Priority; size?: number }) {
  const tone = PRIORITY_TONE[priority] ?? PRIORITY_TONE.none
  return (
    <span className={cn('inline-flex shrink-0', tone)} title={PRIORITY_LABEL[priority]} aria-label={PRIORITY_LABEL[priority]}>
      <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
        {priority === 'urgent' ? (
          <>
            <rect x="1.5" y="1.5" width="13" height="13" rx="3" />
            <rect x="7.2" y="4" width="1.6" height="5.2" rx=".8" fill="white" />
            <circle cx="8" cy="11.3" r=".95" fill="white" />
          </>
        ) : priority === 'none' ? (
          <path d="M3 8h2M7 8h2M11 8h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        ) : (
          <>
            <rect x="2" y="10" width="3" height="4" rx=".8" />
            <rect x="6.5" y="6.5" width="3" height="7.5" rx=".8" opacity={priority === 'low' ? 0.25 : 1} />
            <rect x="11" y="3" width="3" height="11" rx=".8" opacity={priority === 'high' ? 1 : 0.25} />
          </>
        )}
      </svg>
    </span>
  )
}

export function LabelChip({ label, onRemove }: { label: Pick<plane.Label, 'name' | 'color'>; onRemove?(): void }) {
  return (
    <span className="inline-flex max-w-[10rem] items-center gap-1 rounded-full border border-edge-subtle bg-surface-raised px-1.5 py-px text-[10.5px] text-content-muted">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
      <span className="truncate">{label.name}</span>
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={`Remove ${label.name}`} className="-mr-0.5 text-content-subtle hover:text-content">×</button>
      ) : null}
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-edge-default bg-surface-sunken px-1 font-mono text-[10px] font-medium text-content-muted">{children}</kbd>
}

/** A small "console-side" tag for data Plane never sees. */
export function ConsoleSide({ title = 'Stored by the console, not in Plane' }: { title?: string }) {
  return (
    <span title={title} className="inline-flex items-center rounded-full bg-violet-50 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-violet-700 ring-1 ring-inset ring-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-500/30">
      console-side
    </span>
  )
}

export function ProgressBar({ value, total, tone = 'brand', className }: { value: number; total: number; tone?: 'brand' | 'emerald' | 'rose' | 'amber'; className?: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0
  const bar = { brand: 'bg-brand-500', emerald: 'bg-emerald-500', rose: 'bg-rose-500', amber: 'bg-amber-500' }[tone]
  return (
    <span className={cn('block h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken', className)} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span className={cn('block h-full rounded-full transition-[width]', bar)} style={{ width: `${pct}%` }} />
    </span>
  )
}

/* ───── Plane error states ───── */

/** An honest error state: not configured, rate limited (with retry time), no permission, or the message. */
export function PlaneErrorState({ error, what = 'work items', onRetry }: { error: unknown; what?: string; onRetry?(): void }) {
  const status = (error as { status?: number })?.status
  const wait = retryAfterSeconds(error)
  let title = `Couldn't load ${what} from Plane`
  let description = planeError(error)
  if (status === 429) {
    title = 'Plane is rate-limiting the console'
    description = `The console shares one Plane API key (60 requests a minute) across every user. Plane asks to wait about ${wait ?? 60}s; this page retries on its own.`
  } else if (status === 403) {
    title = "The console's Plane key can't read this project"
    // The plane package's plane-project-access CronJob adds the key's user
    // (and every platform admin) to each project every five minutes.
    description = "Plane answered 403: the key's user is not a member of this project yet. The platform adds it to every Plane project within five minutes of its creation — if this persists, check the plane-project-access job in adhar-system."
  }
  return (
    <EmptyState
      title={title}
      description={description}
      action={onRetry ? <button type="button" onClick={onRetry} className="rounded-md border border-edge-default px-3 py-1.5 text-xs font-medium text-content hover:bg-surface-sunken">Try again</button> : undefined}
    />
  )
}

export function InlineLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-content-muted">
      <Spinner size={11} /> {label}
    </span>
  )
}

/* ───── popover ───── */

/**
 * A panel anchored to an element, portalled to <body> with fixed positioning
 * so table cells and board columns (overflow: auto) never clip it. Flips
 * above the anchor near the bottom edge; clamps to the viewport.
 */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  width = 240,
  align = 'start',
}: {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose(): void
  children: ReactNode
  width?: number
  align?: 'start' | 'end'
}) {
  const panel = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const a = anchor.current?.getBoundingClientRect()
      if (!a) return
      const vw = globalThis.innerWidth
      const vh = globalThis.innerHeight
      const w = Math.min(width, vw - 16)
      let left = align === 'end' ? a.right - w : a.left
      left = Math.max(8, Math.min(left, vw - w - 8))
      const below = vh - a.bottom - 8
      const above = a.top - 8
      const flip = below < 220 && above > below
      const maxHeight = Math.max(160, Math.min(380, flip ? above : below))
      const top = flip ? Math.max(8, a.top - 4 - Math.min(maxHeight, panel.current?.offsetHeight ?? maxHeight)) : a.bottom + 4
      setPos({ top, left, maxHeight })
    }
    place()
    globalThis.addEventListener('resize', place)
    globalThis.addEventListener('scroll', place, true)
    return () => {
      globalThis.removeEventListener('resize', place)
      globalThis.removeEventListener('scroll', place, true)
    }
  }, [open, anchor, width, align])
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    globalThis.addEventListener('pointerdown', onDown, true)
    globalThis.addEventListener('keydown', onKey, true)
    return () => {
      globalThis.removeEventListener('pointerdown', onDown, true)
      globalThis.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose, anchor])
  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: Math.min(width, (globalThis.innerWidth || width) - 16), maxHeight: pos?.maxHeight }}
      className="z-[80] flex flex-col overflow-hidden rounded-xl border border-edge-default bg-surface-raised text-content shadow-2xl ring-1 ring-black/5"
    >
      {children}
    </div>,
    document.body,
  )
}

export interface PickItem {
  id: string
  label: string
  hint?: string
  icon?: ReactNode
  keywords?: string
}

/**
 * Searchable single / multi pick list (arrow keys, Enter, type to filter).
 * Multi mode toggles and stays open; single mode picks and closes.
 */
export function PickMenu({
  items,
  selected,
  multi = false,
  onPick,
  onClose,
  placeholder = 'Filter…',
  empty = 'Nothing matches.',
  footer,
}: {
  items: PickItem[]
  selected: string[]
  multi?: boolean
  onPick(id: string): void
  onClose(): void
  placeholder?: string
  empty?: string
  footer?: ReactNode
}) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  const shown = useMemo(() => {
    const f = q.trim().toLowerCase()
    return f ? items.filter((i) => `${i.label} ${i.keywords ?? ''} ${i.hint ?? ''}`.toLowerCase().includes(f)) : items
  }, [items, q])
  useEffect(() => setActive(0), [q])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <>
      <div className="border-b border-edge-subtle p-1.5">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(a + 1, shown.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const it = shown[active]
              if (it) {
                onPick(it.id)
                if (!multi) onClose()
              }
            }
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          className="block h-8 w-full rounded-md border border-edge-default bg-surface-app px-2 text-[12.5px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none"
        />
      </div>
      <ul ref={list} role="listbox" aria-multiselectable={multi} className="min-h-0 flex-1 overflow-y-auto p-1">
        {shown.length === 0 ? <li className="px-2.5 py-2 text-[12px] text-content-subtle">{empty}</li> : null}
        {shown.map((it, idx) => {
          const on = selected.includes(it.id)
          return (
            <li key={it.id}>
              <button
                type="button"
                role="option"
                data-idx={idx}
                aria-selected={on}
                onMouseEnter={() => setActive(idx)}
                onClick={() => {
                  onPick(it.id)
                  if (!multi) onClose()
                }}
                className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px]', idx === active ? 'bg-surface-sunken' : '', on ? 'font-medium text-content' : 'text-content')}
              >
                {multi ? (
                  <span className={cn('flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border', on ? 'border-brand-500 bg-brand-500 text-white' : 'border-edge-strong')}>
                    {on ? <IconCheck size={10} /> : null}
                  </span>
                ) : null}
                {it.icon}
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {it.hint ? <span className="shrink-0 text-[11px] text-content-subtle">{it.hint}</span> : null}
                {!multi && on ? <IconCheck size={12} /> : null}
              </button>
            </li>
          )
        })}
      </ul>
      {footer ? <div className="border-t border-edge-subtle p-1.5">{footer}</div> : null}
    </>
  )
}

/** A trigger + PickMenu popover in one. */
export function PickButton({
  items,
  selected,
  multi,
  onPick,
  children,
  className,
  title,
  width = 240,
  disabled,
  placeholder,
  openSignal,
}: {
  items: PickItem[]
  selected: string[]
  multi?: boolean
  onPick(id: string): void
  children: ReactNode
  className?: string
  title?: string
  width?: number
  disabled?: boolean
  placeholder?: string
  /** Bump to open programmatically (keyboard shortcuts). */
  openSignal?: number
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (openSignal) setOpen(true)
  }, [openSignal])
  return (
    <>
      <button
        ref={ref}
        type="button"
        title={title}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        className={cn('min-w-0 disabled:cursor-not-allowed disabled:opacity-60', className)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {children}
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={width}>
        <PickMenu items={items} selected={selected} multi={multi} onPick={onPick} onClose={() => setOpen(false)} placeholder={placeholder} />
      </Popover>
    </>
  )
}

/* ───── keyboard ───── */

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

/**
 * Single-key shortcuts (`c`, `/`, `j`…) that never fire while typing, with a
 * modal open, or with a modifier held — except entries written `mod+…`.
 */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, enabled = true) {
  const ref = useRef(map)
  ref.current = map
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      const name = mod ? `mod+${key}` : e.shiftKey && key === '?' ? '?' : key
      const fn = ref.current[name]
      if (!fn) return
      if (!mod && (isTypingTarget(e.target) || e.altKey)) return
      // Enter on a focused button / link activates it, not the shortcut.
      if (key === 'Enter' && (e.target as HTMLElement | null)?.closest?.('button, a, [role="option"], [role="tab"]')) return
      // Another dialog (drawer / modal) owns the keyboard while it's open.
      if (!mod && document.querySelector('[role="dialog"][aria-modal="true"]')) return
      e.preventDefault()
      fn(e)
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [enabled])
}

/* ───── icons ───── */

const I = ({ d, size = 14, sw = 2 }: { d: ReactNode; size?: number; sw?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
)
export const IconCheck = ({ size = 12 }: { size?: number }) => <I size={size} sw={2.5} d={<path d="M20 6 9 17l-5-5" />} />
export const IconPlus = ({ size = 12 }: { size?: number }) => <I size={size} sw={2.25} d={<path d="M12 5v14M5 12h14" />} />
export const IconClose = ({ size = 14 }: { size?: number }) => <I size={size} sw={2.25} d={<path d="M18 6 6 18M6 6l12 12" />} />
export const IconChevron = ({ size = 12, open }: { size?: number; open?: boolean }) => (
  <span className={cn('inline-flex transition-transform', open ? 'rotate-90' : '')}>
    <I size={size} d={<path d="m9 6 6 6-6 6" />} />
  </span>
)
export const IconSearch = ({ size = 13 }: { size?: number }) => <I size={size} d={<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>} />
export const IconCalendar = ({ size = 12 }: { size?: number }) => <I size={size} d={<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18" /></>} />
export const IconLink = ({ size = 13 }: { size?: number }) => (
  <I size={size} d={<><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>} />
)
export const IconSubtask = ({ size = 12 }: { size?: number }) => <I size={size} d={<><path d="M6 3v12a3 3 0 0 0 3 3h9" /><path d="m15 15 3 3-3 3" /></>} />
export const IconChecklist = ({ size = 12 }: { size?: number }) => <I size={size} d={<><path d="m3 7 2 2 4-4" /><path d="m3 17 2 2 4-4" /><path d="M13 6h8M13 18h8" /></>} />
export const IconClip = ({ size = 12 }: { size?: number }) => <I size={size} d={<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />} />
export const IconComment = ({ size = 12 }: { size?: number }) => <I size={size} d={<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />} />
export const IconGrip = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    {[6, 12, 18].map((y) => [9, 15].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" />))}
  </svg>
)
export const IconExternal = ({ size = 12 }: { size?: number }) => <I size={size} d={<><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>} />
export const IconBranch = ({ size = 12 }: { size?: number }) => <I size={size} d={<><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 8v8M18 10c0 4-6 3-10 6" /></>} />
export const IconPr = ({ size = 12 }: { size?: number }) => <I size={size} d={<><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-4" /><path d="m13 4-2 2 2 2" /></>} />
export const IconCommit = ({ size = 12 }: { size?: number }) => <I size={size} d={<><circle cx="12" cy="12" r="3" /><path d="M3 12h6M15 12h6" /></>} />
export const IconRocket = ({ size = 12 }: { size?: number }) => <I size={size} d={<><path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2" /><path d="M9 15 6 12c1-4 4-8 12-9-1 8-5 11-9 12z" /><circle cx="14.5" cy="9.5" r="1.5" /></>} />
export const IconClock = ({ size = 12 }: { size?: number }) => <I size={size} d={<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>} />
export const IconEye = ({ size = 12 }: { size?: number }) => <I size={size} d={<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>} />
export const IconStar = ({ size = 13, filled }: { size?: number; filled?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
    <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z" />
  </svg>
)
export const IconDownload = ({ size = 12 }: { size?: number }) => <I size={size} d={<><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>} />
export const IconColumns = ({ size = 12 }: { size?: number }) => <I size={size} d={<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></>} />
export const IconKeyboard = ({ size = 12 }: { size?: number }) => <I size={size} d={<><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>} />
export const IconBoard = ({ size = 13 }: { size?: number }) => <I size={size} d={<><rect x="3" y="3" width="6" height="14" rx="1.5" /><rect x="11" y="3" width="6" height="9" rx="1.5" /><path d="M19 3h2v6h-2" /></>} />
export const IconList = ({ size = 13 }: { size?: number }) => <I size={size} d={<><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></>} />
export const IconTrash = ({ size = 12 }: { size?: number }) => <I size={size} d={<><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></>} />
export const IconArchive = ({ size = 12 }: { size?: number }) => <I size={size} d={<><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></>} />
export const IconCopy = ({ size = 12 }: { size?: number }) => <I size={size} d={<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>} />
export const IconExpand = ({ size = 13 }: { size?: number }) => <I size={size} d={<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />} />
export const IconSprint = ({ size = 13 }: { size?: number }) => <I size={size} d={<><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></>} />
