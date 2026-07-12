import { useEffect, useState } from 'react'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import type { posthog } from '@adhar-console/api-clients'
import { useInsights } from '../data/observability.ts'

/**
 * Funnels — PostHog conversion funnels rendered as a step ladder with
 * conversion %, drop-off %, and avg time-to-next.
 */
export function Funnels() {
  const q = useInsights('funnel')
  const retention = useInsights('retention')
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => {
    if (!activeId && q.data?.length) setActiveId(q.data[0].id)
  }, [q.data, activeId])

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading funnels…
      </div>
    )
  }
  const list = q.data ?? []
  const active = list.find((f) => f.id === activeId)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-white p-1 shadow-sm">
        {list.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setActiveId(f.id)}
            className={
              activeId === f.id
                ? 'rounded-md bg-brand-50 px-2.5 py-1 text-[12px] font-semibold text-brand-700'
                : 'rounded-md px-2.5 py-1 text-[12px] text-content-muted hover:bg-surface-sunken'
            }
          >
            {f.name}
          </button>
        ))}
      </div>

      {active && active.result?.kind === 'funnel' ? (
        <FunnelCard insight={active} />
      ) : (
        <EmptyState title="No funnels" description="Define a funnel insight in PostHog to populate this list." />
      )}

      {retention.data?.[0]?.result?.kind === 'retention' ? (
        <RetentionCard insight={retention.data[0]} />
      ) : null}
    </div>
  )
}

function FunnelCard({ insight }: { insight: posthog.Insight }) {
  if (insight.result?.kind !== 'funnel') return null
  const steps = insight.result.steps
  const top = steps[0]?.count || 1
  const overall = steps[steps.length - 1] ? (steps[steps.length - 1].count / top) * 100 : 0

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-content">{insight.name}</div>
            <div className="text-[11px] text-content-subtle">{insight.description}</div>
          </div>
          <StatusBadge kind={overall > 5 ? 'healthy' : overall > 2 ? 'progressing' : 'failed'}>
            {overall.toFixed(1)}% overall
          </StatusBadge>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        {steps.map((s, i) => {
          const widthFromTop = (s.count / top) * 100
          const stepConv = i === 0 ? 1 : s.count / steps[i - 1].count
          const dropoff = i === 0 ? 0 : 1 - stepConv
          return (
            <div key={s.name} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm text-content">
                  <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand-50 font-mono text-[10px] font-bold text-brand-700">
                    {i + 1}
                  </span>
                  {s.name}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-content-muted">
                  {s.count.toLocaleString()}
                </span>
              </div>
              <div className="h-7 w-full overflow-hidden rounded-md bg-surface-sunken">
                <div
                  className="flex h-full items-center justify-end bg-linear-to-r from-brand-500 to-brand-400 px-2 text-[11px] font-mono font-semibold text-white"
                  style={{ width: `${Math.max(2, widthFromTop)}%` }}
                >
                  {widthFromTop.toFixed(1)}%
                </div>
              </div>
              {i > 0 ? (
                <div className="flex items-center gap-3 text-[11px]">
                  <span className="text-emerald-700">
                    +{(stepConv * 100).toFixed(1)}% step conversion
                  </span>
                  {dropoff > 0 ? (
                    <span className="text-rose-700">−{(dropoff * 100).toFixed(1)}% drop-off</span>
                  ) : null}
                  {s.avg_time_s ? (
                    <span className="text-content-muted">
                      avg {formatDuration(s.avg_time_s)} to next
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </CardBody>
    </Card>
  )
}

function RetentionCard({ insight }: { insight: posthog.Insight }) {
  if (insight.result?.kind !== 'retention') return null
  const { cohorts } = insight.result
  const maxLen = Math.max(...cohorts.map((c) => c.values.length))
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-content">{insight.name}</div>
            <div className="text-[11px] text-content-subtle">Cohort retention heatmap</div>
          </div>
          <StatusBadge kind="info">{cohorts.length} cohorts</StatusBadge>
        </div>
      </CardHeader>
      <CardBody>
        <div className="overflow-x-auto">
          <table className="text-[10px] font-mono">
            <thead>
              <tr>
                <th className="px-2 py-1 text-left text-content-subtle">Cohort</th>
                <th className="px-2 py-1 text-right text-content-subtle">Size</th>
                {Array.from({ length: maxLen }).map((_, i) => (
                  <th key={i} className="px-2 py-1 text-right text-content-subtle">
                    W{i}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cohorts.map((c) => (
                <tr key={c.label}>
                  <td className="whitespace-nowrap px-2 py-1 text-content">{c.label}</td>
                  <td className="px-2 py-1 text-right text-content-muted">{c.size}</td>
                  {Array.from({ length: maxLen }).map((_, i) => {
                    const v = c.values[i]
                    if (v === undefined) return <td key={i} className="px-2 py-1" />
                    const t = Math.max(0, Math.min(1, v / 100))
                    const bg = `rgba(99, 102, 241, ${0.1 + t * 0.6})`
                    return (
                      <td
                        key={i}
                        className="px-2 py-1 text-right text-content"
                        style={{ backgroundColor: bg }}
                      >
                        {v}%
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  )
}

function formatDuration(s: number): string {
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}
