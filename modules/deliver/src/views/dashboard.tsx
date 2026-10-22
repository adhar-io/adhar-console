import type { ReactNode } from 'react'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import type { argocd, kargo } from '@adhar/api-clients'
import {
  useApplications,
  useRollouts,
  useScans,
  useStages,
} from '../data/delivery.ts'
import { useRuntimeAgents, useRuntimeEvents } from '../data/runtime.ts'
import type { RuntimeEvent, RuntimeSeverity } from '../data/runtime-events.ts'
import { orderStages, shortFreight, stageStatus } from '../data/stage-order.ts'

/** Empty states inside a panel: the panel is the frame, so no second dashed box. */
const PANEL_EMPTY = 'rounded-none border-0 bg-transparent'

/**
 * Workspace-level Deliver dashboard. Aggregates Argo CD, Kargo, Argo Rollouts,
 * trivy-operator and the runtime agents (Tetragon / Falco) into a single
 * delivery pulse — mirrors the Define / Design / Develop dashboards.
 *
 * Every figure belongs to one source. While a source is loading its figure is
 * "…"; when it cannot be read its figure is "—" and its panel names the source
 * with a retry. A zero is only ever shown when the source answered with zero.
 */

/** One source's read state, reduced to what the tiles and panels need. */
interface Src {
  loading: boolean
  error: unknown
  retry(): void
}

function src(q: { isLoading: boolean; isError: boolean; error: unknown; refetch(): unknown }): Src {
  return { loading: q.isLoading, error: q.isError ? q.error ?? new Error('Unknown error') : null, retry: () => void q.refetch() }
}

function shown(s: Src, value: number): number | string {
  return s.loading ? '…' : s.error ? '—' : value
}

function errText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e ?? 'Unknown error')
}

const RUNTIME_ALERT: ReadonlySet<RuntimeSeverity> = new Set(['critical', 'high', 'medium'])

