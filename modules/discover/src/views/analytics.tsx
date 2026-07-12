import { useMemo, useState } from 'react'
import {
  AreaChart,
  BarChart,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { cn, formatRelative } from '@adhar-console/utils'
import type { posthog } from '@adhar-console/api-clients'
import {
  useAnalyticsEvents,
  useInsights,
  usePersons,
} from '../data/observability.ts'

/**
 * Analytics — PostHog product insights.
 *
 * Hero stats: DAU, sessions, top events. Trend chart per insight. Recent
 * event tail with person attribution. Persons leaderboard.
 */
export function Analytics() {
  const events = useAnalyticsEvents({ sinceMs: 24 * 3600 * 1000 })
  const trends = useInsights('trend')
  const persons = usePersons()
  const [activeId, setActiveId] = useState<string | null>(null)

  const activeInsight = useMemo(() => {
    if (!trends.data) return null
    return trends.data.find((t) => t.id === activeId) ?? trends.data[0] ?? null
  }, [trends.data, activeId])

  if (events.isLoading || trends.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading analytics…
      </div>
    )
  }

  const eventList = events.data ?? []
  const personList = persons.data ?? []

  const dau = useMemo(() => new Set(eventList.map((e) => e.distinct_id)).size, [eventList])
  const eventsByName = useMemo(() => {
    const out: Record<string, number> = {}
    for (const e of eventList) out[e.event] = (out[e.event] ?? 0) + 1
    return out
  }, [eventList])
  const topEvents = Object.entries(eventsByName)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Hero label="DAU · 24h" value={dau} tone="brand" />
        <Hero label="Events · 24h" value={eventList.length} tone="violet" />
        <Hero label="Top event" value={topEvents[0]?.[0] ?? '—'} tone="emerald" small />
        <Hero label="Persons" value={personList.length} tone="amber" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-content">Trends</div>
                <div className="text-[11px] text-content-subtle">
                  Switch insight to overlay alternate metrics
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1 rounded-md border border-edge-default bg-white p-1">
                {(trends.data ?? []).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setActiveId(t.id)}
                    className={cn(
                      'rounded px-2 py-0.5 text-[11px] font-medium',
                      (activeInsight?.id ?? trends.data?.[0]?.id) === t.id
                        ? 'bg-brand-50 text-brand-700'
                        : 'text-content-muted hover:bg-surface-sunken',
                    )}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardBody>
            {activeInsight && activeInsight.result?.kind === 'trend' ? (
              <TrendPanel insight={activeInsight} />
            ) : (
              <EmptyState compact title="Pick an insight" />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-sm font-semibold text-content">Top events · 24 h</div>
            <div className="text-[11px] text-content-subtle">PostHog event feed</div>
          </CardHeader>
          <CardBody>
            <BarChart
              bars={topEvents.map(([label, value], i) => ({
                label,
                value,
                color: i === 0 ? 'var(--color-brand-500)' : 'var(--color-brand-400)',
              }))}
              height={Math.min(28 * topEvents.length + 20, 280)}
            />
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-content">Recent events</div>
              <StatusBadge kind="info">{eventList.length}</StatusBadge>
            </div>
          </CardHeader>
          <CardBody className="p-0!">
            <ul className="max-h-[480px] divide-y divide-edge-subtle overflow-y-auto">
              {eventList.slice(0, 30).map((e) => (
                <EventRow key={e.id} event={e} />
              ))}
            </ul>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-sm font-semibold text-content">Persons</div>
            <div className="text-[11px] text-content-subtle">By session count · 30d</div>
          </CardHeader>
          <CardBody className="p-0!">
            <ul className="divide-y divide-edge-subtle">
              {personList
                .slice()
                .sort((a, b) => (b.sessions_30d ?? 0) - (a.sessions_30d ?? 0))
                .slice(0, 8)
                .map((p) => (
                  <PersonRow key={p.id} person={p} />
                ))}
            </ul>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

function TrendPanel({ insight }: { insight: posthog.Insight }) {
  if (insight.result?.kind !== 'trend') return null
  const { labels, series } = insight.result
  return (
    <div className="space-y-3">
      {series.map((s, i) => (
        <div key={s.label}>
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] font-semibold text-content">{s.label}</span>
            <span className="font-mono text-[11px] tabular-nums text-content-muted">
              max {Math.max(...s.data).toLocaleString()}
            </span>
          </div>
          <AreaChart
            points={s.data.map((v, idx) => ({ v, label: labels[idx] }))}
            color={s.color ?? (i === 0 ? 'var(--color-brand-500)' : 'var(--color-emerald-500)')}
            height={120}
            showAxis
          />
        </div>
      ))}
      <div className="flex flex-wrap gap-3 text-[11px] text-content-muted">
        <span>created {formatRelative(insight.created_at)}</span>
        {insight.updated_at ? <span>· refreshed {formatRelative(insight.updated_at)}</span> : null}
      </div>
    </div>
  )
}

function EventRow({ event: e }: { event: posthog.PHEvent }) {
  const props = e.properties ?? {}
  const kvs = Object.entries(props).slice(0, 3)
  return (
    <li className="px-5 py-2.5 transition-colors hover:bg-brand-50/40">
      <div className="flex items-center gap-2">
        <code className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] font-semibold text-brand-700">
          {e.event}
        </code>
        <span className="truncate text-sm text-content">{e.person?.name ?? e.distinct_id}</span>
        <span className="ml-auto shrink-0 text-[11px] text-content-muted">
          {formatRelative(e.timestamp)}
        </span>
      </div>
      {kvs.length ? (
        <div className="mt-1 flex flex-wrap gap-1 text-[10px] font-mono">
          {kvs.map(([k, v]) => (
            <span key={k} className="rounded bg-surface-sunken px-1.5 py-0.5 text-content-subtle">
              <span className="opacity-60">{k}=</span>
              <span className="text-content">{String(v).slice(0, 32)}</span>
            </span>
          ))}
        </div>
      ) : null}
    </li>
  )
}

function PersonRow({ person: p }: { person: posthog.PHPerson }) {
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-[10px] font-bold text-emerald-700 ring-1 ring-inset ring-emerald-200">
        {(p.name ?? p.distinct_id).slice(0, 2).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-content">{p.name ?? p.distinct_id}</div>
        <div className="truncate text-[11px] text-content-subtle">
          {p.email ?? p.distinct_id}
          {p.last_seen_at ? ` · seen ${formatRelative(p.last_seen_at)}` : ''}
        </div>
      </div>
      <span className="font-mono text-[11px] tabular-nums text-content-muted">
        {p.sessions_30d ?? 0}
      </span>
    </li>
  )
}

function Hero({
  label,
  value,
  tone,
  small = false,
}: {
  label: string
  value: number | string
  tone: 'brand' | 'amber' | 'emerald' | 'violet'
  small?: boolean
}) {
  const cls = {
    brand: 'from-brand-50 to-white text-brand-700',
    amber: 'from-amber-50 to-white text-amber-700',
    emerald: 'from-emerald-50 to-white text-emerald-700',
    violet: 'from-violet-50 to-white text-violet-700',
  }[tone]
  return (
    <Card className={`bg-linear-to-br ${cls} ring-1 ring-inset ring-edge-subtle`}>
      <CardBody className="p-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
          {label}
        </div>
        <div
          className={`font-semibold tabular-nums tracking-tight text-content ${small ? 'truncate text-base' : 'text-3xl'}`}
        >
          {value}
        </div>
      </CardBody>
    </Card>
  )
}
