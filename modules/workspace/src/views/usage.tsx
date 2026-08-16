import {
  Card,
  CardBody,
  CardHeader,
  DonutGauge,
  EmptyState,
  Spinner,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { fmtMoney, useSubscription, useUsage } from '../data/billing.ts'

/**
 * Usage & metering — every number on this page is measured: seats from the
 * tenant's member records, namespaces/pods/nodes from the live kube-apiserver
 * (the caller's RBAC applies), and $ cost from OpenCost. Sources that aren't
 * connected render as "not connected" — never as a fabricated figure.
 */

function pct(used: number, quota: number): number {
  if (quota <= 0) return 0
  return Math.min(100, Math.round((used / quota) * 100))
}

export function UsageView() {
  const q = useUsage()
  const subQ = useSubscription()

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Metering usage…
      </div>
    )
  }
  if (q.isError || !q.data) {
    return (
      <EmptyState
        title="Usage unavailable"
        description={q.error instanceof Error ? q.error.message : 'The usage meter did not respond.'}
      />
    )
  }
  const u = q.data
  const plan = subQ.data?.plan
  const seatsPurchased = subQ.data?.item.seatsPurchased ?? null

  const seatPct = u.seats !== null && seatsPurchased ? pct(u.seats, seatsPurchased) : null
  const donutPct = seatPct ?? 0
  const donutColor =
    donutPct > 85 ? '#f43f5e' : donutPct > 60 ? '#f59e0b' : 'var(--color-brand-500)'

  const liveTiles: { label: string; value: string; hint: string }[] = [
    {
      label: 'Namespaces',
      value: u.namespaces !== null ? String(u.namespaces) : '—',
      hint:
        u.clusterSource === 'kubernetes'
          ? u.clusterScope === 'cluster'
            ? 'cluster-wide'
            : `scoped by ${u.clusterScope === 'tenant-label' ? 'tenant label' : 'tenant prefix'}`
          : 'cluster not reachable',
    },
    {
      label: 'Pods',
      value: u.pods !== null ? u.pods.toLocaleString() : '—',
      hint: u.clusterSource === 'kubernetes' ? 'running now' : 'cluster not reachable',
    },
    {
      label: 'Nodes',
      value: u.nodes !== null ? String(u.nodes) : '—',
      hint: u.clusterSource === 'kubernetes' ? 'cluster capacity' : 'cluster not reachable',
    },
  ]

  const quotaRows: { label: string; used: string; quota: string; pct: number | null }[] = [
    {
      label: 'Seats',
      used: u.seats !== null ? String(u.seats) : 'n/a',
      quota: seatsPurchased !== null ? String(seatsPurchased) : 'n/a',
      pct: seatPct,
    },
    {
      label: 'Namespaces',
      used: u.namespaces !== null ? String(u.namespaces) : 'n/a',
      quota:
        plan?.limits.namespaces === null
          ? 'unlimited'
          : plan
            ? String(plan.limits.namespaces)
            : 'n/a',
      pct:
        u.namespaces !== null && plan?.limits.namespaces != null
          ? pct(u.namespaces, plan.limits.namespaces)
          : null,
    },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-content">Usage & metering</h2>
        <p className="mt-1 text-sm text-content-muted">
          Period {u.period} · every figure is metered live — seats from workspace members,
          resource counts from the Kubernetes API, cost from OpenCost. Nothing here is estimated
          except the labeled forecast.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[auto_1fr]">
        <Card>
          <CardBody className="flex items-center justify-center px-6 py-6">
            <DonutGauge
              value={donutPct}
              max={100}
              size={156}
              thickness={14}
              color={donutColor}
              label={
                seatPct !== null ? (
                  <span>
                    {seatPct}
                    <span className="text-sm font-normal text-content-muted">%</span>
                  </span>
                ) : (
                  <span className="text-sm font-normal text-content-muted">n/a</span>
                )
              }
              caption="seats in use"
            />
          </CardBody>
        </Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {liveTiles.map((t) => (
            <Card key={t.label}>
              <CardBody className="space-y-1">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
                  {t.label}
                </div>
                <div className="text-xl font-semibold tabular-nums tracking-tight text-content">
                  {t.value}
                </div>
                <div className="text-[11px] text-content-muted">{t.hint}</div>
              </CardBody>
            </Card>
          ))}
        </div>
      </div>

      {/* Metered cost */}
      <Card>
        <CardHeader>
          <div className="text-sm font-semibold text-content">Metered cost — {u.period}</div>
        </CardHeader>
        <CardBody>
          {u.costSource === 'opencost' ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <MeterStat label="Cost (period)" value={fmtMoney(u.cost ?? 0)} strong />
              <MeterStat
                label="CPU core-hours"
                value={u.cpuCoreHours !== null ? u.cpuCoreHours.toLocaleString() : '—'}
              />
              <MeterStat
                label="Memory GB-hours"
                value={u.memGbHours !== null ? u.memGbHours.toLocaleString() : '—'}
              />
            </div>
          ) : (
            <EmptyState
              compact
              title="Cost data not connected"
              description="Point OPENCOST_URL at your OpenCost allocation API to meter real $ cost. No figure is shown until the meter is live."
            />
          )}
        </CardBody>
      </Card>

      {/* Quota bars — only where both sides are real */}
      <Card>
        <CardHeader>
          <div className="text-sm font-semibold text-content">Plan quota</div>
        </CardHeader>
        <CardBody className="space-y-3">
          {quotaRows.map((r) => {
            const color =
              r.pct === null
                ? 'var(--color-brand-500)'
                : r.pct > 85
                  ? '#f43f5e'
                  : r.pct > 60
                    ? '#f59e0b'
                    : 'var(--color-brand-500)'
            return (
              <div
                key={r.label}
                className="rounded-lg border border-edge-subtle bg-surface-sunken/60 px-4 py-3"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="text-sm font-medium text-content">{r.label}</div>
                  <div
                    className={cn(
                      'text-xs font-semibold tabular-nums',
                      r.pct === null
                        ? 'text-content-subtle'
                        : r.pct > 85
                          ? 'text-rose-600'
                          : r.pct > 60
                            ? 'text-amber-600'
                            : 'text-content-muted',
                    )}
                  >
                    {r.pct !== null ? `${r.pct}%` : 'no data'}
                  </div>
                </div>
                <div className="mt-1 text-[11px] text-content-subtle">
                  {r.used} used · {r.quota} quota
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-app">
                  <div
                    className="h-full rounded-full transition-[width] duration-500 ease-smooth"
                    style={{ width: `${r.pct ?? 0}%`, backgroundColor: color }}
                  />
                </div>
              </div>
            )
          })}
        </CardBody>
      </Card>

      {/* Per-namespace breakdown */}
      <Card>
        <CardHeader>
          <div className="text-sm font-semibold text-content">Breakdown by namespace</div>
        </CardHeader>
        <CardBody>
          {u.breakdownByNamespace.length === 0 ? (
            <EmptyState
              compact
              title="No namespace data"
              description={
                u.clusterSource === 'unavailable'
                  ? 'The cluster is not reachable and cost metering is not connected.'
                  : 'No namespaces matched this workspace.'
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[11px] uppercase tracking-wider text-content-subtle">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Namespace</th>
                    <th className="px-3 py-2 text-right font-medium">Pods</th>
                    <th className="px-3 py-2 text-right font-medium">CPU core-h</th>
                    <th className="px-3 py-2 text-right font-medium">Mem GB-h</th>
                    <th className="px-3 py-2 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge-subtle">
                  {u.breakdownByNamespace.map((b) => (
                    <tr key={b.namespace}>
                      <td className="px-3 py-2">
                        <code className="font-mono text-[12px] text-content">{b.namespace}</code>
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-content">
                        {b.pods !== null ? b.pods : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-content">
                        {b.cpuCoreHours !== null ? b.cpuCoreHours.toLocaleString() : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-content">
                        {b.memGbHours !== null ? b.memGbHours.toLocaleString() : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-content">
                        {b.cost !== null ? fmtMoney(b.cost) : 'not connected'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

function MeterStat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
      <div
        className={cn(
          'mt-0.5 tabular-nums text-content',
          strong ? 'text-xl font-semibold tracking-tight' : 'text-sm font-medium',
        )}
      >
        {value}
      </div>
    </div>
  )
}