export function Dashboard() {
  const appsQ = useApplications()
  const stagesQ = useStages()
  const rolloutsQ = useRollouts()
  const scansQ = useScans()
  const agents = useRuntimeAgents()
  const feed = useRuntimeEvents(agents.engines, { tailLines: 100 })

  const apps = src(appsQ)
  const stages = src(stagesQ)
  const rollouts = src(rolloutsQ)
  const scans = src(scansQ)
  const runtimeInstalled = agents.engines.some((e) => e.installed)
  const runtime: Src = {
    loading: agents.isLoading || (runtimeInstalled && feed.isLoading),
    error: agents.isError ? agents.error ?? new Error('Unknown error') : null,
    retry: () => { void agents.refetch(); void feed.refetch() },
  }

  const appList = appsQ.data ?? []
  // Promotion order, not the API's alphabetical order — see stage-order.ts.
  const stageList = orderStages(stagesQ.data ?? [])
  const rolloutList = (rolloutsQ.data ?? []) as Rollout[]
  const scanList = scansQ.data ?? []
  const alerts = feed.events.filter((e) => RUNTIME_ALERT.has(e.severity))

  const synced = appList.filter((a) => a.status.sync.status === 'Synced').length
  const outOfSync = appList.filter((a) => a.status.sync.status === 'OutOfSync').length
  const healthy = appList.filter((a) => a.status.health.status === 'Healthy').length
  const degraded = appList.filter((a) => a.status.health.status === 'Degraded').length

  const promoting = stageList.filter((s) => s.phase === 'Promoting' || s.phase === 'Verifying').length
  const pausedRollouts = rolloutList.filter((r) => r.status?.phase === 'Paused').length
  const inProgress = rolloutList.filter((r) => r.status?.phase === 'Progressing').length

  const totalCritical = scanList.reduce((acc, s) => acc + (s.summary.critical ?? 0), 0)
  const totalHigh = scanList.reduce((acc, s) => acc + (s.summary.high ?? 0), 0)
  const totalMedium = scanList.reduce((acc, s) => acc + (s.summary.medium ?? 0), 0)
  const totalLow = scanList.reduce((acc, s) => acc + (s.summary.low ?? 0), 0)
  const criticalAlerts = alerts.filter((e) => e.severity === 'critical').length

  const hint = (s: Src, name: string, ok: string) => (s.loading ? undefined : s.error ? `${name} unreachable` : ok)

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <HeroStat
          label="ArgoCD apps"
          value={shown(apps, appList.length)}
          tone="brand"
          icon={<IconRocket />}
          hint={hint(apps, 'Argo CD', `${synced} synced · ${outOfSync} drift`)}
        />
        <HeroStat
          label="Healthy"
          value={shown(apps, healthy)}
          tone="emerald"
          icon={<IconHeart />}
          hint={hint(apps, 'Argo CD', appList.length === 0 ? 'no apps yet' : degraded ? `${degraded} degraded` : `of ${appList.length}`)}
        />
        <HeroStat
          label="Promotions"
          value={shown(stages, promoting)}
          tone="amber"
          icon={<IconArrowRight />}
          hint={hint(stages, 'Kargo', `${stageList.length} stages total`)}
        />
        <HeroStat
          label="Rollouts"
          value={shown(rollouts, rolloutList.length)}
          tone="violet"
          icon={<IconLayer />}
          hint={hint(rollouts, 'Argo Rollouts', `${inProgress} progressing · ${pausedRollouts} paused`)}
        />
        <HeroStat
          label="Critical CVEs"
          value={shown(scans, totalCritical)}
          tone="rose"
          icon={<IconShieldX />}
          hint={hint(scans, 'trivy-operator', scanList.length ? `${totalHigh} high · ${totalMedium} med` : 'no scan reports yet')}
        />
        <HeroStat
          label="Runtime alerts"
          value={runtime.loading ? '…' : runtime.error || !runtimeInstalled ? '—' : alerts.length}
          tone="sky"
          icon={<IconShieldAlert />}
          hint={runtime.loading ? undefined : runtime.error ? 'cluster unreachable' : !runtimeInstalled ? 'no agent installed' : `${criticalAlerts} critical · recent log tail`}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-content">Applications</div>
                <div className="text-[11px] text-content-subtle">
                  Sync × Health across the org
                </div>
              </div>
              {!apps.loading && !apps.error ? <StatusBadge kind="info">{appList.length}</StatusBadge> : null}
            </div>
          </CardHeader>
          <CardBody className="p-0!">
            {apps.loading ? (
              <PanelLoading text="Reading Argo CD…" />
            ) : apps.error ? (
              <SourceError source="Argo CD" error={apps.error} retry={apps.retry} />
            ) : appList.length === 0 ? (
              <EmptyState className={PANEL_EMPTY}
                compact
                title="No apps yet"
                description="Argo CD Applications appear here with their sync and health once an application is delivered."
                action={<LinkButton href="/deliver?section=apps">Open Applications</LinkButton>}
              />
            ) : (
              <ul className="divide-y divide-edge-subtle">
                {appList.map((a) => (
                  <AppRow key={a.metadata.name} app={a} />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-sm font-semibold text-content">Promotion pipeline</div>
            <div className="text-[11px] text-content-subtle">Kargo stages, dev → prod</div>
          </CardHeader>
          <CardBody className="space-y-3">
            {stages.loading ? (
              <PanelLoading text="Reading Kargo…" />
            ) : stages.error ? (
              <SourceError source="Kargo" error={stages.error} retry={stages.retry} />
            ) : stageList.length === 0 ? (
              <EmptyState className={PANEL_EMPTY}
                compact
                title="No stages"
                description="Kargo Stages appear here in promotion order once a project defines its environments."
                action={<LinkButton href="/deliver?section=stages">Open Kargo Stages</LinkButton>}
              />
            ) : (
              stageList.map((s, i) => <StageNode key={s.name} stage={s} terminal={i === stageList.length - 1} />)
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <div className="text-sm font-semibold text-content">Vulnerability load</div>
            <div className="text-[11px] text-content-subtle">
              {scans.loading || scans.error ? 'trivy-operator reports' : `Across ${scanList.length} trivy-operator reports`}
            </div>
          </CardHeader>
          <CardBody>
            {scans.loading ? (
              <PanelLoading text="Reading scan reports…" />
            ) : scans.error ? (
              <SourceError source="trivy-operator" error={scans.error} retry={scans.retry} />
            ) : scanList.length === 0 ? (
              <EmptyState className={PANEL_EMPTY}
                compact
                title="No scan reports yet"
                description="trivy-operator writes a report for each running workload's image; counts by severity appear here once the first one lands."
                action={<LinkButton href="/deliver?section=scans">Open Vulnerability Scans</LinkButton>}
              />
            ) : (
              <>
                <SeverityBar critical={totalCritical} high={totalHigh} medium={totalMedium} low={totalLow} />
                <ul className="mt-3 space-y-1.5 text-[11px] text-content-muted">
                  <SevRow label="Critical" value={totalCritical} dot="bg-rose-500" />
                  <SevRow label="High" value={totalHigh} dot="bg-amber-500" />
                  <SevRow label="Medium" value={totalMedium} dot="bg-sky-500" />
                  <SevRow label="Low" value={totalLow} dot="bg-slate-400" />
                </ul>
              </>
            )}
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-content">Recent runtime alerts</div>
                <div className="text-[11px] text-content-subtle">Tetragon and Falco · medium and above, from each agent's recent log</div>
              </div>
              {!runtime.loading && !runtime.error && runtimeInstalled ? (
                criticalAlerts
                  ? <StatusBadge kind="failed">{criticalAlerts} critical</StatusBadge>
                  : <StatusBadge kind="info">{alerts.length} alerts</StatusBadge>
              ) : null}
            </div>
          </CardHeader>
          <CardBody className="p-0!">
            {runtime.loading ? (
              <PanelLoading text="Reading runtime agents…" />
            ) : runtime.error ? (
              <SourceError source="the cluster (runtime-security agents)" error={runtime.error} retry={runtime.retry} />
            ) : !runtimeInstalled ? (
              <EmptyState className={PANEL_EMPTY}
                compact
                title="No runtime-security agent is installed"
                description="Install Tetragon or Falco on the cluster; their alerts appear here."
                action={<LinkButton href="/deliver?section=runtime">Open Runtime Security</LinkButton>}
              />
            ) : feed.total > 0 && feed.failures === feed.total ? (
              <SourceError
                source="the runtime agents' logs"
                error={new Error('No agent pod log could be read — usually missing pods/log permission.')}
                retry={runtime.retry}
              />
            ) : alerts.length === 0 ? (
              <EmptyState className={PANEL_EMPTY}
                compact
                title="No alerts in the recent log"
                description={`${feed.events.length} event${feed.events.length === 1 ? '' : 's'} read, none at medium severity or above.`}
                action={<LinkButton href="/deliver?section=runtime">Open Runtime Security</LinkButton>}
              />
            ) : (
              <ul className="divide-y divide-edge-subtle">
                {alerts.slice(0, 6).map((e) => (
                  <EventRow key={e.id} event={e} />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <QuickStartCard
          title="GitOps"
          description="ArgoCD apps reconciled live; sync, history, drilldown."
          links={[
            { label: 'Applications', href: '/deliver?section=apps' },
            { label: 'Environments', href: '/deliver?section=environments' },
          ]}
          tone="brand"
        />
        <QuickStartCard
          title="Promote"
          description="Kargo stages and Argo Rollouts — with promote / abort."
          links={[
            { label: 'Stages', href: '/deliver?section=stages' },
            { label: 'Rollouts', href: '/deliver?section=rollouts' },
            { label: 'Releases', href: '/deliver?section=releases' },
          ]}
          tone="amber"
        />
        <QuickStartCard
          title="Registry"
          description="Harbor repos with image tags + per-artifact CVE counts."
          links={[{ label: 'Image registry', href: '/deliver?section=registry' }]}
          tone="violet"
        />
        <QuickStartCard
          title="Secure"
          description="Trivy vulnerability + config audits, Tetragon and Falco runtime feed."
          links={[
            { label: 'Vuln scans', href: '/deliver?section=scans' },
            { label: 'Runtime', href: '/deliver?section=runtime' },
            { label: 'Policy', href: '/deliver?section=policy' },
          ]}
          tone="rose"
        />
      </div>
    </div>
  )
}

/* ─────────── panel states ─────────── */

function PanelLoading({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 px-5 py-4 text-sm text-content-muted">
      <Spinner size={12} /> {text}
    </div>
  )
}

function SourceError({ source, error, retry }: { source: string; error: unknown; retry(): void }) {
  return (
    <EmptyState className={PANEL_EMPTY}
      compact
      title={`Couldn't reach ${source}`}
      description={errText(error)}
      action={<Button size="sm" variant="secondary" onClick={retry}>Retry</Button>}
    />
  )
}

function LinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-2.5 py-1 text-xs font-medium text-content shadow-sm hover:bg-surface-sunken"
    >
      {children}
    </a>
  )
}

/* ─────────── ArgoCD app row ─────────── */

function AppRow({ app: a }: { app: argocd.Application }) {
  const sync = a.status.sync.status
  const health = a.status.health.status
  // ArgoCD supports single `spec.source` and multi-source `spec.sources[]`;
  // an Application mid-creation can have neither — never crash the dashboard.
  const source = a.spec?.source ?? a.spec?.sources?.[0]
  return (
    <li className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-brand-50/40 dark:hover:bg-brand-500/10">
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-bold text-white ${syncBg(sync)}`}>
        {a.metadata.name.slice(0, 2).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-content">{a.metadata.name}</span>
          <StatusBadge kind={syncTone(sync)}>{sync}</StatusBadge>
          <StatusBadge kind={healthTone(health)}>{health}</StatusBadge>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-content-subtle">
          {a.spec?.destination?.namespace ?? '—'} · {source?.path ?? source?.chart ?? '—'}
          {source?.targetRevision ? ` @ ${source.targetRevision}` : ''}
        </div>
      </div>
      {a.status.operationState?.finishedAt ? (
        <span className="hidden text-[11px] text-content-muted sm:inline">
          {formatRelative(a.status.operationState.finishedAt)}
        </span>
      ) : null}
    </li>
  )
}

function syncBg(s: string) {
  return s === 'Synced' ? 'bg-emerald-500' : s === 'OutOfSync' ? 'bg-amber-500' : 'bg-slate-500'
}
function syncTone(s: string): 'healthy' | 'paused' | 'unknown' {
  return s === 'Synced' ? 'healthy' : s === 'OutOfSync' ? 'paused' : 'unknown'
}
function healthTone(s: string): 'healthy' | 'degraded' | 'progressing' | 'paused' | 'unknown' {
  return s === 'Healthy'
    ? 'healthy'
    : s === 'Degraded'
      ? 'degraded'
      : s === 'Progressing'
        ? 'progressing'
        : s === 'Suspended'
          ? 'paused'
          : 'unknown'
}

/* ─────────── stage promotion node ─────────── */

function StageNode({ stage: s, terminal }: { stage: kargo.Stage; terminal: boolean }) {
  const status = stageStatus(s)
  return (
    <div>
      {/*
        Two rows, not one. The freight id and the stage name were competing for
        a single line in a narrow card, so a 40-character id pushed the
        timestamp out through the right edge and was clipped by the viewport.
        The name and status read on top; the freight — which is a long opaque
        id and the slowest thing to read — gets its own line and is truncated
        the way a commit is, with the full value on hover.
      */}
      <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate rounded-md bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] font-semibold text-content">
            {s.name}
          </span>
          <StatusBadge kind={status.kind}>{status.label}</StatusBadge>
          {s.lastPromoted
            ? (
              <span className="ml-auto shrink-0 text-[10px] text-content-subtle">
                {formatRelative(s.lastPromoted)}
              </span>
            )
            : null}
        </div>
        <div
          className="mt-1.5 truncate font-mono text-[10px] text-content-subtle"
          title={s.currentFreight ?? undefined}
        >
          {s.currentFreight ? shortFreight(s.currentFreight) : 'no freight yet'}
        </div>
      </div>
      {!terminal ? (
        <div className="flex justify-center py-1 text-content-subtle">
          <IconArrowDown />
        </div>
      ) : null}
    </div>
  )
}

/* ─────────── runtime event row ─────────── */

const SEVERITY_KIND: Record<RuntimeSeverity, StatusKind> = {
  critical: 'failed',
  high: 'degraded',
  medium: 'paused',
  low: 'info',
  info: 'unknown',
}

function EventRow({ event: e }: { event: RuntimeEvent }) {
  return (
    <li className="px-5 py-3 transition-colors hover:bg-brand-50/40 dark:hover:bg-brand-500/10">
      <div className="flex items-center gap-2">
        <StatusBadge kind={SEVERITY_KIND[e.severity]}>{e.severity}</StatusBadge>
        <span className="truncate text-sm font-semibold text-content">{e.title}</span>
        <span className="ml-auto shrink-0 text-[11px] text-content-muted">
          {e.time ? formatRelative(e.time) : ''}
        </span>
      </div>
      <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-content-muted">
        {e.reason}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1 text-[10px] font-mono text-content-subtle">
        <span className="rounded bg-surface-sunken px-1.5 py-0.5">{e.engine}</span>
        {e.namespace ? <span className="rounded bg-surface-sunken px-1.5 py-0.5">{e.namespace}</span> : null}
        {e.pod ? <span className="rounded bg-surface-sunken px-1.5 py-0.5">{e.pod}</span> : null}
      </div>
    </li>
  )
}

/* ─────────── severity bar ─────────── */

function SeverityBar({
  critical,
  high,
  medium,
  low,
}: {
  critical: number
  high: number
  medium: number
  low: number
}) {
  const total = critical + high + medium + low || 1
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-edge-subtle">
      {critical > 0 ? <div className="h-full bg-rose-500" style={{ width: `${(critical / total) * 100}%` }} /> : null}
      {high > 0 ? <div className="h-full bg-amber-500" style={{ width: `${(high / total) * 100}%` }} /> : null}
      {medium > 0 ? <div className="h-full bg-sky-500" style={{ width: `${(medium / total) * 100}%` }} /> : null}
      {low > 0 ? <div className="h-full bg-slate-400" style={{ width: `${(low / total) * 100}%` }} /> : null}
    </div>
  )
}

function SevRow({ label, value, dot }: { label: string; value: number; dot: string }) {
  return (
    <li className="flex items-center justify-between">
      <span className="inline-flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        {label}
      </span>
      <span className="tabular-nums text-content">{value}</span>
    </li>
  )
}

/* ─────────── hero + quick-start atoms ─────────── */

function HeroStat({
  label,
  value,
  tone,
  icon,
  hint,
}: {
  label: string
  value: number | string
  tone: 'brand' | 'amber' | 'rose' | 'violet' | 'sky' | 'emerald'
  icon: ReactNode
  hint?: string
}) {
  const cls = {
    brand: 'from-brand-50 dark:from-brand-500/10 to-surface-raised text-brand-700 dark:text-brand-300',
    amber: 'from-amber-50 dark:from-amber-500/10 to-surface-raised text-amber-700 dark:text-amber-300',
    rose: 'from-rose-50 dark:from-rose-500/10 to-surface-raised text-rose-700 dark:text-rose-300',
    violet: 'from-violet-50 dark:from-violet-500/10 to-surface-raised text-violet-700 dark:text-violet-300',
    sky: 'from-sky-50 dark:from-sky-500/10 to-surface-raised text-sky-700 dark:text-sky-300',
    emerald: 'from-emerald-50 dark:from-emerald-500/10 to-surface-raised text-emerald-700 dark:text-emerald-300',
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
  tone: 'brand' | 'amber' | 'violet' | 'rose'
}) {
  const accent = {
    brand: 'border-brand-200/60 bg-brand-50/30 dark:bg-brand-500/10 dark:border-brand-500/30',
    amber: 'border-amber-200/60 bg-amber-50/30 dark:bg-amber-500/10 dark:border-amber-500/30',
    violet: 'border-violet-200/60 bg-violet-50/30 dark:bg-violet-500/10 dark:border-violet-500/30',
    rose: 'border-rose-200/60 bg-rose-50/30 dark:bg-rose-500/10 dark:border-rose-500/30',
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
                className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-700 hover:text-brand-800 hover:underline dark:text-brand-300 dark:hover:text-brand-300"
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

/* ─────────── helpers / icons ─────────── */

interface Rollout {
  status?: { phase?: 'Healthy' | 'Progressing' | 'Paused' | 'Degraded' }
}

function IconRocket() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  )
}
function IconHeart() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  )
}
function IconArrowRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}
function IconArrowDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </svg>
  )
}
function IconLayer() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  )
}
function IconShieldX() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 9 6 6" />
      <path d="m15 9-6 6" />
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
function IconArrow() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}
