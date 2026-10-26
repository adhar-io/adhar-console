import { type ReactNode } from 'react'
import { Badge, Button, StatusBadge, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { GateVerdict, MetricDelta } from '../data/perf-gate.ts'
import { fmtMetric, type MetricKey, missingNote, type Trigger } from '../data/perf-results.ts'

/** Small pieces the Performance Center's automation views share. */

/**
 * One metric of a run, formatted the way every table formats it — and an
 * unrecorded p99 as "not recorded" with the reason on hover, never a bare dash.
 */
export function MetricValue({ k, m, className }: { k: MetricKey; m: Partial<Record<MetricKey, number>> | undefined; className?: string }) {
  const note = missingNote(k, m)
  if (note) {
    return (
      <span title={note} className={cn('cursor-help border-b border-dotted border-content-subtle text-content-subtle', className)}>
        not recorded
      </span>
    )
  }
  return <span className={className}>{fmtMetric(k, m?.[k])}</span>
}

export function VerdictBadge({ verdict, compact }: { verdict: GateVerdict; compact?: boolean }) {
  const title = verdict.failures.length
    ? verdict.failures.map((f) => `${f.label}: ${f.detail}`).join('\n')
    : verdict.checks.map((c) => `${c.label}: ${c.detail}`).join('\n')
  if (verdict.status === 'no-data') {
    return <span title="The runner printed no end-of-test summary"><StatusBadge kind="unknown">no data</StatusBadge></span>
  }
  return (
    <span title={title}>
      <StatusBadge kind={verdict.status === 'pass' ? 'healthy' : 'failed'}>
        {verdict.status === 'pass'
          ? 'passed'
          : compact || verdict.failures.length !== 1
          ? `failed${verdict.failures.length > 1 ? ` · ${verdict.failures.length}` : ''}`
          : `failed · ${verdict.failures[0].label}`}
      </StatusBadge>
    </span>
  )
}

/** The worst regression against the baseline, in one badge. */
export function RegressionBadge({ deltas, isBaseline }: { deltas: MetricDelta[]; isBaseline?: boolean }) {
  if (isBaseline) return <Badge tone="brand">baseline</Badge>
  if (!deltas.length) return <span className="text-[11px] text-content-subtle">within tolerance</span>
  const worst = [...deltas].sort((a, b) => Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0))[0]
  const pct = worst.deltaPct
  return (
    <span
      title={deltas.map((d) => `${d.label}: ${fmtMetric(d.key, d.current)} vs baseline ${fmtMetric(d.key, d.baseline)}`).join('\n')}
    >
      <Badge tone="rose">
        ▲ {worst.label.replace(' latency', '')} {pct !== undefined ? `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%` : ''}
        {deltas.length > 1 ? ` +${deltas.length - 1}` : ''}
      </Badge>
    </span>
  )
}

const TRIGGER_TONE: Record<Trigger, 'slate' | 'brand' | 'violet' | 'sky'> = {
  console: 'slate',
  manual: 'sky',
  schedule: 'brand',
  ci: 'violet',
}

export function TriggerBadge({ trigger, schedule }: { trigger: Trigger; schedule?: string }) {
  return (
    <span title={schedule ? `schedule ${schedule}` : undefined}>
      <Badge tone={TRIGGER_TONE[trigger]}>{trigger === 'ci' ? 'CI' : trigger}</Badge>
    </span>
  )
}

/** A headline number. */
export function Tile({
  label,
  value,
  hint,
  tone,
  loading,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: 'bad' | 'good' | 'busy'
  loading?: boolean
}) {
  return (
    <div className="min-w-0 rounded-xl border border-edge-default bg-surface-raised px-3.5 py-3">
      <div className="truncate text-[11px] font-medium uppercase tracking-wide text-content-subtle">{label}</div>
      <div
        className={cn(
          'mt-1 truncate text-xl font-semibold tabular-nums',
          tone === 'bad'
            ? 'text-rose-600 dark:text-rose-400'
            : tone === 'good'
            ? 'text-emerald-600 dark:text-emerald-400'
            : tone === 'busy'
            ? 'text-brand-700 dark:text-brand-300'
            : 'text-content',
        )}
      >
        {loading ? '—' : value}
      </div>
      {hint ? <div className="mt-0.5 truncate text-[11px] text-content-subtle">{hint}</div> : null}
    </div>
  )
}

/** A block of copyable configuration. */
export function Snippet({ title, hint, code }: { title: string; hint?: ReactNode; code: string }) {
  const toast = useToast()
  return (
    <div className="min-w-0 rounded-lg border border-edge-default">
      <div className="flex items-start gap-2 border-b border-edge-subtle px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold text-content">{title}</div>
          {hint ? <div className="text-[11px] text-content-muted">{hint}</div> : null}
        </div>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            navigator.clipboard.writeText(code).then(
              () => toast.success(`Copied ${title.toLowerCase()}`),
              (e: Error) => toast.error('Could not copy', { description: e.message }),
            )}
        >
          Copy
        </Button>
      </div>
      <pre className="max-h-80 overflow-auto bg-surface-sunken px-3 py-2 font-mono text-[11px] leading-relaxed text-content">
        {code}
      </pre>
    </div>
  )
}

/** A delta, coloured by whether it is good news for this metric. */
export function Delta({ pct, good }: { pct: number | undefined; good: boolean | undefined }) {
  if (pct === undefined || !Number.isFinite(pct)) return null
  const flat = Math.abs(pct) < 0.5
  return (
    <span
      className={cn(
        'text-[10px] tabular-nums',
        flat
          ? 'text-content-subtle'
          : good
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-rose-600 dark:text-rose-400',
      )}
    >
      {pct > 0 ? '+' : ''}
      {pct.toFixed(1)}%
    </span>
  )
}

/** Time axis labels for multi-day history. */
export function fmtDay(t: number): string {
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })
}
