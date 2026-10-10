import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  SearchInput,
  Spinner,
  StatusBadge,
  Tabs,
  type StatusKind,
  type TabDef,
} from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import {
  matchesFilter,
  SEVERITIES,
  summarise,
  type RuntimeEngine,
  type RuntimeEvent,
  type RuntimeSeverity,
} from '../data/runtime-events.ts'
import { hookSummary, readPolicy, type PolicyView } from '../data/tracing-policy.ts'
import {
  useRuntimeAgents,
  useRuntimeEvents,
  useTetragonMetrics,
  useTracingPolicies,
  useTracingPoliciesNamespaced,
  type EngineStatus,
} from '../data/runtime.ts'

/**
 * Runtime Security — what is actually happening inside running workloads.
 *
 * Two engines, one page, because an operator investigating a workload wants
 * one feed in time order rather than two consoles:
 *
 *  - **Tetragon** (eBPF) reports process execution, and with a TracingPolicy
 *    loaded, file, network and syscall activity it can also enforce against.
 *  - **Falco** matches its rule library against syscalls and fires named
 *    alerts carrying MITRE technique tags.
 *
 * Everything on this page is read from the cluster: events from each agent's
 * container log, policies from the `cilium.io` CRDs, agent health from the
 * DaemonSets, and Tetragon's since-start totals from its metrics port. The
 * page previously read a BFF route that served seeded sample events, which is
 * why it reported "Couldn't reach Falco" against five healthy agents.
 *
 * An engine that is not installed is said to be not installed. Nothing here
 * invents an event.
 */

type Tab = 'overview' | 'events' | 'policies' | 'agents'

const SEVERITY_KIND: Record<RuntimeSeverity, StatusKind> = {
  critical: 'failed',
  high: 'degraded',
  medium: 'paused',
  low: 'info',
  info: 'unknown',
}

const SEVERITY_DOT: Record<RuntimeSeverity, string> = {
  critical: 'bg-rose-600',
  high: 'bg-rose-500',
  medium: 'bg-amber-500',
  low: 'bg-sky-500',
  info: 'bg-slate-400',
}

const ENGINE_LABEL: Record<RuntimeEngine, string> = { tetragon: 'Tetragon', falco: 'Falco' }

