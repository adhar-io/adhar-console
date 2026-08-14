import { useState } from 'react'
import {
  AreaChart,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Sparkline,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { KpiCard } from './kpi-card.tsx'
import {
  formatDeployFreq,
  formatLeadTime,
  formatMttr,
  useDoraMetrics,
  type DoraTier,
  type DoraWindow,
  type ServiceDora,
} from '../data/dora.ts'

/**
 * Per-service DORA. Deploy frequency and change-failure rate are derived from
 * REAL ArgoCD deploy history (`/api/svc/argocd/api/v1/applications` →
 * `status.history[]` + `status.operationState`) by `useDoraMetrics`, and
 * classified against the standard DORA benchmarks. Lead time and MTTR are NOT
 * derivable from ArgoCD, so they render as "—" (needs a commit / incident
 * source) rather than fabricated numbers.
 */

const TIER_CLASS: Record<DoraTier, string> = {
  Elite: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  High: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  Medium: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  Low: 'bg-rose-50 text-rose-700 ring-rose-600/20',
}

const TIER_COLOR: Record<DoraTier, string> = {
  Elite: 'var(--color-brand-500)',
  High: 'var(--color-accent-500)',
  Medium: '#f59e0b',
  Low: '#f43f5e',
}

const TIER_ACCENT: Record<DoraTier, 'emerald' | 'indigo' | 'amber' | 'rose'> = {
  Elite: 'emerald',
  High: 'indigo',
  Medium: 'amber',
  Low: 'rose',
}

const TIER_TREND: Record<DoraTier, 'up' | 'flat' | 'down'> = {
  Elite: 'up',
  High: 'up',
  Medium: 'flat',
  Low: 'down',
}

function TierBadge({ tier }: { tier: DoraTier | null }) {
  if (!tier) {
    return (
      <span className="inline-flex items-center rounded-md bg-surface-sunken px-2 py-0.5 text-xs font-medium text-content-subtle ring-1 ring-inset ring-edge-subtle">
        —
      </span>
    )
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        TIER_CLASS[tier],
      )}
    >
      {tier}
    </span>
  )
}

const GRID = 'grid grid-cols-[1.2fr_0.6fr_repeat(4,0.8fr)_0.7fr] items-center gap-4'

function ServiceRow({ r, summary }: { r: ServiceDora; summary?: boolean }) {
  return (
    <div
      className={cn(
        GRID,
        'px-5 py-3 text-sm transition-colors',
        summary
          ? 'border-t-2 border-edge-default bg-surface-sunken/60 font-medium'
          : 'hover:bg-brand-50/30',
      )}
    >
      <div>
        <div className="font-medium text-content">{r.service}</div>
        <div className="text-[11px] text-content-subtle">
          {r.deploysWindow} deploys · {r.project}
        </div>
      </div>
      <div>
        <Sparkline points={r.deployTrend} color={TIER_COLOR[r.tier]} height={28} strokeWidth={1.75} />
      </div>
      <div className="text-right font-mono tabular-nums text-content">
        {formatDeployFreq(r.deployFrequency)}
      </div>
      <div className="text-right font-mono tabular-nums text-content-subtle" title="Not derivable from ArgoCD">
        {r.leadTimeHours == null ? '—' : formatLeadTime(r.leadTimeHours)}
      </div>
      <div className="text-right font-mono tabular-nums text-content-muted">
        {r.changeFailureRate == null ? '—' : `${(r.changeFailureRate * 100).toFixed(1)}%`}
      </div>
      <div className="text-right font-mono tabular-nums text-content-subtle" title="Not derivable from ArgoCD">
        {r.mttrHours == null ? '—' : formatMttr(r.mttrHours)}
      </div>
      <div className="text-right">
        <TierBadge tier={r.tier} />
      </div>
    </div>
  )
}

function WindowToggle({
  value,
  onChange,
}: {
  value: DoraWindow
  onChange(w: DoraWindow): void
}) {
  return (
    <div className="inline-flex rounded-lg border border-edge-default bg-surface-sunken/60 p-0.5 text-[11px] font-medium">
      {([30, 90] as DoraWindow[]).map((w) => (
        <button
          key={w}
          type="button"
          onClick={() => onChange(w)}
          className={cn(
            'rounded-md px-2.5 py-1 transition-colors',
            value === w ? 'bg-surface-raised text-content shadow-sm' : 'text-content-subtle hover:text-content',
          )}
        >
          {w}d
        </button>
      ))}
    </div>
  )
}

