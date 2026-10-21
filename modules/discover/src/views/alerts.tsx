import { type ReactNode, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, Modal, PrometheusIcon, useElementWidth, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import {
  type AlertGroup,
  type AmMatcher,
  type AmSilence,
  flattenRoutes,
  type GroupBy,
  groupAlerts,
  inhibitSides,
  type Lane,
  matcherText,
  parseMatchers,
  type PromRule,
  routeMatchers,
  severityRank,
  silenceMatchersFor,
  silenceMatches,
  since,
  type UAlert,
  type UState,
} from '../data/alerting.ts'
import {
  useAlertTimeline,
  useAmTarget,
  useCreateSilence,
  useExpireSilence,
  useRouting,
  useRules,
  useSilences,
  useUnifiedAlerts,
} from '../data/alerting-api.ts'
import { readParam } from '../data/discover-nav.ts'
import { LoadingCard, SourceError } from './states.tsx'
import {
  copyText,
  Drawer,
  IconBad,
  IconChevronRight,
  IconCopy,
  IconExternal,
  IconMute,
  IconNoData,
  IconOk,
  IconPending,
  IconPlus,
  IconWarn,
  InlineHint,
  KvTable,
  MiniSelect,
  Panel,
  Segmented,
  StatTile,
} from './discover-ui.tsx'

/**
 * Alerts — Prometheus rules + Alertmanager, in one place.
 *
 *   • Alerts    firing / pending / silenced / inhibited, grouped by alert,
 *               severity or namespace; detail drawer with labels, annotations,
 *               runbook, the rule's PromQL, receivers and a silence action.
 *   • Timeline  `ALERTS` history as swimlanes (firing vs pending).
 *   • Rules     every alerting rule with its state, health and expression.
 *   • Silences  active / pending / expired; create (prefilled from an alert)
 *               and expire (confirmed).
 *   • Routing   Alertmanager route tree, receivers and inhibition rules.
 *
 * Alertmanager is reached through Grafana's Alertmanager datasource; when it
 * isn't reachable the page says so and shows Prometheus state only.
 */

type Tab = 'alerts' | 'timeline' | 'rules' | 'silences' | 'routing'

const STATE_META: Record<UState, { label: string; cls: string; icon: () => ReactNode }> = {
  firing: { label: 'Firing', cls: 'text-rose-700 dark:text-rose-300', icon: IconBad },
  pending: { label: 'Pending', cls: 'text-amber-700 dark:text-amber-300', icon: IconPending },
  silenced: { label: 'Silenced', cls: 'text-content-muted', icon: IconMute },
  inhibited: { label: 'Inhibited', cls: 'text-content-muted', icon: IconNoData },
}

function SeverityTag({ severity }: { severity: string }) {
  const r = severityRank(severity)
  const cls = r === 0
    ? 'border-rose-300 text-rose-700 dark:border-rose-500/40 dark:text-rose-300'
    : r === 1
      ? 'border-amber-300 text-amber-800 dark:border-amber-500/40 dark:text-amber-300'
      : 'border-edge-default text-content-muted'
  const Icon = r === 0 ? IconBad : r === 1 ? IconWarn : IconNoData
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide', cls)}>
      <Icon /> {severity}
    </span>
  )
}

function StateTag({ state }: { state: UState }) {
  const m = STATE_META[state]
  const I = m.icon
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 text-[11px] font-medium', m.cls)}>
      <I /> {m.label}
    </span>
  )
}

export function Alerts() {
  const [tab, setTab] = useState<Tab>('alerts')
  const q = useUnifiedAlerts()
  const silences = useSilences()
  const [silenceDraft, setSilenceDraft] = useState<AmMatcher[] | null>(null)

  const alerts = useMemo(() => q.data?.alerts ?? [], [q.data])
  const counts = useMemo(() => {
    const c: Record<UState, number> = { firing: 0, pending: 0, silenced: 0, inhibited: 0 }
    for (const a of alerts) c[a.state]++
    return c
  }, [alerts])
  const activeSilences = (silences.data ?? []).filter((s) => s.status?.state === 'active').length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={tab}
          onChange={setTab}
          ariaLabel="Alerting view"
          options={[
            { id: 'alerts', label: 'Alerts', count: counts.firing + counts.pending },
            { id: 'timeline', label: 'Timeline' },
            { id: 'rules', label: 'Rules' },
            { id: 'silences', label: 'Silences', count: silences.data ? activeSilences : undefined },
            { id: 'routing', label: 'Routing' },
          ]}
        />
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="primary" leading={<IconPlus />} onClick={() => setSilenceDraft([])}>
            New silence
          </Button>
        </div>
      </div>

      {tab === 'alerts' ? (
        <AlertsTab q={q} counts={counts} onSilence={(m) => setSilenceDraft(m)} silences={silences.data ?? []} />
      ) : tab === 'timeline' ? (
        <TimelineTab />
      ) : tab === 'rules' ? (
        <RulesTab />
      ) : tab === 'silences' ? (
        <SilencesTab alerts={alerts} onNew={(m) => setSilenceDraft(m)} />
      ) : (
        <RoutingTab />
      )}

      {silenceDraft ? <SilenceEditor initial={silenceDraft} alerts={alerts} onClose={() => setSilenceDraft(null)} /> : null}
    </div>
  )
}

