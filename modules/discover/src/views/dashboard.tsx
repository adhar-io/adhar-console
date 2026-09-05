import { useMemo } from 'react'
import {
  AreaChart,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Sparkline,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import type { lgtm, posthog } from '@adhar-console/api-clients'
import {
  seriesToPoints,
  useAlerts,
  useAnalyticsEvents,
  useInsights,
  useMetrics,
  useServiceMap,
  useSessions,
  useSlos,
} from '../data/observability.ts'
import { LoadingCard, SourceError } from './states.tsx'

/**
 * Workspace-level Discover dashboard. Side-by-side observability + product
 * analytics — golden signals (RPS / errors / p95), alert + SLO health on
 * the left, DAU / top events / sessions on the right. Mirrors the Define /
 * Design / Develop / Deliver dashboards.
 */
export function Dashboard() {
  const rps = useMetrics('http_requests_per_second', '1h')
  const err = useMetrics('http_5xx_rate', '1h')
  const p95 = useMetrics('http_request_duration_p95_ms', '1h')
  const cpu = useMetrics('container_cpu_usage_seconds_total:rate1m', '1h')
  const alerts = useAlerts()
  const slos = useSlos()
  const services = useServiceMap()
  const events = useAnalyticsEvents({ sinceMs: 24 * 3600 * 1000 })
  const sessions = useSessions()
  const trends = useInsights('trend')

  const rpsTotal = sumLast(rps.data ?? [])
  const errAvg = avgLast(err.data ?? [])
  const p95Max = maxLast(p95.data ?? [])
  const cpuAvg = avgLast(cpu.data ?? [])

  const firing = (alerts.data ?? []).filter((a) => a.state === 'firing')
  const slosBurning = (slos.data ?? []).filter((s) => s.errorBudgetRemaining < 0.5)

  const eventList = events.data ?? []
  const eventCounts = useMemo(() => countBy(eventList, (e) => e.event), [eventList])

  const activeUsers = useMemo(() => new Set(eventList.map((e) => e.distinct_id)).size, [eventList])

  const dauTrend = trends.data?.find((i) => i.id === 'i-mau')
  const dauPoints = dauTrend?.result?.kind === 'trend' ? dauTrend.result.series[0]?.data ?? [] : []

  if (rps.isLoading || alerts.isLoading) {
    return <LoadingCard label="Loading observability feed…" />
  }

  // Everything is down — most often no BFF/backends wired. Say so once rather
  // than rendering a page full of empty cards.
  if (rps.isError && alerts.isError && slos.isError && events.isError) {
    return (
      <SourceError
        tool="the observability backends"
        error={rps.error ?? alerts.error}
        onRetry={() => {
          rps.refetch()
          alerts.refetch()
          slos.refetch()
          events.refetch()
        }}
      />
    )
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <HeroStat
          label="RPS"
          value={rpsTotal.toFixed(0)}
          tone="brand"
          icon={<IconActivity />}
          hint="last sample, all svc"
          trend={(rps.data ?? []).slice(0, 1).flatMap(seriesToPoints)}
        />
        <HeroStat
          label="Error %"
          value={errAvg.toFixed(2)}
          tone="rose"
          icon={<IconShieldAlert />}
          hint="5xx rate, last 5m"
          trend={(err.data ?? []).slice(0, 1).flatMap(seriesToPoints)}
        />
        <HeroStat
          label="p95 ms"
          value={p95Max.toFixed(0)}
          tone="amber"
          icon={<IconClock />}
          hint="worst service"
          trend={(p95.data ?? []).slice(0, 1).flatMap(seriesToPoints)}
        />
        <HeroStat
          label="CPU avg"
          value={(cpuAvg * 100).toFixed(0) + '%'}
          tone="violet"
          icon={<IconCpu />}
          hint="rate1m, all pods"
        />
        <HeroStat
          label="Alerts"
          value={firing.length}
          tone={firing.length ? 'rose' : 'emerald'}
          icon={<IconBell />}
          hint={`${(alerts.data ?? []).filter((a) => a.state === 'pending').length} pending`}
        />
        <HeroStat
          label="DAU · 24h"
          value={activeUsers}
          tone="emerald"
          icon={<IconUsers />}
          hint="unique distinct_ids"
          trend={dauPoints}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-content">Golden signals</div>
                <div className="text-[11px] text-content-subtle">Per-service traffic, errors, p95 — last 1 h</div>
              </div>
              <StatusBadge kind="info">{(rps.data ?? []).length} services</StatusBadge>
            </div>
          </CardHeader>
          <CardBody className="p-0!">
            <ServiceTable
              rps={rps.data ?? []}
              err={err.data ?? []}
              p95={p95.data ?? []}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-sm font-semibold text-content">Active alerts</div>
            <div className="text-[11px] text-content-subtle">Alertmanager · live</div>
          </CardHeader>
          <CardBody className="p-0!">
            {alerts.data && alerts.data.filter((a) => a.state !== 'resolved').length > 0 ? (
              <ul className="divide-y divide-edge-subtle">
                {alerts.data
                  .filter((a) => a.state !== 'resolved')
                  .slice(0, 6)
                  .map((a) => (
                    <AlertRow key={a.fingerprint} alert={a} />
                  ))}
              </ul>
            ) : (
              <EmptyState compact title="All clear 🎉" />
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <div className="text-sm font-semibold text-content">SLO health</div>
            <div className="text-[11px] text-content-subtle">{(slos.data ?? []).length} objectives</div>
          </CardHeader>
          <CardBody className="space-y-2">
            {(slos.data ?? []).slice(0, 4).map((s) => (
              <SloRow key={s.name} slo={s} />
            ))}
            {slosBurning.length ? (
              <div className="mt-2 rounded-md border border-rose-200 bg-rose-50/60 px-2 py-1.5 text-[11px] text-rose-800">
                {slosBurning.length} objective{slosBurning.length === 1 ? '' : 's'} burning the error budget
              </div>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-sm font-semibold text-content">Service map snapshot</div>
            <div className="text-[11px] text-content-subtle">RPS × error % at a glance</div>
          </CardHeader>
          <CardBody className="space-y-1.5">
            {(services.data?.nodes ?? [])
              .slice()
              .sort((a, b) => b.rps - a.rps)
              .slice(0, 5)
              .map((n) => (
                <ServiceNodeRow key={n.name} node={n} />
              ))}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-sm font-semibold text-content">Top events · 24 h</div>
            <div className="text-[11px] text-content-subtle">PostHog event feed</div>
          </CardHeader>
          <CardBody className="space-y-1.5">
            {Object.entries(eventCounts)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 6)
              .map(([name, count]) => (
                <EventCountRow key={name} name={name} count={count} max={Math.max(...Object.values(eventCounts), 1)} />
              ))}
            {Object.keys(eventCounts).length === 0 ? <EmptyState compact title="No events yet" /> : null}
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {dauTrend?.result?.kind === 'trend' ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-content">{dauTrend.name}</div>
                  <div className="text-[11px] text-content-subtle">
                    {dauTrend.description ?? 'PostHog trend insight'}
                  </div>
                </div>
                <StatusBadge kind="info">trend · 14d</StatusBadge>
              </div>
            </CardHeader>
            <CardBody>
              <AreaChart
                points={dauTrend.result.series[0]?.data ?? []}
                color="var(--color-brand-500)"
                height={120}
                showAxis
              />
              <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-content-muted">
                {dauTrend.result.series.map((s) => (
                  <span key={s.label} className="inline-flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.color ?? 'var(--color-emerald-500)' }} />
                    {s.label}
                  </span>
                ))}
              </div>
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <div className="text-sm font-semibold text-content">Recent sessions</div>
            <div className="text-[11px] text-content-subtle">Last 5 with replay</div>
          </CardHeader>
          <CardBody className="p-0!">
            <ul className="divide-y divide-edge-subtle">
              {(sessions.data ?? []).slice(0, 5).map((s) => (
                <SessionRow key={s.id} session={s} />
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <QuickStartCard
          title="Observe"
          description="Metrics, logs, traces, service map — all in one stack."
          links={[
            { label: 'Metrics', href: '?metrics' },
            { label: 'Logs', href: '?logs' },
            { label: 'Traces', href: '?traces' },
            { label: 'Service Map', href: '?servicemap' },
          ]}
          tone="brand"
        />
        <QuickStartCard
          title="Reliability"
          description="Active alerts and SLO health with burn rate."
          links={[
            { label: 'Alerts', href: '?alerts' },
            { label: 'SLOs', href: '?slos' },
            { label: 'Grafana boards', href: '?dashboards' },
          ]}
          tone="amber"
        />
        <QuickStartCard
          title="Product analytics"
          description="DAU, retention, conversion funnels — PostHog-powered."
          links={[
            { label: 'Analytics', href: '?analytics' },
            { label: 'Funnels', href: '?funnels' },
            { label: 'Cohorts', href: '?cohorts' },
          ]}
          tone="emerald"
        />
        <QuickStartCard
          title="Experiments"
          description="Sessions with replay, feature flags + A/B variants."
          links={[
            { label: 'Sessions', href: '?sessions' },
            { label: 'Feature Flags', href: '?flags' },
          ]}
          tone="violet"
        />
      </div>
    </div>
  )
}

/* ─────────── rows ─────────── */

function ServiceTable({
  rps,
  err,
  p95,
}: {
  rps: lgtm.MetricSeries[]
  err: lgtm.MetricSeries[]
  p95: lgtm.MetricSeries[]
}) {
  const services = Array.from(
    new Set([...rps, ...err, ...p95].map((s) => s.metric.service).filter(Boolean)),
  )
  return (
    <ul className="divide-y divide-edge-subtle">
      {services.map((svc) => {
        const rpsSeries = rps.find((s) => s.metric.service === svc)
        const errSeries = err.find((s) => s.metric.service === svc)
        const p95Series = p95.find((s) => s.metric.service === svc)
        const rpsLatest = rpsSeries ? lastNum(rpsSeries) : 0
        const errLatest = errSeries ? lastNum(errSeries) : 0
        const p95Latest = p95Series ? lastNum(p95Series) : 0
        const tone = errLatest > 1 ? 'rose' : errLatest > 0.3 ? 'amber' : 'emerald'
        return (
          <li key={svc} className="grid grid-cols-[1fr_120px_120px_120px] items-center gap-3 px-5 py-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-content">{svc}</div>
              <div className="text-[10px] text-content-subtle">
                rate · 5xx · p95 last hour
              </div>
            </div>
            <div className="flex flex-col items-end gap-0.5">
              <span className="font-mono text-[12px] tabular-nums text-content">
                {rpsLatest.toFixed(1)} rps
              </span>
              {rpsSeries ? (
                <Sparkline
                  points={seriesToPoints(rpsSeries)}
                  color="var(--color-brand-500)"
                  height={20}
                  width={100}
                />
              ) : null}
            </div>
            <div className="flex flex-col items-end gap-0.5">
              <span className={`font-mono text-[12px] tabular-nums ${toneText(tone)}`}>
                {errLatest.toFixed(2)}%
              </span>
              {errSeries ? (
                <Sparkline
                  points={seriesToPoints(errSeries)}
                  color={tone === 'rose' ? 'var(--color-rose-500)' : tone === 'amber' ? 'var(--color-amber-500)' : 'var(--color-emerald-500)'}
                  height={20}
                  width={100}
                />
              ) : null}
            </div>
            <div className="flex flex-col items-end gap-0.5">
              <span className="font-mono text-[12px] tabular-nums text-content">{p95Latest.toFixed(0)} ms</span>
              {p95Series ? (
                <Sparkline
                  points={seriesToPoints(p95Series)}
                  color="var(--color-violet-500)"
                  height={20}
                  width={100}
                />
              ) : null}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function AlertRow({ alert: a }: { alert: lgtm.Alert }) {
  const tone =
    a.severity === 'critical' ? 'failed' : a.severity === 'warning' ? 'progressing' : 'info'
  return (
    <li className="px-5 py-3 transition-colors hover:bg-brand-50/40">
      <div className="flex items-center gap-2">
        <StatusBadge kind={tone}>{a.severity}</StatusBadge>
        <span className="truncate text-sm font-semibold text-content">{a.name}</span>
        <span className="ml-auto shrink-0 text-[11px] text-content-muted">
          {formatRelative(a.startsAt)}
        </span>
      </div>
      {a.summary ? (
        <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-content-muted">
          {a.summary}
        </div>
      ) : null}
      {a.labels.service ? (
        <div className="mt-1.5 inline-flex items-center gap-1 rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-subtle">
          {a.labels.service}
        </div>
      ) : null}
    </li>
  )
}

function SloRow({ slo: s }: { slo: lgtm.Slo }) {
  const meeting = s.current >= s.objective
  const tone = meeting ? 'emerald' : 'rose'
  const burnTone = s.burnRate6h >= 6 ? 'rose' : s.burnRate6h >= 2 ? 'amber' : 'emerald'
  return (
    <div className="rounded-md border border-edge-subtle bg-surface-sunken/40 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[12px] font-semibold text-content">{s.name}</span>
        <span className={`font-mono text-[12px] tabular-nums ${toneText(tone)}`}>
          {s.current.toFixed(2)}%
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[10px]">
        <span className="text-content-subtle">objective {s.objective}%</span>
        <span className="text-content-subtle">·</span>
        <span className={toneText(burnTone)}>burn 6h {s.burnRate6h.toFixed(1)}×</span>
        <Sparkline
          points={s.history}
          color={meeting ? 'var(--color-emerald-500)' : 'var(--color-rose-500)'}
          height={16}
          width={80}
          strokeWidth={1.25}
        />
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
        <div
          className={`h-full ${meeting ? 'bg-emerald-500' : 'bg-rose-500'}`}
          style={{ width: `${Math.max(0, Math.min(100, (s.current / 100) * 100))}%` }}
        />
      </div>
    </div>
  )
}

function ServiceNodeRow({ node }: { node: lgtm.ServiceNode }) {
  const tone = node.errorRate > 1 ? 'rose' : node.errorRate > 0.3 ? 'amber' : 'emerald'
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 rounded-md border border-edge-subtle bg-surface-sunken/30 px-2.5 py-1.5 text-[11px]">
      <span className="truncate font-medium text-content">{node.name}</span>
      <span className="font-mono tabular-nums text-content">{node.rps.toFixed(0)} rps</span>
      <span className={`font-mono tabular-nums ${toneText(tone)}`}>{node.errorRate.toFixed(1)}%</span>
      <span className="font-mono tabular-nums text-content-subtle">{node.p95Ms.toFixed(0)} ms</span>
    </div>
  )
}

function EventCountRow({ name, count, max }: { name: string; count: number; max: number }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <code className="truncate font-mono text-content">{name}</code>
        <span className="font-mono tabular-nums text-content-subtle">{count}</span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
        <div
          className="h-full bg-linear-to-r from-brand-500 to-brand-400"
          style={{ width: `${(count / max) * 100}%` }}
        />
      </div>
    </div>
  )
}

function SessionRow({ session: s }: { session: posthog.Session }) {
  const dur = formatDuration(s.duration_s)
  return (
    <li className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-brand-50/40">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-[10px] font-bold text-emerald-700 ring-1 ring-inset ring-emerald-200">
        {s.person.name?.slice(0, 2).toUpperCase() ?? '?'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-content">{s.person.name ?? s.person.distinct_id}</div>
        <div className="mt-0.5 text-[11px] text-content-subtle">
          {dur} · {s.pageview_count} pages · {s.click_count} clicks
          {s.console_error_count ? ` · ${s.console_error_count} errors` : ''}
        </div>
      </div>
      {s.recording_available ? <StatusBadge kind="info">replay</StatusBadge> : null}
    </li>
  )
}

/* ─────────── helpers ─────────── */

function lastNum(s: lgtm.MetricSeries): number {
  const last = s.values[s.values.length - 1]
  return last ? Number(last[1]) : 0
}
function sumLast(arr: lgtm.MetricSeries[]): number {
  return arr.reduce((acc, s) => acc + lastNum(s), 0)
}
function avgLast(arr: lgtm.MetricSeries[]): number {
  if (!arr.length) return 0
  return sumLast(arr) / arr.length
}
function maxLast(arr: lgtm.MetricSeries[]): number {
  return arr.reduce((m, s) => Math.max(m, lastNum(s)), 0)
}
function countBy<T>(arr: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const v of arr) {
    const k = key(v)
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}
function formatDuration(s: number): string {
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}
function toneText(tone: 'rose' | 'amber' | 'emerald'): string {
  return tone === 'rose' ? 'text-rose-700' : tone === 'amber' ? 'text-amber-700' : 'text-emerald-700'
}

/* ─────────── hero + quick-start atoms ─────────── */

function HeroStat({
  label,
  value,
  tone,
  icon,
  hint,
  trend,
}: {
  label: string
  value: number | string
  tone: 'brand' | 'amber' | 'rose' | 'violet' | 'sky' | 'emerald'
  icon: React.ReactNode
  hint?: string
  trend?: number[]
}) {
  const cls = {
    brand: 'from-brand-50 dark:from-brand-500/10 to-surface-raised text-brand-700 dark:text-brand-300',
    amber: 'from-amber-50 dark:from-amber-500/10 to-surface-raised text-amber-700 dark:text-amber-300',
    rose: 'from-rose-50 dark:from-rose-500/10 to-surface-raised text-rose-700 dark:text-rose-300',
    violet: 'from-violet-50 dark:from-violet-500/10 to-surface-raised text-violet-700 dark:text-violet-300',
    sky: 'from-sky-50 dark:from-sky-500/10 to-surface-raised text-sky-700 dark:text-sky-300',
    emerald: 'from-emerald-50 dark:from-emerald-500/10 to-surface-raised text-emerald-700 dark:text-emerald-300',
  }[tone]
  const sparkColor = {
    brand: 'var(--color-brand-500)',
    amber: 'var(--color-amber-500)',
    rose: 'var(--color-rose-500)',
    violet: 'var(--color-violet-500)',
    sky: 'var(--color-sky-500)',
    emerald: 'var(--color-emerald-500)',
  }[tone]
  return (
    <Card className={`relative overflow-hidden bg-linear-to-br ${cls} ring-1 ring-inset ring-edge-subtle`}>
      <CardBody className="space-y-1 p-4">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-raised/80 shadow-sm">
            {icon}
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
            {label}
          </span>
        </div>
        <div className="text-3xl font-semibold tabular-nums tracking-tight text-content">
          {value}
        </div>
        {hint ? <div className="text-[11px] text-content-muted">{hint}</div> : null}
        {trend && trend.length > 1 ? (
          <div className="mt-1 -mb-1">
            <Sparkline points={trend} color={sparkColor} height={20} strokeWidth={1.5} />
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}

function QuickStartCard({
  title,
  description,
  links,
  tone,
}: {
  title: string
  description: string
  links: { label: string; href: string }[]
  tone: 'brand' | 'amber' | 'emerald' | 'violet'
}) {
  const accent = {
    brand: 'border-brand-200/60 bg-brand-50/30',
    amber: 'border-amber-200/60 bg-amber-50/30',
    emerald: 'border-emerald-200/60 bg-emerald-50/30',
    violet: 'border-violet-200/60 bg-violet-50/30',
  }[tone]
  return (
    <Card className={`${accent} border`}>
      <CardBody className="space-y-3">
        <div>
          <div className="text-sm font-semibold text-content">{title}</div>
          <p className="mt-1 text-xs leading-relaxed text-content-muted">{description}</p>
        </div>
        <ul className="space-y-1">
          {links.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-700 hover:text-brand-800 hover:underline"
              >
                <IconArrow /> {l.label}
              </a>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  )
}

/* ─────────── icons ─────────── */

function IconActivity() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  )
}
function IconShieldAlert() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  )
}
function IconClock() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}
function IconCpu() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="2" x2="9" y2="4" />
      <line x1="15" y1="2" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="22" />
      <line x1="15" y1="20" x2="15" y2="22" />
      <line x1="20" y1="9" x2="22" y2="9" />
      <line x1="20" y1="15" x2="22" y2="15" />
      <line x1="2" y1="9" x2="4" y2="9" />
      <line x1="2" y1="15" x2="4" y2="15" />
    </svg>
  )
}
function IconBell() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}
function IconUsers() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}
function IconArrow() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}