export function DoraSummary() {
  const [windowDays, setWindowDays] = useState<DoraWindow>(30)
  const query = useDoraMetrics(windowDays)

  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading ArgoCD deploy history…
      </div>
    )
  }
  if (query.isError) {
    return (
      <EmptyState
        title="DORA data unavailable"
        description={
          <>
            ArgoCD could not be reached ({(query.error as Error)?.message ?? 'request failed'}).
            Configure <code className="font-mono">ARGOCD_URL</code> / <code className="font-mono">ARGOCD_TOKEN</code>{' '}
            so deploy history is reachable through the console proxy.
          </>
        }
      />
    )
  }
  const data = query.data
  if (!data || data.services.length === 0) {
    return (
      <EmptyState
        title="No ArgoCD applications"
        description="No Applications with deploy history were returned for this window."
      />
    )
  }
  const { services, aggregate, unavailable } = data
  const cfrAccent = aggregate.tiers.changeFailureRate
    ? TIER_ACCENT[aggregate.tiers.changeFailureRate]
    : 'slate'

  return (
    <div className="space-y-6">
      {/* Elite-benchmark KPI strip (platform-wide aggregate). */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Deploy frequency"
          value={formatDeployFreq(aggregate.deployFrequency)}
          delta={aggregate.tiers.deployFrequency}
          trend={TIER_TREND[aggregate.tiers.deployFrequency]}
          accent={TIER_ACCENT[aggregate.tiers.deployFrequency]}
          series={aggregate.deployTrend}
        />
        <KpiCard
          label="Change-failure rate"
          value={
            aggregate.changeFailureRate == null
              ? '—'
              : `${(aggregate.changeFailureRate * 100).toFixed(1)}%`
          }
          delta={aggregate.tiers.changeFailureRate ?? undefined}
          trend={
            aggregate.tiers.changeFailureRate
              ? TIER_TREND[aggregate.tiers.changeFailureRate]
              : 'flat'
          }
          accent={cfrAccent}
        />
        <KpiCard
          label="Lead time for changes"
          value="—"
          delta="no source"
          trend="flat"
          accent="slate"
        />
        <KpiCard
          label="Mean time to restore"
          value="—"
          delta="no source"
          trend="flat"
          accent="slate"
        />
      </div>
      <p className="text-[11px] text-content-subtle">
        Lead time {unavailable.leadTime} · MTTR {unavailable.mttr}. ArgoCD records deploy time, not
        source-commit or incident-recovery time — these are shown as “—” rather than fabricated.
      </p>

      {/* Trend charts. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-content">Deploy frequency</div>
                <div className="text-[11px] text-content-subtle">Deploys / day · all services</div>
              </div>
              <TierBadge tier={aggregate.tiers.deployFrequency} />
            </div>
          </CardHeader>
          <CardBody>
            <AreaChart
              points={aggregate.deployTrend}
              color={TIER_COLOR[aggregate.tiers.deployFrequency]}
              height={110}
              formatY={(v) => `${Math.round(v)}`}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-content">Lead time for changes</div>
                <div className="text-[11px] text-content-subtle">Requires a commit source</div>
              </div>
            </div>
          </CardHeader>
          <CardBody>
            <EmptyState
              compact
              title="Lead time not available"
              description={`Lead time ${unavailable.leadTime}. Wire a Four Keys / commit-time source to populate it.`}
            />
          </CardBody>
        </Card>
      </div>

      {/* Per-service table + aggregate summary row. */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-content">Per-service DORA</div>
              <div className="text-[11px] text-content-subtle">
                Last {windowDays} days · ranked by deploy volume
              </div>
            </div>
            <div className="flex items-center gap-2">
              <WindowToggle value={windowDays} onChange={setWindowDays} />
              <StatusBadge kind="info">{services.length} services</StatusBadge>
            </div>
          </div>
        </CardHeader>
        <CardBody className="p-0">
          <div
            className={cn(
              GRID,
              'border-b border-edge-subtle bg-surface-sunken/60 px-5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-content-subtle',
            )}
          >
            <span>Service</span>
            <span>Trend</span>
            <span className="text-right">Deploy freq</span>
            <span className="text-right">Lead time</span>
            <span className="text-right">CFR</span>
            <span className="text-right">MTTR</span>
            <span className="text-right">Tier</span>
          </div>
          <div className="divide-y divide-edge-subtle">
            {services.map((r) => (
              <ServiceRow key={r.service} r={r} />
            ))}
          </div>
          <ServiceRow r={aggregate} summary />
        </CardBody>
      </Card>
    </div>
  )
}

export default DoraSummary