export function Runtime() {
  const [tab, setTab] = useState<Tab>('overview')
  const agents = useRuntimeAgents()
  const tetragon = agents.engines.find((e) => e.engine === 'tetragon')
  const falco = agents.engines.find((e) => e.engine === 'falco')
  const anyInstalled = agents.engines.some((e) => e.installed)

  const feed = useRuntimeEvents(agents.engines)
  const policies = useTracingPolicies(Boolean(tetragon?.installed))
  const nsPolicies = useTracingPoliciesNamespaced(Boolean(tetragon?.installed))
  const metrics = useTetragonMetrics(tetragon, Boolean(tetragon?.installed))

  const policyViews = useMemo(() => {
    const all = [...(policies.data ?? []), ...(nsPolicies.data ?? [])]
    return all
      .map((p) => readPolicy(p as unknown as Record<string, unknown>))
      .sort((a, b) => Number(b.enforcing) - Number(a.enforcing) || a.name.localeCompare(b.name))
  }, [policies.data, nsPolicies.data])

  const summary = useMemo(() => summarise(feed.events), [feed.events])

  if (agents.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Looking for runtime-security agents…
      </div>
    )
  }

  if (agents.isError) {
    return (
      <EmptyState
        title="Couldn't reach the cluster"
        description={agents.error instanceof Error ? agents.error.message : 'Unknown error listing DaemonSets.'}
      />
    )
  }

  if (!anyInstalled) {
    return (
      <EmptyState
        title="No runtime-security agent is installed"
        description="Runtime Security reads Tetragon and Falco where they run. Neither has a DaemonSet in this cluster, so there is nothing to observe yet."
      />
    )
  }

  const tabs: readonly TabDef<Tab>[] = [
    { id: 'overview', label: 'Overview' },
    {
      id: 'events',
      label: 'Events',
      badge: summary.total
        ? { kind: summary.bySeverity.critical ? 'failed' : 'info', value: summary.total }
        : undefined,
    },
    {
      id: 'policies',
      label: 'Policies',
      badge: policyViews.length ? { kind: 'unknown', value: policyViews.length } : undefined,
      disabled: !tetragon?.installed,
    },
    { id: 'agents', label: 'Agents' },
  ]

  return (
    <div className="space-y-5">
      <StatStrip
        summary={summary}
        engines={agents.engines}
        policies={policyViews}
        metrics={metrics.data}
      />

      {feed.failures > 0 ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <span aria-hidden>⚠</span>
          <span>
            {feed.failures} of {feed.total} agent pods would not return their log, so this feed is
            incomplete. Reading an agent's log needs <code className="font-mono">pods/log</code> on
            its namespace.
          </span>
        </div>
      ) : null}

      <Tabs<Tab>
        tabs={tabs}
        value={tab}
        onChange={setTab}
        ariaLabel="Runtime security"
        actions={
          <div className="flex items-center gap-2">
            {feed.isFetching ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-content-subtle">
                <Spinner size={12} /> live
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-content-subtle">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden /> live
              </span>
            )}
          </div>
        }
      >
        {(active) => (
          <>
            {active === 'overview' && (
              <OverviewTab
                summary={summary}
                engines={agents.engines}
                policies={policyViews}
                metrics={metrics.data}
                metricsError={metrics.isError ? metrics.error : undefined}
                loading={feed.isLoading}
                onSeeEvents={() => setTab('events')}
              />
            )}
            {active === 'events' && (
              <EventsTab events={feed.events} loading={feed.isLoading} engines={agents.engines} />
            )}
            {active === 'policies' && (
              <PoliciesTab
                policies={policyViews}
                loading={policies.isLoading}
                error={policies.isError ? policies.error : undefined}
                tetragon={tetragon}
              />
            )}
            {active === 'agents' && <AgentsTab engines={agents.engines} metrics={metrics.data} />}
          </>
        )}
      </Tabs>
    </div>
  )
}

/* ─────────── header ─────────── */

function StatStrip({
  summary,
  engines,
  policies,
  metrics,
}: {
  summary: ReturnType<typeof summarise>
  engines: EngineStatus[]
  policies: PolicyView[]
  metrics?: { eventsTotal: number; agentsScraped: number; agentsTotal: number }
}) {
  const installed = engines.filter((e) => e.installed)
  const ready = installed.reduce((n, e) => n + e.ready, 0)
  const desired = installed.reduce((n, e) => n + e.desired, 0)
  const enforcing = policies.filter((p) => p.enforcing).length
  const attention = summary.bySeverity.critical + summary.bySeverity.high

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <Stat
        label="Needs attention"
        value={attention}
        hint={attention ? 'critical + high, in the live window' : 'nothing critical in the window'}
        tone={attention ? 'failed' : 'healthy'}
      />
      <Stat
        label="Events / min"
        value={summary.rate || '—'}
        hint={summary.total ? `${summary.total} in the live window` : 'no events yet'}
      />
      <Stat
        label="Agents ready"
        value={`${ready}/${desired}`}
        hint={installed.map((e) => e.label).join(' + ') || 'none'}
        tone={desired && ready === desired ? 'healthy' : 'degraded'}
      />
      <Stat
        label="Tracing policies"
        value={policies.length}
        hint={enforcing ? `${enforcing} enforcing` : policies.length ? 'all observation only' : 'none loaded'}
        tone={enforcing ? 'progressing' : undefined}
      />
      <Stat
        label="Observed since start"
        value={metrics ? compact(metrics.eventsTotal) : '—'}
        hint={metrics
          ? metrics.agentsScraped === metrics.agentsTotal
            ? `Tetragon events across ${metrics.agentsScraped} agents`
            : `${metrics.agentsScraped} of ${metrics.agentsTotal} agents — partial`
          : 'agent metrics unavailable'}
        tone={metrics && metrics.agentsScraped < metrics.agentsTotal ? 'degraded' : undefined}
      />
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: number | string
  hint?: string
  tone?: StatusKind
}) {
  const toneText: Partial<Record<StatusKind, string>> = {
    healthy: 'text-emerald-600 dark:text-emerald-300',
    degraded: 'text-amber-600 dark:text-amber-300',
    failed: 'text-rose-600 dark:text-rose-300',
    progressing: 'text-indigo-600 dark:text-indigo-300',
  }
  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised px-3.5 py-3 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</div>
      <div
        className={cn(
          'mt-1 text-2xl font-semibold leading-none tabular-nums tracking-tight',
          tone ? toneText[tone] ?? 'text-content' : 'text-content',
        )}
      >
        {value}
      </div>
      {hint ? <div className="mt-1 truncate text-[11px] text-content-subtle">{hint}</div> : null}
    </div>
  )
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/* ─────────── overview ─────────── */