/* ─────────────────────── alerts tab ─────────────────────── */

function AlertsTab({
  q,
  counts,
  onSilence,
  silences,
}: {
  q: ReturnType<typeof useUnifiedAlerts>
  counts: Record<UState, number>
  onSilence(m: AmMatcher[]): void
  silences: AmSilence[]
}) {
  // Deep-link context: ?section=alerts&service=&namespace=&severity=&state=
  const boot = useMemo(() => {
    const st = readParam('state')
    return {
      state: (['active', 'firing', 'pending', 'silenced', 'inhibited', 'all'].includes(st ?? '') ? st : 'active') as 'active' | UState | 'all',
      service: readParam('service'),
      namespace: readParam('namespace'),
      severity: readParam('severity'),
    }
  }, [])
  const [groupBy, setGroupBy] = useState<GroupBy>('alertname')
  const [stateFilter, setStateFilter] = useState<'active' | UState | 'all'>(boot.state)
  const [text, setText] = useState('')
  const [scope, setScope] = useState<{ service?: string; namespace?: string; severity?: string }>({
    service: boot.service,
    namespace: boot.namespace,
    severity: boot.severity,
  })
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const rules = useRules()

  const all = useMemo(() => q.data?.alerts ?? [], [q.data])
  const filtered = useMemo(() => {
    const t = text.trim().toLowerCase()
    return all.filter((a) => {
      if (scope.namespace && a.labels.namespace !== scope.namespace) return false
      if (scope.severity && a.severity !== scope.severity.toLowerCase()) return false
      if (scope.service && ![a.labels.service, a.labels.job, a.labels.app, a.labels.container, a.labels.deployment].includes(scope.service)) return false
      if (stateFilter === 'active' && a.state !== 'firing' && a.state !== 'pending') return false
      if (stateFilter !== 'active' && stateFilter !== 'all' && a.state !== stateFilter) return false
      if (!t) return true
      return a.name.toLowerCase().includes(t) ||
        Object.entries(a.labels).some(([k, v]) => `${k}=${v}`.toLowerCase().includes(t)) ||
        (a.annotations.summary ?? '').toLowerCase().includes(t)
    })
  }, [all, stateFilter, text, scope])
  const groups = useMemo(() => groupAlerts(filtered, groupBy), [filtered, groupBy])
  const open = all.find((a) => a.key === openKey) ?? null

  if (q.isLoading) return <LoadingCard label="Loading alerts from Prometheus and Alertmanager…" />
  if (q.isError) return <SourceError tool="Prometheus" error={q.error} onRetry={() => q.refetch()} icon={<PrometheusIcon size={20} />} />

  const critical = all.filter((a) => a.state === 'firing' && severityRank(a.severity) === 0).length

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Firing" value={counts.firing} tone={counts.firing ? 'bad' : 'ok'} icon={counts.firing ? <IconBad /> : <IconOk />} hint={critical ? `${critical} critical` : counts.firing ? 'none critical' : 'nothing firing'} />
        <StatTile label="Pending" value={counts.pending} tone={counts.pending ? 'warn' : undefined} icon={counts.pending ? <IconPending /> : undefined} hint="waiting out the rule's for: duration" />
        <StatTile label="Silenced" value={q.data?.amError ? '—' : counts.silenced} hint={q.data?.amError ? 'Alertmanager unreachable' : `${silences.filter((s) => s.status?.state === 'active').length} active silences`} />
        <StatTile label="Inhibited" value={q.data?.amError ? '—' : counts.inhibited} hint="muted by a higher-severity alert" />
      </div>

      {q.data?.amError ? (
        <InlineHint>
          Alertmanager isn't reachable through Grafana's Alertmanager datasource, so silenced and inhibited states are unknown and silences can't be managed — showing what Prometheus evaluates.{' '}
          <span className="text-content-subtle">({(q.data.amError as Error)?.message ?? 'unreachable'})</span>
        </InlineHint>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="xs"
          value={stateFilter}
          onChange={setStateFilter}
          ariaLabel="State filter"
          options={[
            { id: 'active', label: 'Active', count: counts.firing + counts.pending },
            { id: 'firing', label: 'Firing', count: counts.firing },
            { id: 'pending', label: 'Pending', count: counts.pending },
            { id: 'silenced', label: 'Silenced', count: counts.silenced },
            { id: 'inhibited', label: 'Inhibited', count: counts.inhibited },
            { id: 'all', label: 'All', count: all.length },
          ]}
        />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Filter by name, label or summary…"
          aria-label="Filter alerts"
          className="h-8 min-w-50 flex-1 rounded-md border border-edge-default bg-surface-raised px-2.5 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none"
        />
        {Object.entries(scope).filter(([, v]) => v).map(([k, v]) => (
          <button
            key={k}
            type="button"
            onClick={() => setScope((cur) => ({ ...cur, [k]: undefined }))}
            title="Remove filter"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-brand-300 bg-brand-50 px-2 font-mono text-[11px] text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300"
          >
            {k}={v} <span aria-hidden>×</span>
          </button>
        ))}
        <MiniSelect
          label="Group by"
          value={groupBy}
          onChange={(v) => setGroupBy(v as GroupBy)}
          options={[['alertname', 'Group: alert'], ['severity', 'Group: severity'], ['namespace', 'Group: namespace'], ['none', 'No grouping']]}
        />
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon={<PrometheusIcon size={20} />}
          title={all.length ? 'Nothing matches this filter' : 'No active alerts'}
          description={all.length
            ? 'Change the state filter or search to see the other alerts.'
            : 'Prometheus reports no firing or pending alerts. Rules are still evaluated — see the Rules tab for their state.'}
        />
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <GroupCard
              key={g.key}
              group={g}
              groupBy={groupBy}
              collapsed={collapsed.has(g.key)}
              onToggle={() => setCollapsed((cur) => {
                const n = new Set(cur)
                if (n.has(g.key)) n.delete(g.key)
                else n.add(g.key)
                return n
              })}
              onOpen={setOpenKey}
            />
          ))}
        </div>
      )}

      <AlertDrawer
        alert={open}
        rules={rules.data ?? []}
        silences={silences}
        canSilence={!q.data?.amError}
        onClose={() => setOpenKey(null)}
        onSilence={onSilence}
      />
    </div>
  )
}

