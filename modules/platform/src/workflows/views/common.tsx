import { type ReactNode, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { DrawerWidenButton, EmptyState, StatusBadge, type StatusKind, useDrawerWidth, useOverlayDismiss } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { Scope } from '../data/hooks.ts'
import { isFinished, phaseLabel, runStatus, type Workflow } from '../data/nodes.ts'

/**
 * Pieces every Workflows page uses: the phase badge, the four page states
 * (not installed / not allowed / empty / failed — each in its own words), the
 * drawer, and the scope line. No @xyflow here (chunks_test.ts).
 */

export function RunPhase({ run }: { run: Workflow }) {
  const kind = runStatus(run)
  return <StatusBadge kind={kind} pulse={!isFinished(run) && kind === 'progressing'}>{phaseLabel(run)}</StatusBadge>
}

export function PhaseBadge({ phase }: { phase: string }) {
  const kind: StatusKind = phase === 'Succeeded' ? 'healthy' : phase === 'Failed' || phase === 'Error' ? 'failed' : phase === 'Running' || phase === 'Pending' ? 'progressing' : 'unknown'
  return <StatusBadge kind={kind}>{phase}</StatusBadge>
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-content-subtle" aria-busy="true">
      <span className="inline-block size-3 animate-spin rounded-full border-2 border-edge-strong border-t-transparent" />
      {label}
    </div>
  )
}

export function ErrorNote({ title, error }: { title: string; error: unknown }) {
  const detail = error instanceof Error ? error.message : String(error ?? '')
  return <EmptyState compact tone="error" title={title} description={detail} />
}

export function ForbiddenNote({ what, namespaces }: { what: string; namespaces?: readonly string[] }) {
  return (
    <EmptyState
      compact
      title={`You cannot read ${what} here`}
      description={namespaces?.length ? `Your Kubernetes RBAC refuses ${what} in ${namespaces.join(', ')}. Ask a team admin to add you to the project's team.` : `Your Kubernetes RBAC refuses ${what} in this scope.`}
    />
  )
}

/** "Showing N namespaces" with the ones RBAC refused called out — partial, not empty. */
export function ScopeLine({ scope, mode, denied }: { scope: Scope; mode?: 'cluster' | 'namespaces'; denied?: readonly string[] }) {
  const n = scope.namespaces.length
  const text = mode === 'cluster' && !scope.only
    ? 'All namespaces you can read'
    : scope.only
    ? `Namespace ${scope.only}`
    : n
    ? `${n} namespace${n === 1 ? '' : 's'}: ${scope.namespaces.slice(0, 4).map((s) => s.namespace).join(', ')}${n > 4 ? `, +${n - 4}` : ''}`
    : 'No project namespaces found for you yet'
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-content-subtle">
      <span>{text}</span>
      {denied?.length ? <span className="text-amber-700 dark:text-amber-300">Not readable: {denied.join(', ')}</span> : null}
    </div>
  )
}

/** The console's side drawer: portalled to body, Esc + focus trap, widen mode. */
export function Drawer({ title, eyebrow, badge, actions, widthKey, onClose, children }: {
  title: ReactNode
  eyebrow?: ReactNode
  badge?: ReactNode
  actions?: ReactNode
  widthKey: string
  onClose(): void
  children: ReactNode
}) {
  const width = useDrawerWidth(widthKey, { base: 'max-w-5xl' })
  const panelRef = useRef<HTMLElement>(null)
  const titleId = useId()
  useOverlayDismiss(true, onClose, { focusRef: panelRef })
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/50" onClick={onClose} />
      <aside ref={panelRef} tabIndex={-1} className={cn('relative flex h-full w-full flex-col border-l border-edge-default bg-surface-app shadow-2xl outline-none', width.className)}>
        <header className="flex shrink-0 flex-wrap items-start gap-x-3 gap-y-2 border-b border-edge-default bg-surface-raised px-4 py-3 sm:px-5">
          <div className="min-w-[12rem] flex-1">
            {eyebrow ? <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">{eyebrow}</div> : null}
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 id={titleId} className="min-w-0 truncate text-[15px] font-semibold text-content">{title}</h2>
              {badge}
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {actions}
            <DrawerWidenButton wide={width.wide} onToggle={width.toggle} />
            <button type="button" onClick={onClose} aria-label="Close" className="flex size-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content">
              ✕
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>,
    document.body,
  )
}

/** A run reference in the URL: `<namespace>/<name>`. */
export function parseRunRef(ref: string | undefined): { namespace: string; name: string } | undefined {
  if (!ref) return undefined
  const i = ref.indexOf('/')
  if (i <= 0 || i === ref.length - 1) return undefined
  return { namespace: ref.slice(0, i), name: ref.slice(i + 1) }
}

export function KpiCard({ label, value, hint, tone, onClick }: { label: string; value: ReactNode; hint?: string; tone?: 'default' | 'warn' | 'bad' | 'good'; onClick?(): void }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'flex flex-col items-start rounded-xl border border-edge-default bg-surface-raised p-4 text-left shadow-sm',
        onClick && 'transition-colors hover:border-edge-strong',
      )}
    >
      <span className="text-xs font-medium text-content-subtle">{label}</span>
      <span
        className={cn(
          'mt-1 text-2xl font-semibold tabular-nums',
          tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : 'text-content',
        )}
      >
        {value}
      </span>
      {hint ? <span className="mt-0.5 text-[11px] text-content-subtle">{hint}</span> : null}
    </Tag>
  )
}

export function Section({ title, actions, children, className }: { title: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('space-y-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-content">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  )
}