function OverviewTab({
  summary,
  engines,
  policies,
  metrics,
  metricsError,
  loading,
  onSeeEvents,
}: {
  summary: ReturnType<typeof summarise>
  engines: EngineStatus[]
  policies: PolicyView[]
  metrics?: {
    version?: string
    byType: Array<{ name: string; count: number }>
    byNamespace: Array<{ name: string; count: number }>
    byWorkload: Array<{ name: string; count: number }>
    missed: number
    errors: number
  }
  metricsError?: unknown
  loading: boolean
  onSeeEvents(): void
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {engines.map((e) => <EngineCard key={e.engine} engine={e} summary={summary} />)}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <RankCard
          title="What matched"
          caption="Falco rules and Tetragon policies, in the live window"
          rows={summary.rules}
          empty="Nothing in the window matched a rule or a policy — only ordinary process activity."
          onEmptyAction={summary.total ? onSeeEvents : undefined}
          loading={loading}
        />
        <RankCard
          title="Busiest namespaces"
          caption="in the live window"
          rows={summary.namespaces}
          empty="No namespaced activity in the window."
          loading={loading}
        />
        <RankCard
          title="Most active binaries"
          caption="in the live window"
          rows={summary.binaries}
          empty="No process activity in the window."
          loading={loading}
        />
      </div>

      {metrics ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <RankCard title="Events by type" caption="Tetragon, since agent start" rows={metrics.byType} empty="—" />
          <RankCard
            title="Namespaces by volume"
            caption="Tetragon, since agent start"
            rows={metrics.byNamespace}
            empty="—"
          />
          <RankCard
            title="Workloads by volume"
            caption="Tetragon, since agent start"
            rows={metrics.byWorkload}
            empty="—"
          />
        </div>
      ) : metricsError ? (
        <div className="rounded-lg border border-edge-default bg-surface-sunken/40 px-3 py-2 text-[11px] text-content-subtle">
          Tetragon's since-start totals are unavailable:{' '}
          {metricsError instanceof Error ? metricsError.message : 'the metrics port could not be read'}.
          Reading them needs <code className="font-mono">services/proxy</code> on the agent's
          namespace. Everything else on this page is unaffected.
        </div>
      ) : null}

      {metrics && (metrics.missed > 0 || metrics.errors > 0) ? (
        <div className="rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          Tetragon reports {metrics.missed} missed probe{metrics.missed === 1 ? '' : 's'} and{' '}
          {metrics.errors} internal error{metrics.errors === 1 ? '' : 's'} since start — the feed
          below is a sample of what happened, not a complete record of it.
        </div>
      ) : null}

      {policies.length === 0 ? (
        <Card>
          <CardBody>
            <div className="text-[13px] font-semibold text-content">No TracingPolicy is loaded</div>
            <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-content-muted">
              Tetragon observes process execution out of the box, which is what the feed is showing.
              File access, network connections and syscall-level activity — and the ability to kill
              a process that crosses a line — need a TracingPolicy. They are ordinary cluster
              resources (<code className="font-mono">cilium.io/v1alpha1</code>), so they belong in
              the same GitOps repository as the rest of the platform.
            </p>
          </CardBody>
        </Card>
      ) : null}
    </div>
  )
}

