import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import type { argocd, falco, kargo } from '@adhar-console/api-clients'
import {
  useApplications,
  useFalcoEvents,
  useRollouts,
  useScans,
  useStages,
} from '../data/delivery.ts'

/**
 * Workspace-level Deliver dashboard. Aggregates ArgoCD, Kargo, Argo Rollouts,
 * Harbor, Trivy and Falco signals into a single delivery pulse — mirrors the
 * Define / Design / Develop dashboards.
 */
export function Dashboard() {
  const apps = useApplications()
  const stages = useStages()
  const rollouts = useRollouts()
  const scans = useScans()
  const events = useFalcoEvents({ sinceMs: 6 * 3600 * 1000 })

  if (apps.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading delivery feed…
      </div>
    )
  }

  const appList = apps.data ?? []
  const stageList = stages.data ?? []
  const rolloutList = (rollouts.data ?? []) as Rollout[]
  const scanList = scans.data ?? []
  const eventList = events.data ?? []

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

  const eventsByPriority = countBy(eventList, (e) => e.priority)
  const recentCritical = eventList.filter(
    (e) => e.priority === 'Critical' || e.priority === 'Emergency' || e.priority === 'Alert',
  )

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <HeroStat
          label="ArgoCD apps"
          value={appList.length}
          tone="brand"
          icon={<IconRocket />}
          hint={`${synced} synced · ${outOfSync} drift`}
        />
        <HeroStat
          label="Healthy"
          value={healthy}
          tone="emerald"
          icon={<IconHeart />}
          hint={degraded ? `${degraded} degraded` : 'all good'}
        />
        <HeroStat
          label="Promotions"
          value={promoting}
          tone="amber"
          icon={<IconArrowRight />}
          hint={`${stageList.length} stages total`}
        />
        <HeroStat
          label="Rollouts"
          value={rolloutList.length}
          tone="violet"
          icon={<IconLayer />}
          hint={`${inProgress} progressing · ${pausedRollouts} paused`}
        />
        <HeroStat
          label="Critical CVEs"
          value={totalCritical}
          tone="rose"
          icon={<IconShieldX />}
          hint={`${totalHigh} high · ${totalMedium} med`}
        />
        <HeroStat
          label="Falco · 6h"
          value={eventList.length}
          tone="sky"
          icon={<IconShieldAlert />}
          hint={`${recentCritical.length} critical`}
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
              <StatusBadge kind="info">{appList.length}</StatusBadge>
            </div>
          </CardHeader>
          <CardBody className="p-0!">
            {appList.length === 0 ? (
              <EmptyState compact title="No apps yet" />
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
            {stageList.length === 0 ? (
              <EmptyState compact title="No stages" />
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
            <div className="text-[11px] text-content-subtle">Across {scanList.length} Trivy reports</div>
          </CardHeader>
          <CardBody>
            <SeverityBar critical={totalCritical} high={totalHigh} medium={totalMedium} low={totalLow} />
            <ul className="mt-3 space-y-1.5 text-[11px] text-content-muted">
              <SevRow label="Critical" value={totalCritical} dot="bg-rose-500" />
              <SevRow label="High" value={totalHigh} dot="bg-amber-500" />
              <SevRow label="Medium" value={totalMedium} dot="bg-sky-500" />
              <SevRow label="Low" value={totalLow} dot="bg-slate-400" />
            </ul>
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-content">Recent runtime events</div>
                <div className="text-[11px] text-content-subtle">Falco · last 6 hours</div>
              </div>
              <PriorityChips counts={eventsByPriority} />
            </div>
          </CardHeader>
          <CardBody className="p-0!">
            {eventList.length === 0 ? (
              <EmptyState compact title="Nothing to investigate 🎉" />
            ) : (
              <ul className="divide-y divide-edge-subtle">
                {eventList.slice(0, 6).map((e) => (
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
            { label: 'Applications', href: '?apps' },
            { label: 'Environments', href: '?environments' },
          ]}
          tone="brand"
        />
        <QuickStartCard
          title="Promote"
          description="Kargo stages and Argo Rollouts — with promote / abort."
          links={[
            { label: 'Stages', href: '?stages' },
            { label: 'Rollouts', href: '?rollouts' },
            { label: 'Releases', href: '?releases' },
          ]}
          tone="amber"
        />
        <QuickStartCard
          title="Registry"
          description="Harbor repos with image tags + per-artifact CVE counts."
          links={[{ label: 'Image registry', href: '?registry' }]}
          tone="violet"
        />
        <QuickStartCard
          title="Secure"
          description="Trivy vulnerability + config audits, Falco runtime feed."
          links={[
            { label: 'Vuln scans', href: '?scans' },
            { label: 'Runtime', href: '?runtime' },
            { label: 'Policy', href: '?policy' },
          ]}
          tone="rose"
        />
      </div>
    </div>
  )
}

/* ─────────── ArgoCD app row ─────────── */

function AppRow({ app: a }: { app: argocd.Application }) {
  const sync = a.status.sync.status
  const health = a.status.health.status
  return (
    <li className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-brand-50/40">
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
          {a.spec.destination.namespace} · {a.spec.source.path ?? '—'}
          {a.spec.source.targetRevision ? ` @ ${a.spec.source.targetRevision}` : ''}
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
  const tone =
    s.phase === 'Steady'
      ? 'healthy'
      : s.phase === 'Promoting' || s.phase === 'Verifying'
        ? 'progressing'
        : s.phase === 'Failed'
          ? 'failed'
          : 'unknown'
  return (
    <div>
      <div className="flex items-center justify-between gap-2 rounded-lg border border-edge-subtle bg-surface-sunken/40 p-2.5">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-white px-1.5 py-0.5 font-mono text-[11px] font-semibold text-content">
            {s.name}
          </span>
          <StatusBadge kind={tone}>{s.phase}</StatusBadge>
        </div>
        <div className="text-right text-[10px] text-content-subtle">
          <div className="font-mono">{s.currentFreight ?? '—'}</div>
          {s.lastPromoted ? <div>{formatRelative(s.lastPromoted)}</div> : null}
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

function EventRow({ event: e }: { event: falco.FalcoEvent }) {
  const tone = priorityTone(e.priority)
  const ns = e.output_fields?.['k8s.ns.name']
  const pod = e.output_fields?.['k8s.pod.name']
  return (
    <li className="px-5 py-3 transition-colors hover:bg-brand-50/40">
      <div className="flex items-center gap-2">
        <StatusBadge kind={tone}>{e.priority.toLowerCase()}</StatusBadge>
        <span className="truncate text-sm font-semibold text-content">{e.rule}</span>
        <span className="ml-auto shrink-0 text-[11px] text-content-muted">
          {formatRelative(e.timestamp)}
        </span>
      </div>
      <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-content-muted">
        {e.output}
      </div>
      {ns || pod ? (
        <div className="mt-1.5 flex flex-wrap gap-1 text-[10px] font-mono text-content-subtle">
          {ns ? <span className="rounded bg-surface-sunken px-1.5 py-0.5">{ns}</span> : null}
          {pod ? <span className="rounded bg-surface-sunken px-1.5 py-0.5">{pod}</span> : null}
        </div>
      ) : null}
    </li>
  )
}

function priorityTone(p: falco.FalcoPriority): 'failed' | 'degraded' | 'progressing' | 'paused' | 'info' | 'unknown' {
  return p === 'Emergency' || p === 'Alert' || p === 'Critical'
    ? 'failed'
    : p === 'Error'
      ? 'degraded'
      : p === 'Warning'
        ? 'progressing'
        : p === 'Notice'
          ? 'info'
          : 'unknown'
}

function PriorityChips({ counts }: { counts: Record<string, number> }) {
  const major = (counts['Critical'] ?? 0) + (counts['Alert'] ?? 0) + (counts['Emergency'] ?? 0)
  if (major > 0) return <StatusBadge kind="failed">{major} critical</StatusBadge>
  const warns = (counts['Warning'] ?? 0) + (counts['Error'] ?? 0)
  if (warns > 0) return <StatusBadge kind="progressing">{warns} warning</StatusBadge>
  return <StatusBadge kind="info">{Object.values(counts).reduce((a, b) => a + b, 0)} events</StatusBadge>
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
  value: number
  tone: 'brand' | 'amber' | 'rose' | 'violet' | 'sky' | 'emerald'
  icon: React.ReactNode
  hint?: string
}) {
  const cls = {
    brand: 'from-brand-50 to-white text-brand-700',
    amber: 'from-amber-50 to-white text-amber-700',
    rose: 'from-rose-50 to-white text-rose-700',
    violet: 'from-violet-50 to-white text-violet-700',
    sky: 'from-sky-50 to-white text-sky-700',
    emerald: 'from-emerald-50 to-white text-emerald-700',
  }[tone]
  return (
    <Card className={`relative overflow-hidden bg-linear-to-br ${cls} ring-1 ring-inset ring-edge-subtle`}>
      <CardBody className="space-y-1 p-4">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/80 shadow-sm">
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
    brand: 'border-brand-200/60 bg-brand-50/30',
    amber: 'border-amber-200/60 bg-amber-50/30',
    violet: 'border-violet-200/60 bg-violet-50/30',
    rose: 'border-rose-200/60 bg-rose-50/30',
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

/* ─────────── helpers / icons ─────────── */

interface Rollout {
  status?: { phase?: 'Healthy' | 'Progressing' | 'Paused' | 'Degraded' }
}

function countBy<T>(arr: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const v of arr) {
    const k = key(v)
    out[k] = (out[k] ?? 0) + 1
  }
  return out
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