function GroupCard({
  group: g,
  groupBy,
  collapsed,
  onToggle,
  onOpen,
}: {
  group: AlertGroup
  groupBy: GroupBy
  collapsed: boolean
  onToggle(): void
  onOpen(key: string): void
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
      <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="flex w-full flex-wrap items-center gap-2 px-4 py-2.5 text-left hover:bg-surface-sunken/40">
        <IconChevronRight open={!collapsed} />
        {groupBy !== 'severity' ? <SeverityTag severity={g.worstSeverity} /> : null}
        <span className="truncate text-sm font-semibold text-content">{g.key}</span>
        <span className="ml-auto flex flex-wrap items-center gap-3 text-[11px]">
          {(['firing', 'pending', 'silenced', 'inhibited'] as UState[]).filter((s) => g.counts[s]).map((s) => (
            <span key={s} className={cn('inline-flex items-center gap-1', STATE_META[s].cls)}>
              {STATE_META[s].icon()} {g.counts[s]} {STATE_META[s].label.toLowerCase()}
            </span>
          ))}
        </span>
      </button>
      {collapsed ? null : (
        <ul className="divide-y divide-edge-subtle border-t border-edge-subtle">
          {g.alerts.map((a) => (
            <li key={a.key}>
              <button type="button" onClick={() => onOpen(a.key)} className="block w-full px-4 py-2.5 text-left hover:bg-surface-sunken/40">
                <div className="flex flex-wrap items-center gap-2">
                  <StateTag state={a.state} />
                  {groupBy === 'severity' || groupBy === 'none' || groupBy === 'namespace' ? <SeverityTag severity={a.severity} /> : null}
                  {groupBy !== 'alertname' ? <span className="truncate text-[13px] font-medium text-content">{a.name}</span> : null}
                  <span className="truncate text-[12px] text-content-muted">{a.annotations.summary ?? a.annotations.message ?? ''}</span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-content-subtle" title={a.startsAt}>
                    {a.startsAt ? `for ${since(a.startsAt)}` : ''}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1 font-mono text-[10px] text-content-subtle">
                  {Object.entries(a.labels)
                    .filter(([k]) => k !== 'alertname' && k !== 'severity')
                    .slice(0, 6)
                    .map(([k, v]) => (
                      <span key={k} className="rounded bg-surface-sunken px-1.5 py-0.5"><span className="opacity-60">{k}=</span>{v}</span>
                    ))}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function findRule(rules: Array<{ name: string; file: string; rules: PromRule[] }>, a: UAlert): { rule: PromRule; group: string; file: string } | null {
  for (const g of rules) {
    for (const r of g.rules) {
      if (r.type !== 'alerting' || r.name !== a.name) continue
      // Several rules can share a name (different severities) — prefer the one
      // whose static labels match this alert.
      const ok = Object.entries(r.labels ?? {}).every(([k, v]) => a.labels[k] === v)
      if (ok) return { rule: r, group: g.name, file: g.file }
    }
  }
  return null
}

function AlertDrawer({
  alert: a,
  rules,
  silences,
  canSilence,
  onClose,
  onSilence,
}: {
  alert: UAlert | null
  rules: Array<{ name: string; file: string; rules: PromRule[] }>
  silences: AmSilence[]
  canSilence: boolean
  onClose(): void
  onSilence(m: AmMatcher[]): void
}) {
  const toast = useToast()
  if (!a) return null
  const rule = findRule(rules, a)
  const runbook = a.annotations.runbook_url ?? a.annotations.runbook
  const dashboard = a.annotations.dashboard_url ?? a.annotations.dashboard
  const silencedBy = silences.filter((s) => a.silencedBy.includes(s.id))
  const annotations = Object.entries(a.annotations).filter(([k]) => !['summary', 'description', 'message'].includes(k))
  return (
    <Drawer
      widthId="discover.alert"
      open
      onClose={onClose}
      width="max-w-3xl"
      title={a.name}
      badges={<><StateTag state={a.state} /><SeverityTag severity={a.severity} /></>}
      subtitle={<>{a.startsAt ? `active for ${since(a.startsAt)} · since ${new Date(a.startsAt).toLocaleString()}` : ''}{a.value != null ? ` · current value ${fmtVal(a.value)}` : ''}</>}
      actions={canSilence && (a.state === 'firing' || a.state === 'pending') ? (
        <Button size="sm" variant="primary" leading={<IconMute />} onClick={() => onSilence(silenceMatchersFor(a.labels))}>Silence…</Button>
      ) : null}
    >
      <div className="space-y-4 p-5">
        {a.annotations.summary || a.annotations.description || a.annotations.message ? (
          <Panel title="Summary">
            {a.annotations.summary ? <p className="text-sm text-content">{a.annotations.summary}</p> : null}
            {a.annotations.description || a.annotations.message ? (
              <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-content-muted">{a.annotations.description ?? a.annotations.message}</p>
            ) : null}
          </Panel>
        ) : null}

        {runbook || dashboard ? (
          <div className="flex flex-wrap gap-2">
            {runbook ? (
              <a href={runbook} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-3 text-[12px] font-medium text-content hover:border-brand-300">
                Runbook <IconExternal />
              </a>
            ) : null}
            {dashboard ? (
              <a href={dashboard} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-3 text-[12px] font-medium text-content hover:border-brand-300">
                Dashboard <IconExternal />
              </a>
            ) : null}
          </div>
        ) : null}

        <Panel
          title="Rule"
          right={rule ? (
            <button type="button" onClick={() => { copyText(rule.rule.query); toast.success('PromQL copied') }} className="inline-flex items-center gap-1 text-[11px] text-content-muted hover:text-content">
              <IconCopy /> Copy PromQL
            </button>
          ) : null}
        >
          {rule ? (
            <div className="space-y-2">
              <pre className="whitespace-pre-wrap break-all rounded-md bg-code p-3 font-mono text-[11px] leading-relaxed text-code-fg">{rule.rule.query}</pre>
              <dl className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
                <Meta label="For" value={rule.rule.duration ? fmtDur(rule.rule.duration) : '0s'} />
                <Meta label="Group" value={rule.group} />
                <Meta label="Health" value={rule.rule.health ?? '—'} />
                <Meta label="Last eval" value={rule.rule.lastEvaluation ? `${since(rule.rule.lastEvaluation)} ago` : '—'} />
              </dl>
              <div className="truncate font-mono text-[10px] text-content-subtle" title={rule.file}>{rule.file}</div>
              {rule.rule.lastError ? <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">{rule.rule.lastError}</div> : null}
            </div>
          ) : (
            <p className="text-[11px] text-content-subtle">No matching alerting rule in Prometheus's rule API (the alert may come from another Prometheus, Loki ruler or Grafana).</p>
          )}
        </Panel>

        <Panel title="Labels">
          <KvTable rows={Object.entries(a.labels).sort(([x], [y]) => x.localeCompare(y))} />
        </Panel>
        {annotations.length ? (
          <Panel title="Annotations">
            <KvTable rows={annotations} />
          </Panel>
        ) : null}

        <Panel title="Notification">
          <dl className="grid grid-cols-1 gap-2 text-[11px] sm:grid-cols-2">
            <Meta label="Receivers" value={a.receivers.length ? a.receivers.join(', ') : a.source === 'prometheus' ? 'not yet sent to Alertmanager' : '—'} />
            <Meta label="Source" value={a.source === 'alertmanager' ? 'Alertmanager' : 'Prometheus (pending or in flight)'} />
          </dl>
          {silencedBy.length ? (
            <div className="mt-3 space-y-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Silenced by</div>
              {silencedBy.map((s) => (
                <div key={s.id} className="rounded-md border border-edge-subtle px-3 py-2 text-[11px]">
                  <div className="font-mono text-content">{s.matchers.map(matcherText).join(', ')}</div>
                  <div className="text-content-muted">{s.createdBy} · until {new Date(s.endsAt).toLocaleString()} · {s.comment}</div>
                </div>
              ))}
            </div>
          ) : null}
          {a.inhibitedBy.length ? (
            <p className="mt-3 text-[11px] text-content-muted">Inhibited by {a.inhibitedBy.length} source alert{a.inhibitedBy.length === 1 ? '' : 's'} (see Routing → inhibition rules).</p>
          ) : null}
        </Panel>
      </div>
    </Drawer>
  )
}

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</dt>
      <dd className="mt-0.5 truncate text-content">{value}</dd>
    </div>
  )
}

function fmtVal(v: number): string {
  if (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0)) return v.toExponential(2)
  return String(Math.round(v * 1000) / 1000)
}

function fmtDur(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600}h`
  if (sec % 60 === 0) return `${sec / 60}m`
  return `${sec}s`
}

/* ─────────────────────── timeline ─────────────────────── */

const TL_WINDOWS: Array<[string, number]> = [['6h', 6 * 3600e3], ['24h', 24 * 3600e3], ['3d', 3 * 86400e3], ['7d', 7 * 86400e3]]

function TimelineTab() {
  const [win, setWin] = useState(24 * 3600e3)
  const q = useAlertTimeline(win)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-content-muted"><span className="h-2.5 w-3 rounded-sm bg-rose-500" /> firing</span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-content-muted"><span className="h-2.5 w-3 rounded-sm bg-amber-400" /> pending</span>
        <div className="ml-auto">
          <MiniSelect label="Window" value={String(win)} onChange={(v) => setWin(Number(v))} options={TL_WINDOWS.map(([l, ms]) => [String(ms), `Last ${l}`])} />
        </div>
      </div>
      {q.isLoading ? <LoadingCard label="Reading ALERTS history from Prometheus…" /> : q.isError ? (
        <SourceError tool="Prometheus" error={q.error} onRetry={() => q.refetch()} icon={<PrometheusIcon size={20} />} />
      ) : !q.data?.lanes.length ? (
        <EmptyState icon={<PrometheusIcon size={20} />} title="No alerts in this window" description="The ALERTS series has no firing or pending samples for this period." />
      ) : (
        <Swimlanes lanes={q.data.lanes} start={q.data.start} end={q.data.end} />
      )}
    </div>
  )
}

function Swimlanes({ lanes, start, end }: { lanes: Lane[]; start: number; end: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const w = useElementWidth(ref) || 800
  const LABEL = Math.min(240, Math.max(140, w * 0.28))
  const trackW = Math.max(50, w - LABEL - 40)
  const ROW = 26
  const x = (t: number) => LABEL + ((t - start) / Math.max(1, end - start)) * trackW
  const [hover, setHover] = useState<{ lane: string; i: Lane['intervals'][number]; px: number; py: number } | null>(null)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => start + f * (end - start))
  const multiDay = end - start > 36 * 3600e3
  const fmt = (t: number) => new Date(t).toLocaleString([], multiDay ? { month: 'short', day: 'numeric', hour: '2-digit' } : { hour: '2-digit', minute: '2-digit' })
  const H = lanes.length * ROW + 24
  return (
    <section ref={ref} className="relative overflow-hidden rounded-xl border border-edge-default bg-surface-raised p-3 shadow-sm">
      <svg width={w - 24} height={H} role="img" aria-label="Alert timeline" onMouseLeave={() => setHover(null)}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={x(t)} x2={x(t)} y1={0} y2={H - 18} stroke="var(--color-edge-subtle)" strokeDasharray="3 4" />
            <text x={x(t)} y={H - 4} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'} fontSize="9" fill="var(--color-content-subtle)" fontFamily="var(--font-mono)">{fmt(t)}</text>
          </g>
        ))}
        {lanes.map((l, li) => {
          const y = li * ROW
          return (
            <g key={l.name}>
              <text x={0} y={y + 16} fontSize="11" fill="var(--color-content)" fontFamily="var(--font-mono)">
                {l.name.length > 28 ? `${l.name.slice(0, 27)}…` : l.name}
                <tspan fill="var(--color-content-subtle)" fontSize="9">{l.instances > 1 ? ` ×${l.instances}` : ''}</tspan>
              </text>
              <rect x={LABEL} y={y + 8} width={trackW} height={10} rx={2} fill="var(--color-surface-sunken)" />
              {[...l.intervals].sort((a, b) => (a.state === b.state ? 0 : a.state === 'pending' ? -1 : 1)).map((iv, k) => (
                <rect
                  key={k}
                  x={x(iv.start)}
                  y={y + (iv.state === 'pending' ? 10 : 7)}
                  width={Math.max(2, x(iv.end) - x(iv.start))}
                  height={iv.state === 'pending' ? 6 : 12}
                  rx={2}
                  fill={iv.state === 'firing' ? 'var(--color-rose-500)' : 'var(--color-amber-400)'}
                  onMouseEnter={() => setHover({ lane: l.name, i: iv, px: x(iv.start), py: y })}
                />
              ))}
            </g>
          )
        })}
      </svg>
      {hover ? (
        <div className="pointer-events-none absolute z-10 rounded-md border border-edge-default bg-surface-raised px-2.5 py-1.5 text-[11px] shadow-lg" style={{ left: Math.min(w - 240, hover.px + 12), top: hover.py + 34 }}>
          <div className="font-medium text-content">{hover.lane} · {hover.i.state}</div>
          <div className="font-mono text-content-muted">{new Date(hover.i.start).toLocaleString()} → {new Date(hover.i.end).toLocaleTimeString()}</div>
        </div>
      ) : null}
    </section>
  )
}

/* ─────────────────────── rules ─────────────────────── */

function RulesTab() {
  const q = useRules()
  const [state, setState] = useState<'all' | 'firing' | 'pending' | 'inactive' | 'unhealthy'>('all')
  const [text, setText] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  if (q.isLoading) return <LoadingCard label="Loading alerting rules…" />
  if (q.isError) return <SourceError tool="Prometheus" error={q.error} onRetry={() => q.refetch()} icon={<PrometheusIcon size={20} />} />
  const groups = q.data ?? []
  const all = groups.flatMap((g) => g.rules.filter((r) => r.type === 'alerting').map((r) => ({ r, g })))
  const t = text.trim().toLowerCase()
  const list = all.filter(({ r, g }) => {
    if (state === 'unhealthy' && (r.health ?? 'ok') === 'ok') return false
    if (state !== 'all' && state !== 'unhealthy' && r.state !== state) return false
    return !t || r.name.toLowerCase().includes(t) || r.query.toLowerCase().includes(t) || g.name.toLowerCase().includes(t)
  })
  const c = (s: string) => all.filter(({ r }) => r.state === s).length
  if (!all.length) {
    return <EmptyState icon={<PrometheusIcon size={20} />} title="No alerting rules" description="Prometheus has no alerting rules loaded. PrometheusRule resources picked up by the operator appear here." />
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="xs"
          value={state}
          onChange={setState}
          options={[
            { id: 'all', label: 'All', count: all.length },
            { id: 'firing', label: 'Firing', count: c('firing') },
            { id: 'pending', label: 'Pending', count: c('pending') },
            { id: 'inactive', label: 'Inactive', count: c('inactive') },
            { id: 'unhealthy', label: 'Unhealthy', count: all.filter(({ r }) => (r.health ?? 'ok') !== 'ok').length },
          ]}
        />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter by name, group or PromQL…" aria-label="Filter rules" className="h-8 min-w-50 flex-1 rounded-md border border-edge-default bg-surface-raised px-2.5 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none" />
      </div>
      <section className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
        <ul className="divide-y divide-edge-subtle">
          {list.slice(0, 500).map(({ r, g }) => {
            const id = `${g.file}/${g.name}/${r.name}/${JSON.stringify(r.labels ?? {})}`
            const isOpen = open === id
            const st: UState | 'inactive' = r.state === 'firing' ? 'firing' : r.state === 'pending' ? 'pending' : 'inactive'
            return (
              <li key={id}>
                <button type="button" onClick={() => setOpen(isOpen ? null : id)} aria-expanded={isOpen} className="flex w-full flex-wrap items-center gap-2 px-4 py-2 text-left hover:bg-surface-sunken/40">
                  <IconChevronRight open={isOpen} />
                  {st === 'inactive' ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300"><IconOk /> Inactive</span>
                  ) : <StateTag state={st} />}
                  {(r.health ?? 'ok') !== 'ok' ? <span className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-700 dark:text-rose-300"><IconWarn /> {r.health}</span> : null}
                  <span className="truncate text-[13px] font-medium text-content">{r.name}</span>
                  {r.labels?.severity ? <SeverityTag severity={r.labels.severity} /> : null}
                  <span className="ml-auto truncate font-mono text-[10px] text-content-subtle">{g.name}</span>
                </button>
                {isOpen ? (
                  <div className="space-y-2 px-10 pb-3">
                    <pre className="whitespace-pre-wrap break-all rounded-md bg-code p-3 font-mono text-[11px] leading-relaxed text-code-fg">{r.query}</pre>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-content-muted">
                      <span>for {r.duration ? fmtDur(r.duration) : '0s'}</span>
                      {r.alerts?.length ? <span>{r.alerts.length} active instance{r.alerts.length === 1 ? '' : 's'}</span> : null}
                      {r.evaluationTime != null ? <span>eval {(r.evaluationTime * 1000).toFixed(1)} ms</span> : null}
                      {r.annotations?.runbook_url ? <a href={r.annotations.runbook_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand-700 hover:underline dark:text-brand-300">runbook <IconExternal /></a> : null}
                    </div>
                    {r.annotations?.summary || r.annotations?.description ? <p className="text-[12px] text-content-muted">{r.annotations.summary ?? r.annotations.description}</p> : null}
                    {r.lastError ? <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">{r.lastError}</div> : null}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
        {list.length === 0 ? <div className="p-4 text-[12px] text-content-subtle">No rules match.</div> : null}
      </section>
    </div>
  )
}

/* ─────────────────────── silences ─────────────────────── */

function SilencesTab({ alerts, onNew }: { alerts: UAlert[]; onNew(m: AmMatcher[]): void }) {
  const toast = useToast()
  const target = useAmTarget()
  const q = useSilences()
  const expire = useExpireSilence()
  const [state, setState] = useState<'active' | 'pending' | 'expired'>('active')
  const [confirm, setConfirm] = useState<AmSilence | null>(null)
  if (q.isLoading) return <LoadingCard label="Loading silences from Alertmanager…" />
  if (q.isError) {
    return (
      <SourceError
        tool="Alertmanager"
        error={q.error}
        onRetry={() => q.refetch()}
      />
    )
  }
  const list = (q.data ?? []).filter((s) => (s.status?.state ?? 'active') === state).sort((a, b) => b.startsAt.localeCompare(a.startsAt))
  const count = (s: string) => (q.data ?? []).filter((x) => x.status?.state === s).length
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="xs"
          value={state}
          onChange={setState}
          options={[{ id: 'active', label: 'Active', count: count('active') }, { id: 'pending', label: 'Scheduled', count: count('pending') }, { id: 'expired', label: 'Expired', count: count('expired') }]}
        />
        {target.data ? <span className="ml-auto text-[11px] text-content-subtle">via {target.data.via}</span> : null}
      </div>
      {list.length === 0 ? (
        <EmptyState compact title={`No ${state === 'pending' ? 'scheduled' : state} silences`} description={state === 'active' ? 'Silence an alert from its detail drawer, or create one from matchers.' : undefined} />
      ) : (
        <section className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm">
          <ul className="divide-y divide-edge-subtle">
            {list.map((s) => {
              const affected = alerts.filter((a) => silenceMatches(s, a.labels)).length
              return (
                <li key={s.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap gap-1">
                      {s.matchers.map((m, i) => (
                        <span key={i} className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content">{matcherText(m)}</span>
                      ))}
                    </div>
                    <div className="mt-1 text-[12px] text-content-muted">{s.comment || <span className="text-content-subtle">no comment</span>}</div>
                    <div className="mt-0.5 text-[11px] text-content-subtle">
                      {s.createdBy} · {new Date(s.startsAt).toLocaleString()} → {new Date(s.endsAt).toLocaleString()}
                      {state === 'active' ? ` · ends in ${since(new Date().toISOString(), Date.parse(s.endsAt))}` : ''}
                      {state !== 'expired' ? ` · matches ${affected} current alert${affected === 1 ? '' : 's'}` : ''}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button size="xs" variant="ghost" onClick={() => onNew(s.matchers)}>{state === 'expired' ? 'Recreate' : 'Duplicate'}</Button>
                    {state !== 'expired' ? <Button size="xs" variant="danger" onClick={() => setConfirm(s)}>Expire</Button> : null}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Expire this silence?"
        description="Matching alerts will notify again on the next Alertmanager evaluation."
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              size="sm"
              variant="danger"
              loading={expire.isPending}
              onClick={() => {
                if (!confirm) return
                expire.mutate(confirm.id, {
                  onSuccess: () => {
                    toast.success('Silence expired')
                    setConfirm(null)
                  },
                  onError: (e) => toast.error('Could not expire silence', { description: (e as Error).message }),
                })
              }}
            >
              Expire silence
            </Button>
          </div>
        }
      >
        {confirm ? <div className="flex flex-wrap gap-1">{confirm.matchers.map((m, i) => <span key={i} className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content">{matcherText(m)}</span>)}</div> : null}
      </Modal>
    </div>
  )
}

const DURATIONS: Array<[string, number]> = [['30m', 30], ['1h', 60], ['2h', 120], ['4h', 240], ['12h', 720], ['1d', 1440], ['3d', 4320], ['1w', 10080]]
const AUTHOR_KEY = 'adhar.discover.silence.author'

function SilenceEditor({ initial, alerts, onClose }: { initial: AmMatcher[]; alerts: UAlert[]; onClose(): void }) {
  const toast = useToast()
  const create = useCreateSilence()
  const [text, setText] = useState(initial.map(matcherText).join(', '))
  const [mins, setMins] = useState(120)
  const [author, setAuthor] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(AUTHOR_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [comment, setComment] = useState('')
  const matchers = parseMatchers(text)
  const affected = matchers && matchers.length ? alerts.filter((a) => silenceMatches({ matchers }, a.labels)) : []
  const problems: string[] = []
  if (!matchers) problems.push('Matchers must look like name="value", name=~"regex" — comma separated.')
  else if (!matchers.length) problems.push('Add at least one matcher.')
  else if (matchers.every((m) => m.isRegex && /^\.\*$/.test(m.value))) problems.push('A silence must not match every alert.')
  if (!author.trim()) problems.push('Say who is creating the silence.')
  if (!comment.trim()) problems.push('Add a comment — why is this silenced?')
  const inputCls = 'w-full rounded-md border border-edge-default bg-surface-raised px-3 py-2 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none'

  const submit = () => {
    if (problems.length || !matchers) return
    try {
      globalThis.localStorage?.setItem(AUTHOR_KEY, author.trim())
    } catch { /* ignore */ }
    const now = new Date()
    create.mutate(
      { matchers, startsAt: now.toISOString(), endsAt: new Date(now.getTime() + mins * 60_000).toISOString(), createdBy: author.trim(), comment: comment.trim() },
      {
        onSuccess: () => {
          toast.success('Silence created', { description: `${affected.length} current alert${affected.length === 1 ? '' : 's'} muted for ${DURATIONS.find(([, m]) => m === mins)?.[0] ?? `${mins}m`}` })
          onClose()
        },
        onError: (e) => toast.error('Could not create silence', { description: (e as Error).message }),
      },
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      width="lg"
      title="New silence"
      description="Mute notifications for alerts matching every matcher. Prometheus keeps evaluating; Alertmanager stops notifying until the silence ends."
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={problems.length > 0} loading={create.isPending} onClick={submit}>Create silence</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-[12px] font-medium text-content">Matchers</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} spellCheck={false} placeholder='alertname="KubePodCrashLooping", namespace="shop"' className={cn(inputCls, 'font-mono')} />
        </label>
        <div className="space-y-1">
          <span className="text-[12px] font-medium text-content">Duration</span>
          <div className="flex flex-wrap gap-1">
            {DURATIONS.map(([l, m]) => (
              <button key={l} type="button" onClick={() => setMins(m)} className={cn('h-7 rounded-md border px-2.5 text-[11px] font-medium', mins === m ? 'border-brand-400 bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300' : 'border-edge-default text-content-muted hover:text-content')}>
                {l}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-content-subtle">Ends {new Date(Date.now() + mins * 60_000).toLocaleString()}</div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-[12px] font-medium text-content">Created by</span>
            <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="you@company.com" className={inputCls} />
          </label>
          <label className="block space-y-1">
            <span className="text-[12px] font-medium text-content">Comment</span>
            <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Deploying fix, tracked in INC-123" className={inputCls} />
          </label>
        </div>
        <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-2.5 text-[11px]">
          <div className="font-medium text-content">Matches {affected.length} current alert{affected.length === 1 ? '' : 's'}</div>
          {affected.slice(0, 6).map((a) => (
            <div key={a.key} className="mt-1 flex items-center gap-2 text-content-muted">
              <StateTag state={a.state} /> <span className="truncate font-mono">{a.name} {a.labels.namespace ? `· ${a.labels.namespace}` : ''}</span>
            </div>
          ))}
          {affected.length > 6 ? <div className="mt-1 text-content-subtle">…and {affected.length - 6} more</div> : null}
        </div>
        {problems.length && text ? <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-content-muted">{problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
      </div>
    </Modal>
  )
}

/* ─────────────────────── routing ─────────────────────── */

function RoutingTab() {
  const q = useRouting()
  if (q.isLoading) return <LoadingCard label="Reading Alertmanager configuration…" />
  if (q.isError) return <SourceError tool="Alertmanager" error={q.error} onRetry={() => q.refetch()} />
  const c = q.data!
  const routes = flattenRoutes(c.route)
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Receivers" value={c.receivers.length} />
        <StatTile label="Routes" value={routes.length || '—'} />
        <StatTile label="Inhibition rules" value={c.rawYaml && !c.inhibitRules.length ? '—' : c.inhibitRules.length} />
        <StatTile
          label="Cluster"
          value={c.cluster?.status ?? '—'}
          tone={c.cluster?.status === 'ready' ? 'ok' : c.cluster?.status ? 'warn' : undefined}
          icon={c.cluster?.status === 'ready' ? <IconOk /> : undefined}
          hint={[c.version ? `v${c.version}` : '', c.cluster?.peers != null ? `${c.cluster.peers} peer${c.cluster.peers === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}
        />
      </div>

      {routes.length ? (
        <Panel title="Route tree">
          <ul className="space-y-1">
            {routes.map(({ route: r, depth }, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-[12px] hover:bg-surface-sunken/40" style={{ marginLeft: depth * 18 }}>
                <span className="font-mono text-[10px] text-content-subtle">{depth === 0 ? 'root' : '↳'}</span>
                <span className="rounded bg-brand-50 px-1.5 py-0.5 font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">{r.receiver ?? '(inherit)'}</span>
                {routeMatchers(r).map((m) => <span key={m} className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content">{m}</span>)}
                {r.group_by?.length ? <span className="text-[11px] text-content-muted">group by {r.group_by.join(', ')}</span> : null}
                {r.repeat_interval ? <span className="text-[11px] text-content-subtle">repeat {r.repeat_interval}</span> : null}
                {r.continue ? <span className="text-[11px] text-content-subtle">continue</span> : null}
                {r.mute_time_intervals?.length ? <span className="text-[11px] text-content-subtle">muted: {r.mute_time_intervals.join(', ')}</span> : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel title="Receivers">
        {c.receivers.length === 0 ? <p className="text-[11px] text-content-subtle">No receivers reported.</p> : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {c.receivers.map((r) => (
              <div key={r.name} className="rounded-lg border border-edge-subtle px-3 py-2">
                <div className="truncate font-mono text-[12px] font-medium text-content">{r.name}</div>
                <div className="mt-0.5 text-[11px] text-content-muted">
                  {r.integrations.length ? r.integrations.join(' · ') : c.rawYaml ? 'see config' : <span className="inline-flex items-center gap-1"><IconWarn /> no integrations — notifications go nowhere</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Inhibition rules">
        {c.inhibitRules.length === 0 ? (
          <p className="text-[11px] text-content-subtle">{c.rawYaml ? 'Shown in the raw configuration below.' : 'No inhibition rules — every matching alert notifies on its own.'}</p>
        ) : (
          <ul className="space-y-2">
            {c.inhibitRules.map((r, i) => {
              const s = inhibitSides(r)
              return (
                <li key={i} className="rounded-lg border border-edge-subtle px-3 py-2 text-[12px] text-content-muted">
                  While an alert matching <Chips items={s.source} /> fires, mute alerts matching <Chips items={s.target} />
                  {s.equal.length ? <> that share the same <Chips items={s.equal} /></> : null}.
                </li>
              )
            })}
          </ul>
        )}
      </Panel>

      {c.rawYaml ? (
        <Panel title="Configuration (alertmanager.yml)">
          <pre className="max-h-120 overflow-auto whitespace-pre rounded-md bg-code p-3 font-mono text-[11px] leading-relaxed text-code-fg">{c.rawYaml}</pre>
        </Panel>
      ) : null}
    </div>
  )
}

function Chips({ items }: { items: string[] }) {
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {items.map((m) => <span key={m} className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content">{m}</span>)}
    </span>
  )
}

