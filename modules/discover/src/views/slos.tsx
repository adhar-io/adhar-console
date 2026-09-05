import {
  AreaChart,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PrometheusIcon,
  StatusBadge,
} from '@adhar-console/shell-ui'
import type { lgtm } from '@adhar-console/api-clients'
import { useSlos } from '../data/observability.ts'
import { LoadingCard, SourceError } from './states.tsx'

/**
 * SLOs — service-level objectives with current performance, error budget,
 * 1h/6h burn-rate, and a 28-day trend chart per objective.
 */
export function Slos() {
  const q = useSlos()

  if (q.isLoading) return <LoadingCard label="Loading SLOs…" />
  if (q.isError) {
    return <SourceError tool="Prometheus" error={q.error} onRetry={() => q.refetch()} icon={<PrometheusIcon size={20} />} />
  }
  const list = q.data ?? []
  if (list.length === 0) {
    return <EmptyState title="No SLOs configured" description="Define one in Pyrra or Sloth to populate this list." />
  }

  const burning = list.filter((s) => s.errorBudgetRemaining < 0.5).length
  const meeting = list.filter((s) => s.current >= s.objective).length

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Total" value={list.length} />
        <Tile label="Meeting" value={meeting} accent="emerald" />
        <Tile label="Burning" value={burning} accent={burning > 0 ? 'rose' : 'slate'} />
        <Tile
          label="Min budget"
          value={`${Math.min(...list.map((s) => s.errorBudgetRemaining * 100)).toFixed(0)}%`}
          accent="amber"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {list.map((s) => (
          <SloCard key={s.name} slo={s} />
        ))}
      </div>
    </div>
  )
}

function SloCard({ slo: s }: { slo: lgtm.Slo }) {
  const meeting = s.current >= s.objective
  const tone = meeting ? 'healthy' : 'failed'
  const burnTone =
    s.burnRate6h >= 6 ? 'failed' : s.burnRate6h >= 2 ? 'progressing' : 'healthy'
  const budgetTone =
    s.errorBudgetRemaining < 0 ? 'failed' : s.errorBudgetRemaining < 0.5 ? 'progressing' : 'healthy'
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-content">{s.name}</div>
            <div className="text-[11px] text-content-subtle">
              {s.indicator} · service {s.service}
            </div>
          </div>
          <StatusBadge kind={tone}>
            {meeting ? 'on target' : 'below target'}
          </StatusBadge>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label="Current" value={`${s.current.toFixed(2)}%`} accent={meeting ? 'emerald' : 'rose'} />
          <Stat label="Objective" value={`${s.objective}%`} />
          <Stat
            label="Budget left"
            value={`${(s.errorBudgetRemaining * 100).toFixed(0)}%`}
            accent={
              budgetTone === 'failed' ? 'rose' : budgetTone === 'progressing' ? 'amber' : 'emerald'
            }
          />
        </div>

        <div>
          <div className="mb-1 flex items-baseline justify-between text-[11px]">
            <span className="font-semibold text-content-subtle">Adherence · {s.window}d</span>
            <span className="font-mono tabular-nums text-content-muted">
              min {Math.min(...s.history).toFixed(2)}%
            </span>
          </div>
          <AreaChart
            points={s.history}
            color={meeting ? 'var(--color-emerald-500)' : 'var(--color-rose-500)'}
            height={56}
            showAxis={false}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <BurnPill window="1h" rate={s.burnRate1h} tone={s.burnRate1h >= 6 ? 'failed' : s.burnRate1h >= 2 ? 'progressing' : 'healthy'} />
          <BurnPill window="6h" rate={s.burnRate6h} tone={burnTone} />
        </div>
      </CardBody>
    </Card>
  )
}

function Stat({
  label,
  value,
  accent = 'slate',
}: {
  label: string
  value: string
  accent?: 'slate' | 'emerald' | 'amber' | 'rose'
}) {
  const tone = {
    slate: 'text-content',
    emerald: 'text-emerald-700',
    amber: 'text-amber-700',
    rose: 'text-rose-700',
  }[accent]
  return (
    <div className="rounded-md border border-edge-subtle bg-surface-sunken/40 p-2">
      <div className={`text-base font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
    </div>
  )
}

function Tile({
  label,
  value,
  accent = 'slate',
}: {
  label: string
  value: string | number
  accent?: 'slate' | 'emerald' | 'rose' | 'amber'
}) {
  const cls = {
    slate: 'from-slate-50 to-surface-raised text-content',
    emerald: 'from-emerald-50 dark:from-emerald-500/10 to-surface-raised text-emerald-700 dark:text-emerald-300',
    rose: 'from-rose-50 dark:from-rose-500/10 to-surface-raised text-rose-700 dark:text-rose-300',
    amber: 'from-amber-50 dark:from-amber-500/10 to-surface-raised text-amber-700 dark:text-amber-300',
  }[accent]
  return (
    <Card className={`bg-linear-to-br ${cls} ring-1 ring-inset ring-edge-subtle`}>
      <CardBody className="p-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
          {label}
        </div>
        <div className="text-3xl font-semibold tabular-nums tracking-tight text-content">
          {value}
        </div>
      </CardBody>
    </Card>
  )
}

function BurnPill({
  window,
  rate,
  tone,
}: {
  window: string
  rate: number
  tone: 'healthy' | 'progressing' | 'failed'
}) {
  const cls = {
    healthy: 'bg-emerald-50 text-emerald-700',
    progressing: 'bg-amber-50 text-amber-700',
    failed: 'bg-rose-50 text-rose-700',
  }[tone]
  return (
    <div className={`flex items-center justify-between rounded-md px-2.5 py-1.5 text-[12px] ${cls}`}>
      <span className="font-mono">{window}</span>
      <span className="font-mono font-semibold tabular-nums">{rate.toFixed(1)}× burn</span>
    </div>
  )
}
