import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Modal, useClickOutside } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { metabase } from '@adhar/api-clients'

/**
 * Shared pieces of the BI surfaces: the chart palette, icons, a confirm
 * dialog, a popover menu, a segmented control, the collection picker and a
 * width hook. One look across dashboards, questions, the SQL editor,
 * databases and subscriptions.
 */

/* ─────────── palette ─────────── */

/**
 * Categorical series colours — the validated eight-slot order (adjacent-pair
 * CVD ΔE ≥ 8.4, normal-vision ΔE ≥ 19 in both modes), stepped separately for
 * the dark surface rather than flipped. Three light slots sit under 3:1 on
 * white, so every chart ships a legend, tooltips and a table view as relief.
 * Slots are assigned in order and never cycled: past eight, series fold into
 * "Other" (see `foldSeries`).
 */
const VIZ_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
const VIZ_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']

export function vizColor(i: number): string {
  return `var(--bi-viz-${Math.min(7, Math.max(0, i)) + 1})`
}

export function ensureBiStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('adhar-bi-viz')) return
  const el = document.createElement('style')
  el.id = 'adhar-bi-viz'
  const decl = (arr: string[]) => arr.map((c, i) => `--bi-viz-${i + 1}:${c};`).join('')
  el.textContent = `:root{${decl(VIZ_LIGHT)}--bi-grid:color-mix(in oklab, var(--color-edge-default) 70%, transparent);}` +
    `.dark{${decl(VIZ_DARK)}}` +
    `.bi-fullscreen{position:fixed;inset:0;z-index:70;overflow:auto;background:var(--color-surface-app);padding:16px}`
  document.head.appendChild(el)
}

/* ─────────── hooks ─────────── */

/** Width of an element via a callback ref — works when the element mounts late. */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(0)
  const roRef = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: T | null) => {
    roRef.current?.disconnect()
    roRef.current = null
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (typeof w === 'number') setWidth(Math.round(w))
    })
    ro.observe(el)
    roRef.current = ro
  }, [])
  useEffect(() => () => roRef.current?.disconnect(), [])
  return [ref, width]
}

/** Copy text, reporting success. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Ignore global shortcuts while the user types in a field or editor. */
export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  if (!t) return false
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.closest?.('.monaco-editor')
}

/* ─────────── icons (16px, stroke) ─────────── */

const P = {
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  question: <><path d="M3 3v18h18" /><path d="m7 15 4-4 3 3 5-6" /></>,
  model: <><path d="M12 2 3 7l9 5 9-5-9-5Z" /><path d="m3 17 9 5 9-5" /><path d="m3 12 9 5 9-5" /></>,
  metric: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  table: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M9 4v16" /></>,
  star: <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  verified: <><path d="M12 2 4 6v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6l-8-4Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  refresh: <><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" /></>,
  expand: <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />,
  shrink: <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />,
  external: <><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  download: <><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  play: <path d="M7 4v16l13-8L7 4Z" />,
  trash: <><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></>,
  more: <><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  bell: <><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10 21a2 2 0 0 0 4 0" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
  hash: <path d="M5 9h14M5 15h14M10 3 8 21M16 3l-2 18" />,
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronLeft: <path d="m15 6-6 6 6 6" />,
  sql: <><path d="m8 8-4 4 4 4" /><path d="m16 8 4 4-4 4" /><path d="m14 4-4 16" /></>,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="M20 6 9 17l-5-5" />,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></>,
  wand: <><path d="m3 21 12-12" /><path d="M15 4V2M15 10V8M9 15H7M21 15h-2M18 5l-1.5 1.5" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  text: <path d="M5 6h14M12 6v13M9 19h6" />,
  toggle: <><rect x="2" y="7" width="20" height="10" rx="5" /><circle cx="16" cy="12" r="3" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3" /></>,
  sync: <><path d="M4 12a8 8 0 0 1 14-5.3L20 9" /><path d="M20 4v5h-5" /><path d="M20 12a8 8 0 0 1-14 5.3L4 15" /><path d="M4 20v-5h5" /></>,
  warning: <><path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4M12 17v.5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>,
  pin: <><path d="M12 17v5" /><path d="M9 3h6l-1 6 4 4H6l4-4-1-6Z" /></>,
  move: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /><path d="M10 13h6M13 10l3 3-3 3" /></>,
  save: <><path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M7 3v6h8M7 21v-7h10v7" /></>,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>,
  send: <><path d="M22 2 11 13" /><path d="m22 2-7 20-4-9-9-4 20-7Z" /></>,
  map: <><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" /><path d="M9 4v14M15 6v14" /></>,
  slack: <><rect x="10" y="2" width="4" height="9" rx="2" /><rect x="10" y="13" width="4" height="9" rx="2" /><rect x="2" y="10" width="9" height="4" rx="2" /><rect x="13" y="10" width="9" height="4" rx="2" /></>,
  bar: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  line: <path d="m3 17 6-6 4 4 8-8" />,
  pie: <><path d="M12 3a9 9 0 1 0 9 9h-9V3Z" /><path d="M15 3.5A9 9 0 0 1 20.5 9H15V3.5Z" /></>,
  scalar: <path d="M7 5v14M4 8l3-3M12 19h8M16 5v14" />,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" /></>,
} as const