function EngineCard({ engine: e, summary }: { engine: EngineStatus; summary: ReturnType<typeof summarise> }) {
  const count = summary.byEngine[e.engine] ?? 0
  const healthy = e.installed && e.desired > 0 && e.ready === e.desired
  return (
    <Card className={cn(!e.installed && 'opacity-75')}>
      <CardBody>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold text-content">{e.label}</span>
              {e.version ? (
                <span className="rounded-full bg-surface-sunken px-1.5 py-px font-mono text-[10px] text-content-muted">
                  {e.version}
                </span>
              ) : null}
            </div>
            <div className="mt-1 text-[11px] text-content-subtle">
              {e.installed
                ? `${e.namespace} · ${e.ready}/${e.desired} node agents ready`
                : 'not installed in this cluster'}
            </div>
          </div>
          <StatusBadge kind={!e.installed ? 'unknown' : healthy ? 'healthy' : 'degraded'}>
            {!e.installed ? 'Absent' : healthy ? 'Healthy' : `${e.ready}/${e.desired}`}
          </StatusBadge>
        </div>

        <p className="mt-3 text-[12px] leading-relaxed text-content-muted">
          {e.engine === 'tetragon'
            ? 'eBPF process, file and network observability, and the only engine here that can stop what it sees.'
            : 'Rule-based syscall detection with MITRE ATT&CK technique tags on every alert.'}
        </p>

        <div className="mt-3 flex items-baseline gap-2 border-t border-edge-subtle pt-3">
          <span className="text-xl font-semibold tabular-nums text-content">{count}</span>
          <span className="text-[11px] text-content-subtle">events in the live window</span>
        </div>
      </CardBody>
    </Card>
  )
}

