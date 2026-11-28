import type { ReactNode } from 'react'
import { cn } from '@adhar/utils'

/**
 * The designer's toolbar (design 0026 §6.8): undo / redo, auto-layout, fit,
 * zoom, validate (with a count), the YAML toggle, test run (dev only) and
 * publish. Every keyboard shortcut has its button here; the shortcut is in the
 * button's title and its accessible name.
 */

export interface ToolbarProps {
  canUndo: boolean
  canRedo: boolean
  editable: boolean
  yamlOpen: boolean
  problems: { errors: number; warnings: number }
  validating: boolean
  /** Why a test run is not offered (null: it is). */
  testRunBlocked: string | null
  save: { label: string; disabled: boolean }
  /** "Convert to DAG" / "Wrap in a DAG", when the graph is read-only for that reason. */
  repair?: { label: string; onClick(): void }
  onUndo(): void
  onRedo(): void
  onLayout(): void
  onFit(): void
  onZoomIn(): void
  onZoomOut(): void
  onValidate(): void
  onToggleYaml(): void
  onSave(): void
  onTestRun(): void
  onHelp(): void
}

function Tool({ label, keys, onClick, disabled, active, children, className }: { label: string; keys?: string; onClick(): void; disabled?: boolean; active?: boolean; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={keys ? `${label} (${keys})` : label}
      aria-pressed={active}
      title={keys ? `${label} — ${keys}` : label}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-content-muted hover:bg-surface-sunken hover:text-content disabled:cursor-not-allowed disabled:opacity-40',
        active && 'bg-surface-sunken text-content',
        className,
      )}
    >
      {children}
    </button>
  )
}

const I = (d: string) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>

export function Toolbar(p: ToolbarProps) {
  const problems = p.problems.errors + p.problems.warnings
  return (
    <div role="toolbar" aria-label="Designer" className="flex flex-wrap items-center gap-0.5 rounded-xl border border-edge-default bg-surface-raised px-1.5 py-1">
      <Tool label="Undo" keys="⌘Z" onClick={p.onUndo} disabled={!p.canUndo}>{I('M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3')}</Tool>
      <Tool label="Redo" keys="⇧⌘Z" onClick={p.onRedo} disabled={!p.canRedo}>{I('m15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h3')}</Tool>
      <span aria-hidden className="mx-1 h-5 w-px bg-edge-subtle" />
      <Tool label="Auto-layout" keys="l" onClick={p.onLayout} disabled={!p.editable}>{I('M4 4h6v6H4zM14 14h6v6h-6zM10 7h4a3 3 0 0 1 3 3v4')}<span className="hidden lg:inline">Layout</span></Tool>
      <Tool label="Fit" keys="f" onClick={p.onFit}>{I('M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5')}</Tool>
      <Tool label="Zoom in" onClick={p.onZoomIn}>{I('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5M8 11h6M11 8v6')}</Tool>
      <Tool label="Zoom out" onClick={p.onZoomOut}>{I('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5M8 11h6')}</Tool>
      <span aria-hidden className="mx-1 h-5 w-px bg-edge-subtle" />
      <Tool label={`Validate${problems ? `: ${p.problems.errors} errors, ${p.problems.warnings} warnings` : ''}`} onClick={p.onValidate} disabled={p.validating}>
        {I('m5 12 5 5 9-10')}
        <span>{p.validating ? 'Validating…' : 'Validate'}</span>
        {problems ? <span className={cn('rounded-full px-1.5 text-[10px] font-semibold', p.problems.errors ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300' : 'bg-amber-500/15 text-amber-800 dark:text-amber-300')}>{problems}</span> : null}
      </Tool>
      <Tool label="YAML" onClick={p.onToggleYaml} active={p.yamlOpen}>{I('m8 6-6 6 6 6M16 6l6 6-6 6')}<span>YAML</span></Tool>
      {p.repair ? <Tool label={p.repair.label} onClick={p.repair.onClick} className="text-brand-700 dark:text-brand-300">{p.repair.label}</Tool> : null}
      <Tool label="Keyboard shortcuts" onClick={p.onHelp}>{I('M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8')}</Tool>
      <span className="flex-1" />
      <Tool label={p.save.label} keys="⌘S" onClick={p.onSave} disabled={p.save.disabled}>{I('M5 3h11l3 3v15H5zM8 3v5h8V3M8 21v-7h8v7')}<span className="hidden md:inline">{p.save.label}</span></Tool>
      <button
        type="button"
        onClick={p.onTestRun}
        disabled={p.testRunBlocked !== null}
        aria-label={`Test run in a dev namespace (⌘↵)${p.testRunBlocked ? `: ${p.testRunBlocked}` : ''}`}
        title={p.testRunBlocked ?? 'Save as a draft in a dev namespace and run it — ⌘↵'}
        className="ml-1 inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-[12px] font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {I('M7 4v16l13-8z')}
        Test run
      </button>
      <button
        type="button"
        disabled
        aria-label="Publish (arrives with GitOps publishing)"
        title="Publishing to Git arrives with the next phase (W3): until then a template reaches the cluster through its app or project repository."
        className="ml-1 inline-flex h-8 items-center rounded-lg border border-edge-default px-3 text-[12px] font-medium text-content-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        Publish
      </button>
    </div>
  )
}