export type IconName = keyof typeof P

export function Icon({ name, size = 16, className, filled }: { name: IconName; size?: number; className?: string; filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn('shrink-0', className)}
    >
      {P[name]}
    </svg>
  )
}

/** Icon for a Metabase display type. */
export function displayIcon(display?: string | null): IconName {
  switch (display) {
    case 'line':
    case 'area':
    case 'smartscalar':
    case 'waterfall':
    case 'combo':
      return 'line'
    case 'bar':
    case 'row':
    case 'funnel':
      return 'bar'
    case 'pie':
      return 'pie'
    case 'scalar':
    case 'progress':
    case 'gauge':
      return 'scalar'
    case 'map':
      return 'map'
    default:
      return 'table'
  }
}

/** Card kind badge: question / model / metric. */
export function cardTypeIcon(type?: string): IconName {
  return type === 'model' ? 'model' : type === 'metric' ? 'metric' : 'question'
}

/* ─────────── small controls ─────────── */

export function IconButton({
  icon,
  label,
  onClick,
  active,
  disabled,
  className,
  filled,
}: {
  icon: IconName
  label: string
  onClick?(e: React.MouseEvent): void
  active?: boolean
  disabled?: boolean
  className?: string
  filled?: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-surface-sunken hover:text-content disabled:pointer-events-none disabled:opacity-40',
        active && 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300',
        className,
      )}
    >
      <Icon name={icon} filled={filled} />
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'sm',
  ariaLabel,
}: {
  value: T
  onChange(v: T): void
  options: { value: T; label: ReactNode; title?: string; disabled?: boolean }[]
  size?: 'xs' | 'sm'
  ariaLabel?: string
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex max-w-full overflow-x-auto rounded-lg border border-edge-default bg-surface-sunken p-0.5 [scrollbar-width:none]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:opacity-40',
            size === 'xs' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
            value === o.value ? 'bg-surface-raised text-content shadow-sm ring-1 ring-edge-default' : 'text-content-muted hover:text-content',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A popover menu anchored to its trigger. */
export function Menu({
  trigger,
  items,
  align = 'right',
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode
  items: Array<{ label: string; icon?: IconName; onSelect(): void; danger?: boolean; disabled?: boolean; hint?: string } | 'sep'>
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useClickOutside(ref, () => setOpen(false), open, { escape: true })
  return (
    <div ref={ref} className="relative">
      {trigger(open, () => setOpen((o) => !o))}
      {open ? (
        <div
          role="menu"
          className={cn(
            'absolute top-full z-40 mt-1 min-w-48 overflow-hidden rounded-lg border border-edge-default bg-surface-raised py-1 shadow-xl',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((it, i) =>
            it === 'sep' ? (
              <div key={`sep-${i}`} className="my-1 border-t border-edge-subtle" />
            ) : (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                title={it.hint}
                onClick={() => {
                  setOpen(false)
                  it.onSelect()
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-sunken disabled:pointer-events-none disabled:opacity-40',
                  it.danger ? 'text-rose-700 dark:text-rose-300' : 'text-content',
                )}
              >
                {it.icon ? <Icon name={it.icon} size={14} className="text-content-subtle" /> : null}
                {it.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  )
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm(): void
  onClose(): void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="text-sm text-content-muted">{body}</div>
    </Modal>
  )
}

/* ─────────── collections ─────────── */

export interface FlatCollection {
  id: number | 'root'
  name: string
  depth: number
  personal: boolean
  official: boolean
  path: string
}

/** Depth-first flattening of the collection tree, root first, personal collections last. */
export function flattenCollections(tree: metabase.MbCollectionNode[] | undefined, userId?: number): FlatCollection[] {
  const out: FlatCollection[] = [{ id: 'root', name: 'Our analytics', depth: 0, personal: false, official: false, path: 'Our analytics' }]
  const walk = (nodes: metabase.MbCollectionNode[], depth: number, path: string) => {
    const sorted = [...nodes].sort((a, b) => {
      const pa = a.personal_owner_id != null ? 1 : 0
      const pb = b.personal_owner_id != null ? 1 : 0
      return pa - pb || a.name.localeCompare(b.name)
    })
    for (const n of sorted) {
      if (n.archived) continue
      // Other people's personal collections are admin clutter here.
      if (n.personal_owner_id != null && userId != null && n.personal_owner_id !== userId) continue
      const p = `${path} / ${n.name}`
      out.push({ id: n.id, name: n.name, depth, personal: n.personal_owner_id != null, official: n.authority_level === 'official', path: p })
      if (n.children?.length) walk(n.children, depth + 1, p)
    }
  }
  walk(tree ?? [], 1, 'Our analytics')
  return out
}

export function CollectionSelect({
  collections,
  value,
  onChange,
  id,
}: {
  collections: FlatCollection[]
  value: number | 'root'
  onChange(v: number | 'root'): void
  id?: string
}) {
  return (
    <select
      id={id}
      value={String(value)}
      onChange={(e) => onChange(e.target.value === 'root' ? 'root' : Number(e.target.value))}
      className="w-full rounded-md border border-edge-default bg-surface-raised px-3 py-2 text-sm text-content shadow-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
    >
      {collections.map((c) => (
        <option key={String(c.id)} value={String(c.id)}>
          {' '.repeat(c.depth)}
          {c.name}
          {c.personal ? ' (personal)' : ''}
        </option>
      ))}
    </select>
  )
}

/** `collection_id` for the API: the root collection is `null`. */
export function collectionIdForApi(v: number | 'root'): number | null {
  return v === 'root' ? null : v
}

/* ─────────── fullscreen ─────────── */

/** Renders children over the whole viewport when `on`, with Esc to leave. */
export function FullscreenPortal({ on, onExit, children }: { on: boolean; onExit(): void; children: ReactNode }) {
  useEffect(() => {
    if (!on) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [on, onExit])
  if (!on || typeof document === 'undefined') return <>{children}</>
  return createPortal(<div className="bi-fullscreen">{children}</div>, document.body)
}

/** A thin labelled meta row item. */
export function Meta({ icon, children, title }: { icon?: IconName; children: ReactNode; title?: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1 text-[12px] text-content-muted">
      {icon ? <Icon name={icon} size={13} className="text-content-subtle" /> : null}
      {children}
    </span>
  )
}

export function VerifiedBadge({ compact }: { compact?: boolean }) {
  return (
    <span
      title="Verified in Metabase"
      className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800 ring-1 ring-inset ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-200 dark:ring-sky-400/25"
    >
      <Icon name="verified" size={11} />
      {compact ? null : 'Verified'}
    </span>
  )
}

export function OfficialBadge() {
  return (
    <span
      title="Official collection"
      className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900 ring-1 ring-inset ring-amber-600/25 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-400/25"
    >
      <Icon name="verified" size={11} />
      Official
    </span>
  )
}