function RankCard({
  title,
  caption,
  rows,
  empty,
  loading,
  onEmptyAction,
}: {
  title: string
  caption: string
  rows: Array<{ name: string; count: number }>
  empty: string
  loading?: boolean
  onEmptyAction?(): void
}) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <Card>
      <CardHeader>
        <div className="text-[13px] font-semibold text-content">{title}</div>
        <div className="text-[11px] text-content-subtle">{caption}</div>
      </CardHeader>
      <CardBody className="pt-0!">
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-[12px] text-content-subtle">
            <Spinner size={12} /> reading agent logs…
          </div>
        ) : rows.length === 0 ? (
          <div className="py-3 text-[12px] leading-relaxed text-content-subtle">
            {empty}
            {onEmptyAction ? (
              <button
                type="button"
                onClick={onEmptyAction}
                className="ml-1 font-medium text-brand-700 hover:underline dark:text-brand-300"
              >
                See the feed →
              </button>
            ) : null}
          </div>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li key={r.name}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[12px] text-content" title={r.name}>{r.name}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-content-subtle">
                    {compact(r.count)}
                  </span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-sunken">
                  <span
                    className="block h-full rounded-full bg-brand-500/70"
                    style={{ width: `${Math.max(3, (r.count / max) * 100)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

/* ─────────── events ─────────── */

function EventsTab({
  events,
  loading,
  engines,
}: {
  events: RuntimeEvent[]
  loading: boolean
  engines: EngineStatus[]
}) {
  const [search, setSearch] = useState('')
  const [severities, setSeverities] = useState<RuntimeSeverity[]>([])
  const [selectedEngines, setSelectedEngines] = useState<RuntimeEngine[]>([])
  const [namespace, setNamespace] = useState('')
  const [open, setOpen] = useState<RuntimeEvent | null>(null)
  // On by default. A busy cluster executes thousands of `dirname`, `awk` and
  // readiness-probe processes a minute; shown raw, they are the entire feed
  // and every rule detection is thousands of rows down it. These are the
  // events that matched nothing, so hiding them loses no finding — and the
  // control is visible, stating that the feed is filtered.
  const [hideRoutine, setHideRoutine] = useState(true)
  const [limit, setLimit] = useState(200)

  const namespaces = useMemo(
    () => [...new Set(events.map((e) => e.namespace).filter((n): n is string => !!n))].sort(),
    [events],
  )
  const filtered = useMemo(
    () =>
      events.filter((e) =>
        (!hideRoutine || e.severity !== 'info') &&
        matchesFilter(e, { search, severities, engines: selectedEngines, namespace: namespace || undefined })
      ),
    [events, search, severities, selectedEngines, namespace, hideRoutine],
  )
  const routine = events.length - events.filter((e) => e.severity !== 'info').length
  // The DOM, not the data, is the limit: a few thousand rows is a slow page
  // and nobody reads past the first screen of a live feed.
  const shown = filtered.slice(0, limit)

  const toggle = <T,>(list: T[], v: T, set: (next: T[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  const installed = engines.filter((e) => e.installed)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[220px] flex-1">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search pod, binary, rule, namespace…"
            label="Search runtime events"
          />
        </div>
        {installed.length > 1
          ? installed.map((e) => (
            <FilterChip
              key={e.engine}
              on={selectedEngines.includes(e.engine)}
              onClick={() => toggle(selectedEngines, e.engine, setSelectedEngines)}
            >
              {ENGINE_LABEL[e.engine]}
            </FilterChip>
          ))
          : null}
        {SEVERITIES.map((s) => (
          <FilterChip key={s} on={severities.includes(s)} onClick={() => toggle(severities, s, setSeverities)}>
            <span className={cn('h-1.5 w-1.5 rounded-full', SEVERITY_DOT[s])} aria-hidden />
            {s}
          </FilterChip>
        ))}
        <FilterChip on={hideRoutine} onClick={() => setHideRoutine((v) => !v)}>
          Hide routine
        </FilterChip>
        <select
          value={namespace}
          onChange={(e) => setNamespace(e.target.value)}
          aria-label="Namespace"
          className="h-8 rounded-lg border border-edge-default bg-surface-raised px-2 text-[12px] text-content outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-400/20"
        >
          <option value="">All namespaces</option>
          {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      <div className="text-[11px] text-content-subtle">
        {filtered.length === events.length
          ? `${events.length} events`
          : `${filtered.length} of ${events.length} events`}
        {hideRoutine && routine
          ? (
            <>
              {' · '}
              <button
                type="button"
                onClick={() => setHideRoutine(false)}
                className="font-medium text-brand-700 hover:underline dark:text-brand-300"
              >
                {routine} routine process event{routine === 1 ? '' : 's'} hidden
              </button>
            </>
          )
          : null}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted">
          <Spinner size={14} /> Reading agent logs…
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          compact
          title={events.length ? 'No matching events' : 'No events in the current window'}
          description={events.length
            ? hideRoutine && routine
              ? `Relax the filters, or show the ${routine} routine process events that matched no rule.`
              : 'Relax the filters or the search.'
            : 'The agents are running but have not reported anything in the tail this page reads. Activity appears here as it happens.'}
        />
      ) : (
        <Card>
          <CardBody className="p-0!">
            <ul className="divide-y divide-edge-subtle">
              {shown.map((e) => <EventRow key={e.id} event={e} onOpen={() => setOpen(e)} />)}
            </ul>
            {filtered.length > shown.length ? (
              <div className="border-t border-edge-subtle px-4 py-3 text-center">
                <button
                  type="button"
                  onClick={() => setLimit((n) => n + 500)}
                  className="text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300"
                >
                  Show more — {filtered.length - shown.length} older events in this window
                </button>
              </div>
            ) : null}
          </CardBody>
        </Card>
      )}

      {open ? <EventDrawer event={open} onClose={() => setOpen(null)} /> : null}
    </div>
  )
}

function FilterChip({
  on,
  onClick,
  children,
}: {
  on: boolean
  onClick(): void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium capitalize transition-colors',
        on
          ? 'border-brand-300 bg-brand-50 text-brand-800 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-200'
          : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

function EventRow({ event: e, onOpen }: { event: RuntimeEvent; onOpen(): void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-sunken/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400/40"
      >
        <span
          className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', SEVERITY_DOT[e.severity])}
          aria-label={e.severity}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-[13px] font-medium text-content">{e.title}</span>
            <span className="shrink-0 rounded-full bg-surface-sunken px-1.5 py-px text-[10px] font-medium text-content-muted">
              {ENGINE_LABEL[e.engine]}
            </span>
            {e.action ? (
              <span className="shrink-0 rounded-full bg-rose-100 px-1.5 py-px text-[10px] font-semibold text-rose-800 dark:bg-rose-500/15 dark:text-rose-300">
                {e.action}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-content-subtle">
            {e.namespace ? <span className="truncate">{e.namespace}/{e.pod ?? '—'}</span> : <span>host</span>}
            {e.container ? <span className="truncate">· {e.container}</span> : null}
            {e.binary ? <span className="truncate font-mono">· {e.binary}</span> : null}
          </span>
        </span>
        <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-content-subtle" title={e.time}>
          {e.time ? formatRelative(e.time) : '—'}
        </span>
      </button>
    </li>
  )
}

function EventDrawer({ event: e, onClose }: { event: RuntimeEvent; onClose(): void }) {
  useEffect(() => {
    const onKey = (k: KeyboardEvent) => {
      if (k.key === 'Escape') onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])
  if (typeof document === 'undefined') return null

  const rows = Object.entries(e.fields).filter(([, v]) => v !== '')

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
                {ENGINE_LABEL[e.engine]} · {e.kind}
              </div>
              <h2 className="mt-1 flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight text-content">
                {e.title}
                <StatusBadge kind={SEVERITY_KIND[e.severity]}>{e.severity}</StatusBadge>
              </h2>
              <p className="mt-1 text-[12px] text-content-muted">{e.reason}</p>
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
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Where</h3>
            <dl className="mt-2 space-y-1.5">
              <Row label="Namespace" value={e.namespace ?? 'host (no pod)'} />
              <Row label="Pod" value={e.pod} />
              <Row label="Container" value={e.container} />
              <Row label="Image" value={e.image} mono />
              <Row label="Node" value={e.node} />
            </dl>
          </section>

          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Process</h3>
            <dl className="mt-2 space-y-1.5">
              {/* Parent before child: which process started this one is the
                  first question asked of any unexpected execution. */}
              <Row label="Parent" value={e.parent} mono />
              <Row label="Binary" value={e.binary} mono />
              <Row label="Arguments" value={e.args} mono />
              <Row label="PID" value={e.pid !== undefined ? String(e.pid) : undefined} />
              <Row label="User" value={e.user ?? (e.uid !== undefined ? `uid ${e.uid}` : undefined)} />
              <Row label="Time" value={e.time} />
            </dl>
          </section>

          {e.policy || e.hook || e.action ? (
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
                {e.engine === 'falco' ? 'Rule' : 'Policy'}
              </h3>
              <dl className="mt-2 space-y-1.5">
                <Row label={e.engine === 'falco' ? 'Rule' : 'TracingPolicy'} value={e.policy} />
                <Row label="Hook" value={e.hook} mono />
                <Row label="Enforcement" value={e.action} />
              </dl>
            </section>
          ) : null}

          {e.tags.length ? (
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
                Tags
              </h3>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {e.tags.map((t) => (
                  <span
                    key={t}
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10px] font-medium',
                      /^T\d{4}/.test(t) || t.startsWith('mitre')
                        ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300'
                        : 'bg-surface-sunken text-content-muted',
                    )}
                    title={/^T\d{4}/.test(t) ? 'MITRE ATT&CK technique' : undefined}
                  >
                    {t}
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
              Everything the agent reported
            </h3>
            <dl className="mt-2 space-y-1">
              {rows.map(([k, v]) => <Row key={k} label={k} value={v} mono small />)}
            </dl>
          </section>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function Row({
  label,
  value,
  mono,
  small,
}: {
  label: string
  value?: string
  mono?: boolean
  small?: boolean
}) {
  if (!value) return null
  return (
    <div className="flex gap-3">
      <dt className={cn('w-28 shrink-0 text-content-subtle', small ? 'text-[11px]' : 'text-[12px]')}>
        {label}
      </dt>
      <dd
        className={cn(
          'min-w-0 flex-1 break-words text-content',
          small ? 'text-[11px]' : 'text-[12px]',
          mono && 'font-mono',
        )}
      >
        {value}
      </dd>
    </div>
  )
}

/* ─────────── policies ─────────── */

function PoliciesTab({
  policies,
  loading,
  error,
  tetragon,
}: {
  policies: PolicyView[]
  loading: boolean
  error?: unknown
  tetragon?: EngineStatus
}) {
  const [open, setOpen] = useState<PolicyView | null>(null)

  if (!tetragon?.installed) {
    return (
      <EmptyState
        compact
        title="Tetragon is not installed"
        description="TracingPolicies are Tetragon resources. Falco's rules are built into its own configuration and are not Kubernetes objects."
      />
    )
  }
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted">
        <Spinner size={14} /> Loading tracing policies…
      </div>
    )
  }
  if (error) {
    return (
      <EmptyState
        compact
        title="Couldn't read TracingPolicies"
        description={error instanceof Error ? error.message : 'Unknown error listing cilium.io/v1alpha1 tracingpolicies.'}
      />
    )
  }
  if (policies.length === 0) {
    return (
      <EmptyState
        title="No TracingPolicy is loaded"
        description="Tetragon still reports process execution, which is what the Events tab is showing. A TracingPolicy adds file, network and syscall visibility — and is the only way to make Tetragon enforce rather than observe."
      />
    )
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardBody className="p-0!">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-edge-subtle text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                <th className="px-4 py-2">Policy</th>
                <th className="px-4 py-2">Scope</th>
                <th className="px-4 py-2">Hooks</th>
                <th className="px-4 py-2">Mode</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge-subtle">
              {policies.map((p) => (
                <tr
                  key={`${p.namespace ?? '-'}/${p.name}`}
                  className="cursor-pointer transition-colors hover:bg-surface-sunken/50"
                  onClick={() => setOpen(p)}
                >
                  <td className="px-4 py-2.5">
                    <div className="text-[13px] font-medium text-content">{p.name}</div>
                    {p.selector ? (
                      <div className="truncate text-[11px] text-content-subtle">{p.selector}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-[12px] text-content-muted">
                    {p.scope === 'cluster' ? 'Cluster-wide' : p.namespace}
                  </td>
                  <td className="px-4 py-2.5 text-[12px] text-content-muted">{hookSummary(p)}</td>
                  <td className="px-4 py-2.5">
                    {/* The distinction that decides whether a policy is safe to
                        roll out: observing is reversible, enforcing kills. */}
                    <StatusBadge kind={p.enforcing ? 'failed' : 'info'}>
                      {p.enforcing ? 'Enforcing' : 'Observing'}
                    </StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>

      {open ? <PolicyDrawer policy={open} onClose={() => setOpen(null)} /> : null}
    </div>
  )
}

function PolicyDrawer({ policy: p, onClose }: { policy: PolicyView; onClose(): void }) {
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
      <aside className="relative flex h-full w-full max-w-lg flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
              TracingPolicy
            </div>
            <h2 className="mt-1 flex items-center gap-2 text-lg font-semibold tracking-tight text-content">
              {p.name}
              <StatusBadge kind={p.enforcing ? 'failed' : 'info'}>
                {p.enforcing ? 'Enforcing' : 'Observing'}
              </StatusBadge>
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
          >
            ✕
          </button>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <dl className="space-y-1.5">
            <Row label="Scope" value={p.scope === 'cluster' ? 'Cluster-wide' : `Namespace ${p.namespace}`} />
            <Row label="Selector" value={p.selector ?? 'every pod in scope'} />
            <Row label="Actions" value={p.actions.join(', ') || 'none declared'} />
            <Row label="Created" value={p.created} />
          </dl>

          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
              Hooks ({p.hooks.length})
            </h3>
            <ul className="mt-2 divide-y divide-edge-subtle rounded-lg border border-edge-subtle">
              {p.hooks.map((h, i) => (
                <li key={`${h.type}:${h.name}:${i}`} className="flex items-center gap-2 px-3 py-2">
                  <span className="w-20 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                    {h.type}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-content">{h.name}</span>
                  {h.enforcing ? (
                    <span className="shrink-0 rounded-full bg-rose-100 px-1.5 py-px text-[10px] font-semibold text-rose-800 dark:bg-rose-500/15 dark:text-rose-300">
                      enforces
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

/* ─────────── agents ─────────── */

function AgentsTab({
  engines,
  metrics,
}: {
  engines: EngineStatus[]
  metrics?: { version?: string; missed: number; errors: number; eventsTotal: number }
}) {
  return (
    <div className="space-y-4">
      {engines.map((e) => (
        <Card key={e.engine}>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[14px] font-semibold text-content">{e.label}</div>
                <div className="mt-0.5 truncate text-[11px] text-content-subtle">
                  {e.installed
                    ? `${e.namespace} · ${e.ready} of ${e.desired} node agents ready${
                      e.version ? ` · ${e.version}` : ''
                    }`
                    : 'not installed in this cluster'}
                </div>
              </div>
              <StatusBadge kind={!e.installed ? 'unknown' : e.ready === e.desired ? 'healthy' : 'degraded'}>
                {!e.installed ? 'Absent' : e.ready === e.desired ? 'Healthy' : 'Degraded'}
              </StatusBadge>
            </div>
          </CardHeader>
          {e.installed ? (
            <CardBody className="p-0!">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-edge-subtle text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                    <th className="px-4 py-2">Node</th>
                    <th className="px-4 py-2">Pod</th>
                    <th className="px-4 py-2">Phase</th>
                    <th className="px-4 py-2">Restarts</th>
                    <th className="px-4 py-2">Age</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge-subtle">
                  {e.pods.map((p) => (
                    <tr key={p.name}>
                      <td className="px-4 py-2 text-[12px] text-content">{p.node ?? '—'}</td>
                      <td className="px-4 py-2 font-mono text-[11px] text-content-muted">{p.name}</td>
                      <td className="px-4 py-2">
                        <StatusBadge kind={p.ready ? 'healthy' : 'degraded'}>{p.phase}</StatusBadge>
                      </td>
                      <td
                        className={cn(
                          'px-4 py-2 text-[12px] tabular-nums',
                          p.restarts ? 'text-amber-700 dark:text-amber-400' : 'text-content-muted',
                        )}
                      >
                        {p.restarts}
                      </td>
                      <td className="px-4 py-2 text-[12px] text-content-muted">
                        {p.age ? formatRelative(p.age) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          ) : (
            <CardBody>
              <p className="text-[12px] leading-relaxed text-content-muted">
                {e.engine === 'tetragon'
                  ? 'Tetragon is an optional package. Without it this page falls back to Falco alone, and no policy can enforce.'
                  : 'Falco is an optional package. Without it this page reports Tetragon process activity but no named rule detections.'}
              </p>
            </CardBody>
          )}
          {e.engine === 'tetragon' && e.installed && metrics ? (
            <CardBody className="border-t border-edge-subtle pt-3 text-[11px] text-content-subtle">
              {compact(metrics.eventsTotal)} events exported since start · {metrics.missed} missed
              probes · {metrics.errors} internal errors
            </CardBody>
          ) : null}
        </Card>
      ))}
    </div>
  )
}

export default Runtime
