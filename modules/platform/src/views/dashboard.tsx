import {
  Card,
  CardBody,
  CardHeader,
  DonutGauge,
  EmptyState,
  Sparkline,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import {
  useApiSurface,
  useConnection,
  useCronJobs,
  useDaemonSets,
  useDeployments,
  useEvents,
  useJobs,
  useNamespaces,
  useNodeMetrics,
  useNodes,
  usePodMetrics,
  usePods,
  useStatefulSets,
} from '../data/hooks.ts'
import { age, formatBytes, formatCpu, parseQuantity } from '../data/format.ts'
import { ViewAsRoleSwitcher } from '../components/role-gate.tsx'
import { K8S_ROLE_LABEL, useK8sCurrentRoles } from '../data/access.ts'

/**
 * Platform dashboard — workspace-level Kubernetes pulse mirroring the
 * Define / Design / Develop / Deliver / Discover / Decide dashboards. Six
 * hero stats with sparklines, capacity gauges, pod phase distribution,
 * recent events feed, top namespaces, and quick-start cards into the
 * sub-views.
 */
export function PlatformDashboard() {
  const version = useConnection()
  const surface = useApiSurface()
  const nodes = useNodes()
  const namespaces = useNamespaces()
  const pods = usePods()
  const nodeMetrics = useNodeMetrics()
  const deployments = useDeployments()
  const statefulSets = useStatefulSets()
  const daemonSets = useDaemonSets()
  const jobs = useJobs()
  const cronJobs = useCronJobs()
  const events = useEvents()
  const podMetrics = usePodMetrics()

  if (version.isLoading || nodes.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading platform pulse…
      </div>
    )
  }

  const capacity = aggregateAllocatable(nodes.data ?? [])
  const usage = aggregateUsage(nodeMetrics.data as RawMetrics[] | undefined)
  const podCount = pods.data?.length ?? 0
  const cpuPct = capacity.cpu > 0 ? Math.min(100, Math.round((usage.cpu / capacity.cpu) * 100)) : 0
  const memPct = capacity.mem > 0 ? Math.min(100, Math.round((usage.mem / capacity.mem) * 100)) : 0
  const podPct = capacity.pods > 0 ? Math.min(100, Math.round((podCount / capacity.pods) * 100)) : 0

  const readyNodes = (nodes.data ?? []).filter((n) => isNodeReady(n)).length
  const totalNodes = nodes.data?.length ?? 0
  const nsActive = namespaces.data?.filter((n) => n.status?.phase === 'Active').length ?? 0
  const podPhases = groupPodsByPhase(pods.data ?? [])
  const topNs = topPodsByNamespace(pods.data ?? [], 6)
  const totalWorkloads =
    (deployments.data?.length ?? 0) +
    (statefulSets.data?.length ?? 0) +
    (daemonSets.data?.length ?? 0) +
    (jobs.data?.length ?? 0) +
    (cronJobs.data?.length ?? 0)

  const eventList = (events.data ?? []).slice().sort(byNewest).slice(0, 8)
  const warns = (events.data ?? []).filter((e) => e.type === 'Warning').length
  const topPods = topPodsByUsage(podMetrics.data as PodMetric[] | undefined, 6)

  return (
    <div className="space-y-6">
      <ClusterSummary
        version={version.data}
        nodes={nodes.data ?? []}
        readyNodes={readyNodes}
        totalNodes={totalNodes}
        namespaces={namespaces.data?.length ?? 0}
        apiGroups={surface.data?.apiGroups.length ?? 0}
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <HeroStat
          label="Nodes"
          value={String(totalNodes)}
          tone={readyNodes === totalNodes ? 'emerald' : 'amber'}
          icon={<IconServer />}
          hint={`${readyNodes} ready · ${totalNodes - readyNodes} attention`}
        />
        <HeroStat
          label="Pods"
          value={String(podCount)}
          tone="brand"
          icon={<IconBox />}
          hint={`${podPhases.Running} running · ${podPhases.Pending + podPhases.Failed} attention`}
        />
        <HeroStat
          label="Workloads"
          value={String(totalWorkloads)}
          tone="violet"
          icon={<IconLayer />}
          hint={`${deployments.data?.length ?? 0} deploys · ${statefulSets.data?.length ?? 0} ss`}
        />
        <HeroStat
          label="Namespaces"
          value={String(namespaces.data?.length ?? 0)}
          tone="sky"
          icon={<IconFolder />}
          hint={`${nsActive} active`}
        />
        <HeroStat
          label="API groups"
          value={String(surface.data?.apiGroups.length ?? 0)}
          tone="emerald"
          icon={<IconCode />}
          hint={version.data?.gitVersion ?? '—'}
        />
        <HeroStat
          label="Events · warn"
          value={String(warns)}
          tone={warns > 0 ? 'rose' : 'emerald'}
          icon={<IconBell />}
          hint={`${events.data?.length ?? 0} total this hour`}
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-content">Capacity utilization</div>
              <div className="text-[11px] text-content-subtle">
                {nodeMetrics.data && (nodeMetrics.data as unknown[]).length
                  ? 'Live usage from metrics-server'
                  : 'metrics-server missing — showing allocatable only'}
              </div>
            </div>
            <StatusBadge
              kind={
                nodeMetrics.data && (nodeMetrics.data as unknown[]).length ? 'healthy' : 'unknown'
              }
            >
              {nodeMetrics.data && (nodeMetrics.data as unknown[]).length
                ? 'metrics live'
                : 'static capacity'}
            </StatusBadge>
          </div>
        </CardHeader>
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <GaugeTile
            title="CPU"
            pct={cpuPct}
            primary={`${formatCpu(usage.cpu)} / ${formatCpu(capacity.cpu)}`}
            secondary={`${formatCpu(Math.max(0, capacity.cpu - usage.cpu))} free`}
            color="var(--color-brand-500)"
          />
          <GaugeTile
            title="Memory"
            pct={memPct}
            primary={`${formatBytes(usage.mem)} / ${formatBytes(capacity.mem)}`}
            secondary={`${formatBytes(Math.max(0, capacity.mem - usage.mem))} free`}
            color="var(--color-accent-500)"
          />
          <GaugeTile
            title="Pods"
            pct={podPct}
            primary={`${podCount} / ${capacity.pods}`}
            secondary={`${Math.max(0, capacity.pods - podCount)} slots free`}
            color="#8b5cf6"
          />
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-content">Pod phases</div>
                <div className="text-[11px] text-content-subtle">Across every namespace</div>
              </div>
              <StatusBadge kind="info">{podCount} pods</StatusBadge>
            </div>
          </CardHeader>
          <CardBody className="space-y-3">
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-edge-subtle">
              {[
                { value: podPhases.Running, color: 'var(--color-emerald-500)' },
                { value: podPhases.Pending, color: 'var(--color-amber-500)' },
                { value: podPhases.Failed, color: 'var(--color-rose-500)' },
                { value: podPhases.Succeeded, color: 'var(--color-brand-500)' },
                { value: podPhases.Unknown, color: 'var(--color-edge-strong)' },
              ].map((s, i) => {
                const total = Math.max(podCount, 1)
                const w = (s.value / total) * 100
                if (w <= 0) return null
                return (
                  <div
                    key={i}
                    className="h-full transition-[width] duration-500"
                    style={{ width: `${w}%`, backgroundColor: s.color }}
                  />
                )
              })}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <PhaseTile label="Running" value={podPhases.Running} dot="bg-emerald-500" />
              <PhaseTile label="Pending" value={podPhases.Pending} dot="bg-amber-500" />
              <PhaseTile label="Failed" value={podPhases.Failed} dot="bg-rose-500" />
              <PhaseTile label="Succeeded" value={podPhases.Succeeded} dot="bg-brand-500" />
              <PhaseTile label="Unknown" value={podPhases.Unknown} dot="bg-edge-strong" />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-sm font-semibold text-content">Top namespaces</div>
            <div className="text-[11px] text-content-subtle">By pod density</div>
          </CardHeader>
          <CardBody className="space-y-1.5">
            {topNs.length === 0 ? (
              <EmptyState compact title="No pods" />
            ) : (
              topNs.map((n) => (
                <div key={n.namespace}>
                  <div className="flex items-baseline justify-between text-[11px]">
                    <code className="truncate font-mono text-content">{n.namespace}</code>
                    <span className="font-mono tabular-nums text-content-subtle">{n.count}</span>
                  </div>
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
                    <div
                      className="h-full bg-linear-to-r from-brand-500 to-brand-400"
                      style={{ width: `${(n.count / Math.max(...topNs.map((x) => x.count), 1)) * 100}%` }}
                    />
                  </div>
                </div>
              ))
            )}
          </CardBody>
        </Card>
      </div>

      <TopConsumers
        loading={podMetrics.isLoading}
        hasMetrics={Array.isArray(podMetrics.data) && podMetrics.data.length > 0}
        rows={topPods}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-content">Recent events</div>
                <div className="text-[11px] text-content-subtle">Newest first · auto-refresh 10s</div>
              </div>
              {warns > 0 ? (
                <StatusBadge kind="failed">{warns} warnings</StatusBadge>
              ) : (
                <StatusBadge kind="healthy">all normal</StatusBadge>
              )}
            </div>
          </CardHeader>
          <CardBody className="p-0!">
            {eventList.length === 0 ? (
              <EmptyState compact title="No events" />
            ) : (
              <ul className="divide-y divide-edge-subtle">
                {eventList.map((e, i) => (
                  <EventRow key={i} ev={e} />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-sm font-semibold text-content">Node health</div>
            <div className="text-[11px] text-content-subtle">CPU + memory headroom</div>
          </CardHeader>
          <CardBody>
            {totalNodes === 0 ? (
              <EmptyState compact title="No nodes" />
            ) : (
              <ul className="space-y-2">
                {(nodes.data ?? []).slice(0, 6).map((n) => {
                  const ready = isNodeReady(n)
                  const m = findNodeMetric(
                    nodeMetrics.data as RawMetrics[] | undefined,
                    n.metadata.name,
                  )
                  const alloc = n.status?.allocatable ?? {}
                  const cpuAlloc = parseQuantity(alloc.cpu)
                  const memAlloc = parseQuantity(alloc.memory)
                  const cpu = cpuAlloc > 0 ? Math.min(100, (m.cpu / cpuAlloc) * 100) : 0
                  const mem = memAlloc > 0 ? Math.min(100, (m.mem / memAlloc) * 100) : 0
                  return (
                    <li key={n.metadata.name} className="rounded-md border border-edge-subtle bg-surface-sunken/40 p-2">
                      <div className="flex items-center gap-2">
                        <span className={cn('h-1.5 w-1.5 rounded-full', ready ? 'bg-emerald-500' : 'bg-rose-500')} />
                        <span className="truncate text-[11px] font-semibold text-content">{n.metadata.name}</span>
                      </div>
                      <div className="mt-1 grid grid-cols-2 gap-2">
                        <MicroBar pct={cpu} label="CPU" color="var(--color-brand-500)" />
                        <MicroBar pct={mem} label="Mem" color="var(--color-accent-500)" />
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <QuickStartCard
          title="Cluster"
          description="Cluster overview, nodes, API surface."
          links={[
            { label: 'Clusters', href: '?clusters' },
            { label: 'Nodes', href: '?nodes' },
            { label: 'Events', href: '?events' },
          ]}
          tone="brand"
        />
        <QuickStartCard
          title="Workloads"
          description="Deployments, pods, with logs / shell / yaml."
          links={[
            { label: 'Workloads', href: '?workloads' },
            { label: 'Pods', href: '?pods' },
            { label: 'Networking', href: '?networking' },
          ]}
          tone="emerald"
        />
        <QuickStartCard
          title="Configuration"
          description="ConfigMaps, secrets, RBAC, storage, policy."
          links={[
            { label: 'Config', href: '?config' },
            { label: 'RBAC', href: '?rbac' },
            { label: 'Storage', href: '?storage' },
            { label: 'Policy', href: '?policy' },
          ]}
          tone="amber"
        />
        <QuickStartCard
          title="Adhar Resources"
          description="Crossplane composites — apps, dbs, pipelines, routes."
          links={[
            { label: 'Applications', href: '?applications' },
            { label: 'Databases', href: '?databases' },
            { label: 'Data Pipelines', href: '?data-pipelines' },
            { label: 'Routes', href: '?routes' },
          ]}
          tone="violet"
        />
      </div>
    </div>
  )
}

/* ─────────── rows / atoms ─────────── */

function EventRow({ ev }: { ev: { type?: string; reason?: string; message?: string; lastTimestamp?: string; eventTime?: string; involvedObject?: { kind?: string; name?: string; namespace?: string } } }) {
  const tone = ev.type === 'Warning' ? 'failed' : 'info'
  const ts = ev.lastTimestamp ?? ev.eventTime
  const obj = ev.involvedObject
  return (
    <li className="px-5 py-2.5 transition-colors hover:bg-brand-50/40">
      <div className="flex items-center gap-2">
        <StatusBadge kind={tone}>{ev.type ?? 'Normal'}</StatusBadge>
        <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted">
          {ev.reason ?? '—'}
        </code>
        <span className="ml-auto text-[10px] text-content-subtle">{age(ts) ?? '—'}</span>
      </div>
      {ev.message ? (
        <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-content">
          {ev.message}
        </div>
      ) : null}
      {obj ? (
        <div className="mt-1 font-mono text-[10px] text-content-subtle">
          {obj.kind}/{obj.name}{obj.namespace ? ` @ ${obj.namespace}` : ''}
        </div>
      ) : null}
    </li>
  )
}

function PhaseTile({ label, value, dot }: { label: string; value: number; dot: string }) {
  return (
    <div className="rounded-md border border-edge-subtle bg-white p-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
          {label}
        </span>
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      </div>
      <div className="mt-1 text-base font-semibold tabular-nums text-content">{value}</div>
    </div>
  )
}

function MicroBar({ pct, label, color }: { pct: number; label: string; color: string }) {
  return (
    <div title={`${label} ${Math.round(pct)}%`}>
      <div className="flex items-baseline justify-between text-[9px] text-content-subtle">
        <span>{label}</span>
        <span className="tabular-nums">{Math.round(pct)}%</span>
      </div>
      <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-surface-sunken">
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.max(0, Math.min(100, pct))}%`,
            backgroundColor: pct >= 85 ? '#f43f5e' : pct >= 65 ? '#f59e0b' : color,
          }}
        />
      </div>
    </div>
  )
}

function GaugeTile({
  title,
  pct,
  primary,
  secondary,
  color,
}: {
  title: string
  pct: number
  primary: string
  secondary: string
  color: string
}) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-edge-subtle bg-surface-sunken/60 p-4">
      <DonutGauge
        value={pct}
        max={100}
        size={100}
        thickness={12}
        color={pct >= 85 ? '#f43f5e' : pct >= 65 ? '#f59e0b' : color}
        label={
          <span>
            {pct}
            <span className="text-xs font-normal text-content-muted">%</span>
          </span>
        }
      />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
          {title}
        </div>
        <div className="mt-1 truncate font-mono tabular-nums text-sm text-content">{primary}</div>
        <div className="text-[11px] text-content-muted">{secondary}</div>
      </div>
    </div>
  )
}

function HeroStat({
  label,
  value,
  tone,
  icon,
  hint,
}: {
  label: string
  value: string
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

/* ─────────── cluster summary ─────────── */

function ClusterSummary({
  version,
  nodes,
  readyNodes,
  totalNodes,
  namespaces,
  apiGroups,
}: {
  version?: { gitVersion?: string; platform?: string; gitCommit?: string }
  nodes: Array<{ status?: { nodeInfo?: { kubeletVersion?: string; containerRuntimeVersion?: string; osImage?: string; architecture?: string } } }>
  readyNodes: number
  totalNodes: number
  namespaces: number
  apiGroups: number
}) {
  const sample = nodes[0]?.status?.nodeInfo
  return (
    <div className="overflow-hidden rounded-2xl border border-edge-default bg-linear-to-br from-brand-50/70 via-white to-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white shadow-sm ring-1 ring-edge-subtle">
            <span className="text-brand-700">
              <IconK8s />
            </span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-content">Local cluster</h2>
              <StatusBadge kind={readyNodes === totalNodes && totalNodes > 0 ? 'healthy' : 'degraded'}>
                {readyNodes === totalNodes && totalNodes > 0 ? 'healthy' : 'attention'}
              </StatusBadge>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-content-muted">
              <span className="font-mono">{version?.gitVersion ?? '—'}</span>
              {version?.platform ? <span className="font-mono">{version.platform}</span> : null}
              {sample?.containerRuntimeVersion ? (
                <span className="font-mono">runtime {sample.containerRuntimeVersion}</span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <SummaryStat label="Nodes" value={`${readyNodes}/${totalNodes}`} hint="ready" />
          <SummaryStat label="Namespaces" value={String(namespaces)} hint="active" />
          <SummaryStat label="API groups" value={String(apiGroups)} hint="available" />
          {sample?.osImage ? (
            <SummaryStat label="OS" value={sample.osImage.split(' ')[0]} hint={sample.architecture} />
          ) : null}
          <ViewAsRoleSwitcher />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-edge-subtle pt-3 text-[11px] text-content-muted">
        <CurrentRolesPill />
      </div>
    </div>
  )
}

function CurrentRolesPill() {
  const roles = useK8sCurrentRoles()
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-semibold uppercase tracking-wider text-content-subtle">Acting as</span>
      {roles.map((r) => (
        <span
          key={r}
          className="rounded-full border border-brand-200/70 bg-brand-50/70 px-2 py-0.5 font-medium text-brand-700"
        >
          {K8S_ROLE_LABEL[r]}
        </span>
      ))}
      <span className="text-content-subtle">
        — RBAC gates Restart, Delete, YAML edit, and Shell exec across the cluster views.
      </span>
    </span>
  )
}

function SummaryStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
        {label}
      </div>
      <div className="mt-0.5 truncate font-mono text-base tabular-nums text-content">{value}</div>
      {hint ? <div className="text-[10px] text-content-subtle">{hint}</div> : null}
    </div>
  )
}

function IconK8s() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2 4 6v12l8 4 8-4V6z" />
      <path d="M12 2v20" />
      <path d="m4 6 16 12" />
      <path d="m20 6-16 12" />
    </svg>
  )
}

/* ─────────── top consumers ─────────── */

function TopConsumers({
  loading,
  hasMetrics,
  rows,
}: {
  loading: boolean
  hasMetrics: boolean
  rows: TopRow[]
}) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <TopConsumerList
        loading={loading}
        hasMetrics={hasMetrics}
        title="Top pods by CPU"
        rows={rows.slice().sort((a, b) => b.cpu - a.cpu)}
        unit="cpu"
      />
      <TopConsumerList
        loading={loading}
        hasMetrics={hasMetrics}
        title="Top pods by memory"
        rows={rows.slice().sort((a, b) => b.mem - a.mem)}
        unit="mem"
      />
    </div>
  )
}

function TopConsumerList({
  loading,
  hasMetrics,
  title,
  rows,
  unit,
}: {
  loading: boolean
  hasMetrics: boolean
  title: string
  rows: TopRow[]
  unit: 'cpu' | 'mem'
}) {
  const max = unit === 'cpu' ? Math.max(...rows.map((r) => r.cpu), 0.001) : Math.max(...rows.map((r) => r.mem), 1)
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-content">{title}</div>
            <div className="text-[11px] text-content-subtle">
              {hasMetrics ? 'live · metrics-server' : 'metrics-server unavailable'}
            </div>
          </div>
          <StatusBadge kind={hasMetrics ? 'healthy' : 'unknown'}>
            {hasMetrics ? 'live' : 'offline'}
          </StatusBadge>
        </div>
      </CardHeader>
      <CardBody className="p-0!">
        {!hasMetrics ? (
          <EmptyState
            compact
            title="No pod metrics"
            description="Install metrics-server to see live CPU/memory usage per pod."
          />
        ) : loading ? (
          <div className="flex items-center gap-2 p-5 text-sm text-content-muted">
            <Spinner size={14} /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <EmptyState compact title="No data" />
        ) : (
          <ul className="divide-y divide-edge-subtle">
            {rows.slice(0, 5).map((p) => {
              const value = unit === 'cpu' ? p.cpu : p.mem
              const label = unit === 'cpu' ? formatCpu(p.cpu) : formatBytes(p.mem)
              const pct = (value / max) * 100
              return (
                <li key={`${p.namespace}/${p.name}`} className="space-y-1 px-5 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium text-content">{p.name}</div>
                      <code className="font-mono text-[10px] text-content-subtle">
                        {p.namespace}
                      </code>
                    </div>
                    <span className="font-mono text-[12px] tabular-nums text-content">{label}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                    <div
                      className={cn(
                        'h-full rounded-full transition-[width] duration-500',
                        unit === 'cpu' ? 'bg-brand-500' : 'bg-violet-500',
                      )}
                      style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
                    />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

interface TopRow {
  name: string
  namespace: string
  cpu: number
  mem: number
}

interface PodMetric {
  metadata: { name: string; namespace?: string }
  containers?: Array<{ usage?: { cpu?: string; memory?: string } }>
}

function topPodsByUsage(metrics: PodMetric[] | undefined, limit: number): TopRow[] {
  if (!metrics) return []
  const out: TopRow[] = []
  for (const p of metrics) {
    let cpu = 0
    let mem = 0
    for (const c of p.containers ?? []) {
      cpu += parseQuantity(c.usage?.cpu)
      mem += parseQuantity(c.usage?.memory)
    }
    out.push({ name: p.metadata.name, namespace: p.metadata.namespace ?? '—', cpu, mem })
  }
  return out
    .sort((a, b) => b.cpu + b.mem / 1e9 - (a.cpu + a.mem / 1e9))
    .slice(0, limit)
}

/* ─────────── helpers ─────────── */

interface RawMetrics {
  metadata: { name: string }
  usage?: { cpu?: string; memory?: string }
}

function aggregateAllocatable(nodes: Array<{ status?: { allocatable?: Record<string, string> } }>) {
  let cpu = 0
  let mem = 0
  let pods = 0
  for (const n of nodes) {
    const alloc = n.status?.allocatable ?? {}
    cpu += parseQuantity(alloc.cpu)
    mem += parseQuantity(alloc.memory)
    pods += parseQuantity(alloc.pods)
  }
  return { cpu, mem, pods: Math.round(pods) }
}

function aggregateUsage(metrics: RawMetrics[] | undefined) {
  if (!metrics) return { cpu: 0, mem: 0 }
  let cpu = 0
  let mem = 0
  for (const m of metrics) {
    cpu += parseQuantity(m.usage?.cpu)
    mem += parseQuantity(m.usage?.memory)
  }
  return { cpu, mem }
}

function findNodeMetric(metrics: RawMetrics[] | undefined, name: string) {
  const m = (metrics ?? []).find((x) => x.metadata.name === name)
  return { cpu: parseQuantity(m?.usage?.cpu), mem: parseQuantity(m?.usage?.memory) }
}

function groupPodsByPhase(pods: Array<{ status?: { phase?: string } }>) {
  const out = { Running: 0, Pending: 0, Failed: 0, Succeeded: 0, Unknown: 0 }
  for (const p of pods) {
    const phase = p.status?.phase ?? 'Unknown'
    if (phase in out) out[phase as keyof typeof out]++
    else out.Unknown++
  }
  return out
}

function topPodsByNamespace(pods: Array<{ metadata: { namespace?: string } }>, limit: number) {
  const counts = new Map<string, number>()
  for (const p of pods) {
    const ns = p.metadata.namespace ?? '(none)'
    counts.set(ns, (counts.get(ns) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([namespace, count]) => ({ namespace, count }))
}

function isNodeReady(node: {
  status?: { conditions?: Array<{ type: string; status: string }> }
}): boolean {
  return (node.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True')
}

function byNewest(
  a: { lastTimestamp?: string; eventTime?: string },
  b: { lastTimestamp?: string; eventTime?: string },
) {
  const ta = new Date(a.lastTimestamp ?? a.eventTime ?? 0).getTime()
  const tb = new Date(b.lastTimestamp ?? b.eventTime ?? 0).getTime()
  return tb - ta
}

/* ─────────── icons ─────────── */

function IconServer() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  )
}
function IconBox() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
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
function IconFolder() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}
function IconCode() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
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
function IconArrow() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}

// Sparkline kept in scope for future per-node trend charts.
export const _pin = { Sparkline }
