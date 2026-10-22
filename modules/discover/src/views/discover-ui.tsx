import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DrawerWidenButton, useDrawerWidth, useOverlayDismiss } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'

/**
 * Small shared building blocks for the Traces / Alerts / SLOs views: a
 * segmented control, a side drawer, a stat tile, a section label and a
 * key/value table. Kept local to the module (not shell-ui) — they encode this
 * module's density, not a console-wide primitive.
 */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'sm',
  ariaLabel,
}: {
  value: T
  options: Array<{ id: NoInfer<T>; label: ReactNode; count?: number }>
  onChange(v: NoInfer<T>): void
  size?: 'xs' | 'sm'
  ariaLabel?: string
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-edge-default bg-surface-raised p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'inline-flex items-center gap-1 rounded-md font-medium transition-colors',
            size === 'xs' ? 'h-6 px-2 text-[11px]' : 'h-7 px-2.5 text-[12px]',
            value === o.id
              ? 'bg-surface-sunken text-content shadow-sm ring-1 ring-edge-default'
              : 'text-content-muted hover:text-content',
          )}
        >
          {o.label}
          {o.count !== undefined ? <span className="font-mono text-[10px] tabular-nums text-content-subtle">{o.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  badges,
  actions,
  width = 'max-w-4xl',
  widthId = 'discover.drawer',
  children,
}: {
  open: boolean
  onClose(): void
  title: ReactNode
  subtitle?: ReactNode
  badges?: ReactNode
  actions?: ReactNode
  /** The standard max width (`max-w-*`, no lg+ breakpoints). */
  width?: string
  /** Key the remembered wide-mode preference is stored under. */
  widthId?: string
  children: ReactNode
}) {
  useOverlayDismiss(open, onClose)
  const wide = useDrawerWidth(widthId, { base: width })
  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px] dark:bg-black/60" onClick={onClose} />
      <aside className={cn('relative flex h-full w-full flex-col overflow-hidden border-l border-edge-default bg-surface-canvas shadow-2xl', wide.className)}>
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-5 py-4">
          <div className="min-w-0">
            {badges ? <div className="flex flex-wrap items-center gap-2">{badges}</div> : null}
            <h2 className="mt-1 truncate text-base font-semibold tracking-tight text-content">{title}</h2>
            {subtitle ? <div className="mt-1 text-[11px] text-content-muted">{subtitle}</div> : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {actions}
            <DrawerWidenButton wide={wide.wide} onToggle={wide.toggle} />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
            >
              <IconClose />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>,
    document.body,
  )
}

export function StatTile({
  label,
  value,
  hint,
  tone,
  icon,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  /** Status tone — only for values that ARE a status; always paired with an icon + text. */
  tone?: 'ok' | 'warn' | 'bad'
  icon?: ReactNode
}) {
  const toneCls = tone === 'bad'
    ? 'text-rose-700 dark:text-rose-300'
    : tone === 'warn'
      ? 'text-amber-700 dark:text-amber-300'
      : tone === 'ok'
        ? 'text-emerald-700 dark:text-emerald-300'
        : 'text-content'
  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised px-4 py-3 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">{label}</div>
      <div className={cn('mt-1 flex items-center gap-1.5 text-2xl font-semibold tabular-nums tracking-tight', toneCls)}>
        {icon}
        {value}
      </div>
      {hint ? <div className="mt-0.5 truncate text-[11px] text-content-muted">{hint}</div> : null}
    </div>
  )
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{children}</div>
      {right}
    </div>
  )
}

export function KvTable({ rows, actions }: { rows: Array<[string, ReactNode]>; actions?(k: string): ReactNode }) {
  if (!rows.length) return <p className="text-[11px] text-content-subtle">None.</p>
  return (
    <div className="overflow-hidden rounded-lg border border-edge-subtle">
      <table className="w-full text-left text-[11px]">
        <tbody className="divide-y divide-edge-subtle">
          {rows.map(([k, v]) => (
            <tr key={k} className="group align-top hover:bg-surface-sunken/40">
              <td className="w-1/3 whitespace-nowrap px-3 py-1.5 font-mono text-content-muted">{k}</td>
              <td className="break-all px-3 py-1.5 font-mono text-content">{v}</td>
              {actions ? <td className="w-px whitespace-nowrap px-2 py-1 opacity-0 group-hover:opacity-100">{actions(k)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Panel({ title, right, children, className }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm', className)}>
      {title || right ? <SectionLabel right={right}>{title}</SectionLabel> : null}
      {children}
    </section>
  )
}

export function InlineHint({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-edge-subtle bg-surface-sunken/50 px-3 py-2 text-[11px] leading-relaxed text-content-muted">
      <IconInfo />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/* ─────────── status glyphs (always paired with a text label) ─────────── */

export const IconOk = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="m8 12 3 3 5-6" />
  </svg>
)
export const IconWarn = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </svg>
)
export const IconBad = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="m15 9-6 6" />
    <path d="m9 9 6 6" />
  </svg>
)
export const IconMute = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
    <path d="m2 2 20 20" />
  </svg>
)
export const IconPending = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
)
export const IconNoData = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12h8" />
  </svg>
)
export const IconInfo = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mt-0.5 shrink-0">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </svg>
)
export const IconClose = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
)
export const IconCopy = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)
export const IconExternal = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M7 17 17 7" />
    <path d="M7 7h10v10" />
  </svg>
)
export const IconChevronRight = ({ open = false }: { open?: boolean }) => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={cn('transition-transform', open && 'rotate-90')}>
    <path d="m9 6 6 6-6 6" />
  </svg>
)
export const IconPlus = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </svg>
)

/** Compact native select styled like the module's toolbars. */
export function MiniSelect({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: string
  onChange(v: string): void
  options: Array<[string, string]>
  label: string
  className?: string
}) {
  return (
    <select
      aria-label={label}
      title={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn('h-8 rounded-md border border-edge-default bg-surface-raised px-2 text-[12px] text-content focus:border-brand-400 focus:outline-none', className)}
    >
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  )
}

export function copyText(text: string) {
  try {
    void navigator.clipboard?.writeText(text)
  } catch {
    /* clipboard unavailable */
  }
}
