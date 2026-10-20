import { type ReactNode, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Spinner } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { Severity } from '../../data/security-findings.ts'
import type { GateState, WaiverStatus } from '../../data/security-types.ts'

/** Severity colours, shared by every security view (light + dark). */
export const SEV_TONE: Record<Severity, { chip: string; fill: string; text: string }> = {
  critical: {
    chip: 'bg-rose-100 text-rose-900 ring-rose-600/20 dark:bg-rose-500/15 dark:text-rose-200',
    fill: 'bg-rose-600',
    text: 'text-rose-700 dark:text-rose-300',
  },
  high: {
    chip: 'bg-orange-100 text-orange-900 ring-orange-600/20 dark:bg-orange-500/15 dark:text-orange-200',
    fill: 'bg-orange-500',
    text: 'text-orange-700 dark:text-orange-300',
  },
  medium: {
    chip: 'bg-amber-100 text-amber-900 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-200',
    fill: 'bg-amber-500',
    text: 'text-amber-700 dark:text-amber-300',
  },
  low: {
    // Surface tokens, not the slate ramp: slate flips with the theme and the
    // dark: variant on top of it left the chip unreadable on dark surfaces.
    chip: 'bg-surface-sunken text-content-muted ring-edge-default',
    fill: 'bg-slate-400',
    text: 'text-content-muted',
  },
  unknown: {
    chip: 'bg-surface-sunken text-content-muted ring-edge-subtle',
    fill: 'bg-slate-300 dark:bg-slate-600',
    text: 'text-content-subtle',
  },
}

export function SevChip({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ring-1 ring-inset', SEV_TONE[severity].chip, className)}>
      {severity}
    </span>
  )
}

const STATUS_TONE: Record<WaiverStatus, string> = {
  requested: 'bg-indigo-50 text-indigo-800 ring-indigo-600/20 dark:bg-indigo-500/15 dark:text-indigo-200',
  approved: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-200',
  rejected: 'bg-rose-50 text-rose-800 ring-rose-600/20 dark:bg-rose-500/15 dark:text-rose-200',
  expired: 'bg-surface-sunken text-content-muted ring-edge-subtle',
  revoked: 'bg-surface-sunken text-content-muted ring-edge-subtle',
}

const STATUS_LABEL: Record<WaiverStatus, string> = {
  requested: 'Pending review',
  approved: 'Active',
  rejected: 'Rejected',
  expired: 'Expired',
  revoked: 'Revoked',
}

export function WaiverStatusChip({ status, expiringSoon }: { status: WaiverStatus; expiringSoon?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset',
        expiringSoon && status === 'approved'
          ? 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-200'
          : STATUS_TONE[status],
      )}
    >
      {expiringSoon && status === 'approved' ? 'Expiring soon' : STATUS_LABEL[status]}
    </span>
  )
}

const GATE_TONE: Record<GateState, { label: string; cls: string }> = {
  awaiting: { label: 'Awaiting approval', cls: 'bg-indigo-50 text-indigo-800 ring-indigo-600/20 dark:bg-indigo-500/15 dark:text-indigo-200' },
  approved: { label: 'Approved', cls: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-200' },
  rejected: { label: 'Rejected', cls: 'bg-rose-50 text-rose-800 ring-rose-600/20 dark:bg-rose-500/15 dark:text-rose-200' },
  passed: { label: 'Gate passed', cls: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-200' },
  failed: { label: 'Gate failed', cls: 'bg-rose-50 text-rose-800 ring-rose-600/20 dark:bg-rose-500/15 dark:text-rose-200' },
  warned: { label: 'Passed with warnings', cls: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-200' },
  none: { label: 'No gate', cls: 'bg-surface-sunken text-content-muted ring-edge-subtle' },
}

export function GateChip({ state }: { state: GateState }) {
  const t = GATE_TONE[state]
  return <span className={cn('inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset', t.cls)}>{t.label}</span>
}

/** Small count tile; clickable when it filters something. */
export function Tile({
  label,
  value,
  hint,
  tone,
  active,
  onClick,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: string
  active?: boolean
  onClick?(): void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-pressed={onClick ? Boolean(active) : undefined}
      className={cn(
        'min-w-0 rounded-xl border px-3.5 py-3 text-left transition-colors',
        active ? 'border-brand-300 bg-brand-50/70 dark:border-brand-500/40 dark:bg-brand-500/10' : 'border-edge-default bg-surface-raised',
        onClick ? 'hover:border-edge-strong' : 'cursor-default',
      )}
    >
      <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</div>
      <div className={cn('mt-1 text-2xl font-semibold leading-none tabular-nums', tone ?? 'text-content')}>{value}</div>
      {hint ? <div className="mt-1 truncate text-[11px] text-content-subtle">{hint}</div> : null}
    </button>
  )
}

/** An honest, inline notice about what the platform can or cannot do yet. */
export function Notice({ tone = 'info', title, children, action }: { tone?: 'info' | 'warn' | 'error'; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const cls = {
    info: 'border-sky-200 bg-sky-50/70 text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100',
    warn: 'border-amber-200 bg-amber-50/70 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100',
    error: 'border-rose-200 bg-rose-50/70 text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100',
  }[tone]
  return (
    <div role="status" className={cn('flex flex-wrap items-start gap-x-4 gap-y-2 rounded-xl border px-4 py-3 text-[13px]', cls)}>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        {children ? <div className="mt-0.5 text-[12px] opacity-90">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

/** Right-hand drawer (full width on phones), ESC to close. */
export function Drawer({
  onClose,
  eyebrow,
  title,
  subtitle,
  actions,
  children,
}: {
  onClose(): void
  eyebrow?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (k: KeyboardEvent) => {
      if (k.key === 'Escape') onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="border-b border-edge-default bg-surface-raised px-4 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {eyebrow ? <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">{eyebrow}</div> : null}
              <h2 className="mt-1 break-words text-lg font-semibold tracking-tight text-content">{title}</h2>
              {subtitle ? <div className="mt-1 text-[12px] text-content-muted">{subtitle}</div> : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
            >
              ✕
            </button>
          </div>
          {actions ? <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6">{children}</div>
      </aside>
    </div>,
    document.body,
  )
}

export function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

export function KV({ rows }: { rows: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(90px,max-content)_1fr] gap-x-4 gap-y-1.5 text-[12px]">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-content-subtle">{k}</dt>
          <dd className="min-w-0 break-words text-content">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export const shortDigest = (d?: string) => (d ? d.replace(/^sha256:/, '').slice(0, 12) : '')

export const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—')

export const fmtDateTime = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')

/** A plain table wrapper that scrolls sideways inside itself on phones. */
export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-edge-default bg-surface-raised">
      <table className="w-full min-w-[640px] text-left">{children}</table>
    </div>
  )
}

export const TH = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-content-subtle'
export const TD = 'px-3 py-2.5 align-top text-[12px]'

/** Trigger a client-side download (CSV export). */
export function download(name: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function Loading({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted">
      <Spinner size={14} /> {text}
    </div>
  )
}

/** Why there are no runtime findings, when the reason is not "nothing found". */
export function ReportStateNotice({ state, detail }: { state: 'ok' | 'absent' | 'forbidden' | 'error'; detail?: string }) {
  if (state === 'absent') {
    return (
      <Notice tone="warn" title="trivy-operator is not installed">
        Runtime findings come from trivy-operator's VulnerabilityReports, and the cluster does not serve that resource. Image scans from Harbor are on the Images tab.
      </Notice>
    )
  }
  if (state === 'forbidden') {
    return (
      <Notice tone="warn" title="No permission to read vulnerability reports">
        Your account may not list trivy-operator's reports. Ask a platform admin for read access to <code>vulnerabilityreports.aquasecurity.github.io</code>.
      </Notice>
    )
  }
  if (state === 'error') return <Notice tone="error" title="Couldn't read vulnerability reports">{detail ?? 'The cluster did not answer.'}</Notice>
  return null
}
