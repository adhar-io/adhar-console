import {
  BarChart,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  DonutGauge,
  EmptyState,
  LegendDot,
  Skeleton,
  Sparkline,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import {
  useApiSurface,
  useConnection,
  useCronJobs,
  useDaemonSets,
  useDeployments,
  useJobs,
  useNamespaces,
  useNodeMetrics,
  useNodes,
  usePods,
  useStatefulSets,
} from '../data/hooks.ts'
import { age, formatBytes, formatCpu, parseQuantity } from '../data/format.ts'

/**
 * Cluster overview — every section is live from the apiserver and polls on
 * the same 10s cadence as the rest of the Platform module. Charts are zero-
 * dep SVG (shell-ui/charts) so they follow the active theme.
 *
 * Layout
 * ─────────────────────────────────────────────
 *   1. Hero stats (version, nodes ready, namespaces, API groups)
 *   2. Capacity gauges (CPU / Memory / Pods used vs allocatable)
 *   3. Pods by namespace + Pod phase breakdown
 *   4. Workload kind mix + Node health roster
 *   5. API groups table + Cluster identity card
 */
export function ClusterView() {
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

  if (version.isError) return null

  const capacity = aggregateAllocatable(nodes.data ?? [])
  const usage = aggregateUsage(nodeMetrics.data as RawMetrics[] | undefined)
  const podCount = pods.data?.length ?? 0

  const cpuPct = capacity.cpu > 0 ? Math.min(100, Math.round((usage.cpu / capacity.cpu) * 100)) : 0
  const memPct = capacity.mem > 0 ? Math.min(100, Math.round((usage.mem / capacity.mem) * 100)) : 0
  const podPct = capacity.pods > 0 ? Math.min(100, Math.round((podCount / capacity.pods) * 100)) : 0

  const podPhases = groupPodsByPhase(pods.data ?? [])
  const podsByNamespace = topPodsByNamespace(pods.data ?? [], 8)
  const workloadCounts = [
    { label: 'Deploys', value: deployments.data?.length ?? 0, color: 'var(--color-brand-500)' },
    {
      label: 'StatefulSets',
      value: statefulSets.data?.length ?? 0,
      color: 'var(--color-brand-600)',
    },
    {
      label: 'DaemonSets',
      value: daemonSets.data?.length ?? 0,
      color: 'var(--color-accent-500)',
    },
    { label: 'Jobs', value: jobs.data?.length ?? 0, color: '#8b5cf6' },
    { label: 'CronJobs', value: cronJobs.data?.length ?? 0, color: '#06b6d4' },
  ]

  const readyNodes = (nodes.data ?? []).filter((n) => isNodeReady(n)).length
  const totalNodes = nodes.data?.length ?? 0
  const nsActive = namespaces.data?.filter((n) => n.status?.phase === 'Active').length ?? 0

  return (
    <div className="space-y-6">
      {/* ─── Hero stats ─── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Server version"
          value={version.data?.gitVersion ?? <Skeleton width={100} height={16} />}
          sub={version.data?.platform}
          accent="brand"
        />
        <Stat
          label="Nodes"
          value={nodes.isLoading ? <Skeleton width={30} height={16} /> : String(totalNodes)}
          sub={`${readyNodes} ready · ${totalNodes - readyNodes} attention`}
          accent={readyNodes === totalNodes ? 'emerald' : 'amber'}
        />
        <Stat
          label="Namespaces"
          value={
            namespaces.isLoading
              ? <Skeleton width={30} height={16} />
              : String(namespaces.data?.length ?? 0)
          }
          sub={`${nsActive} active`}
          accent="brand"
        />
        <Stat
          label="API groups"
          value={
            surface.isLoading
              ? <Skeleton width={30} height={16} />
              : String(surface.data?.apiGroups.length ?? 0)
          }
          sub={`core/v1 · ${surface.data?.coreVersions.join(', ') ?? ''}`}
          accent="brand"
        />
      </div>

      {/* ─── Capacity gauges ─── */}
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
            <StatusBadge kind={nodeMetrics.data && (nodeMetrics.data as unknown[]).length ? 'healthy' : 'unknown'}>
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

      {/* ─── Composition row ─── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-content">Pods by namespace</div>
              <span className="text-[11px] text-content-subtle">top {podsByNamespace.length}</span>
            </div>
          </CardHeader>
          <CardBody>
            {podsByNamespace.length === 0 ? (
              <EmptyState compact title="No pods in this cluster" />
            ) : (
              <BarChart
                bars={podsByNamespace.map((p) => ({ label: p.namespace, value: p.count }))}
                height={128}
                color="var(--color-brand-500)"
              />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-content">Pod phase breakdown</div>
              <div className="flex flex-wrap gap-2">
                <LegendDot color="var(--color-brand-500)">Running</LegendDot>
                <LegendDot color="#f59e0b">Pending</LegendDot>
                <LegendDot color="#f43f5e">Failed</LegendDot>
                <LegendDot color="var(--color-accent-500)">Succeeded</LegendDot>
              </div>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <StackedBar
              total={podCount}
              segments={[
                { value: podPhases.Running, color: 'var(--color-brand-500)' },
                { value: podPhases.Pending, color: '#f59e0b' },
                { value: podPhases.Failed, color: '#f43f5e' },
                { value: podPhases.Succeeded, color: 'var(--color-accent-500)' },
                { value: podPhases.Unknown, color: 'var(--color-edge-strong)' },
              ]}
            />
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
              <PhaseTile label="Running" count={podPhases.Running} total={podCount} color="var(--color-brand-500)" />
              <PhaseTile label="Pending" count={podPhases.Pending} total={podCount} color="#f59e0b" />
              <PhaseTile label="Failed" count={podPhases.Failed} total={podCount} color="#f43f5e" />
              <PhaseTile
                label="Succeeded"
                count={podPhases.Succeeded}
                total={podCount}
                color="var(--color-accent-500)"
              />
              <PhaseTile
                label="Unknown"
                count={podPhases.Unknown}
                total={podCount}
                color="var(--color-edge-strong)"
              />
            </div>
          </CardBody>
        </Card>
      </div>

      {/* ─── Workloads + Node roster ─── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-content">Workload mix</div>
              <span className="text-[11px] text-content-subtle">by kind</span>
            </div>
          </CardHeader>
          <CardBody>
            <BarChart
              bars={workloadCounts.map((w) => ({ label: w.label, value: w.value, color: w.color }))}
              height={128}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-content">Node health</div>
              <StatusBadge kind={readyNodes === totalNodes ? 'healthy' : 'degraded'}>
                {readyNodes}/{totalNodes} ready
              </StatusBadge>
            </div>
          </CardHeader>
          <CardBody>
            {totalNodes === 0 ? (
              <EmptyState compact title="No nodes" />
            ) : (
              <ul className="divide-y divide-edge-subtle">
                {(nodes.data ?? []).map((n) => {
                  const ready = isNodeReady(n)
                  const pressure = nodePressures(n)
                  const perNodeMetrics = findNodeMetric(
                    nodeMetrics.data as RawMetrics[] | undefined,
                    n.metadata.name,
                  )
                  const alloc = n.status?.allocatable ?? {}
                  const cpuAlloc = parseQuantity(alloc.cpu)
                  const memAlloc = parseQuantity(alloc.memory)
                  const cpuPct = cpuAlloc > 0 ? Math.min(100, (perNodeMetrics.cpu / cpuAlloc) * 100) : 0
                  const memPct = memAlloc > 0 ? Math.min(100, (perNodeMetrics.mem / memAlloc) * 100) : 0
                  return (
                    <li
                      key={n.metadata.name}
                      className="flex items-center gap-3 py-3 text-sm"
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'h-2 w-2 shrink-0 rounded-full',
                          ready ? 'bg-emerald-500' : 'bg-rose-500',
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-content">{n.metadata.name}</div>
                        <div className="text-[11px] text-content-subtle">
                          {nodeRolesOf(n.metadata.labels).join(' · ') || 'worker'}
                          {pressure.length ? ` · ${pressure.join(', ')} pressure` : ''}
                        </div>
                      </div>
                      <div className="w-24">
                        <MicroBar pct={cpuPct} color="var(--color-brand-500)" label="CPU" />
                      </div>
                      <div className="w-24">
                        <MicroBar pct={memPct} color="var(--color-accent-500)" label="Mem" />
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {/* ─── API groups + Cluster identity ─── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="text-sm font-semibold text-content">API groups</div>
          </CardHeader>
          <CardBody>
            {surface.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} height={16} />
                ))}
              </div>
            ) : (
              <DataTable
                dense
                columns={[
                  {
                    key: 'name',
                    header: 'Group',
                    cell: (g) => <code className="text-xs">{g.name || 'core'}</code>,
                  },
                  {
                    key: 'preferred',
                    header: 'Preferred',
                    cell: (g) => <code className="text-xs">{g.preferredVersion}</code>,
                  },
                  {
                    key: 'versions',
                    header: 'Versions',
                    cell: (g) => (
                      <span className="text-xs text-content-muted">{g.versions.join(', ')}</span>
                    ),
                  },
                ]}
                rows={surface.data?.apiGroups ?? []}
                rowKey={(g) => g.name}
                empty={<EmptyState compact title="No API groups discovered" />}
              />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="text-sm font-semibold text-content">Cluster identity</div>
          </CardHeader>
          <CardBody className="space-y-2.5">
            <IdentityRow label="Version" value={version.data?.gitVersion ?? '—'} mono />
            <IdentityRow label="Platform" value={version.data?.platform ?? '—'} />
            <IdentityRow
              label="Oldest node"
              value={age(
                nodes.data?.reduce<string | undefined>((oldest, n) => {
                  const t = n.metadata.creationTimestamp
                  if (!t) return oldest
                  return !oldest || new Date(t) < new Date(oldest) ? t : oldest
                }, undefined),
              )}
            />
            <IdentityRow
              label="Core versions"
              value={surface.data?.coreVersions.join(', ') ?? '—'}
              mono
            />
            <IdentityRow
              label="Pod density"
              value={
                capacity.pods > 0
                  ? `${Math.round((podCount / capacity.pods) * 100)}% of cap`
                  : '—'
              }
            />
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

/* ───── chart atoms ───── */

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
        <div className="mt-1 truncate font-mono tabular-nums text-sm text-content">
          {primary}
        </div>
        <div className="text-[11px] text-content-muted">{secondary}</div>
      </div>
    </div>
  )
}

function StackedBar({
  total,
  segments,
}: {
  total: number
  segments: Array<{ value: number; color: string }>
}) {
  if (total <= 0) {
    return (
      <div className="flex h-5 items-center justify-center rounded-full bg-surface-sunken text-[11px] text-content-subtle">
        No pods
      </div>
    )
  }
  return (
    <div className="flex h-5 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-edge-subtle">
      {segments.map((s, i) => {
        const pct = total > 0 ? (s.value / total) * 100 : 0
        if (pct <= 0) return null
        return (
          <div
            key={i}
            className="h-full transition-[width] duration-500 ease-smooth"
            style={{ width: `${pct}%`, backgroundColor: s.color }}
            title={`${s.value} (${Math.round(pct)}%)`}
          />
        )
      })}
    </div>
  )
}

function PhaseTile({
  label,
  count,
  total,
  color,
}: {
  label: string
  count: number
  total: number
  color: string
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-raised p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
          {label}
        </span>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="text-lg font-semibold tabular-nums text-content">{count}</span>
        <span className="text-[11px] text-content-subtle">{pct}%</span>
      </div>
    </div>
  )
}

function MicroBar({ pct, color, label }: { pct: number; color: string; label: string }) {
  return (
    <div title={`${label} ${Math.round(pct)}%`}>
      <div className="flex items-baseline justify-between text-[10px] text-content-subtle">
        <span>{label}</span>
        <span className="tabular-nums">{Math.round(pct)}%</span>
      </div>
      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-smooth"
          style={{
            width: `${Math.max(0, Math.min(100, pct))}%`,
            backgroundColor: pct >= 85 ? '#f43f5e' : pct >= 65 ? '#f59e0b' : color,
          }}
        />
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  accent = 'brand',
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  accent?: 'brand' | 'emerald' | 'amber' | 'rose'
}) {
  const dotColor =
    accent === 'emerald'
      ? 'var(--color-brand-500)'
      : accent === 'amber'
        ? '#f59e0b'
        : accent === 'rose'
          ? '#f43f5e'
          : 'var(--color-brand-500)'
  return (
    <Card interactive>
      <CardBody className="relative space-y-1">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
            {label}
          </div>
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: dotColor }}
            aria-hidden
          />
        </div>
        <div className="text-lg font-semibold tabular-nums text-content">{value}</div>
        {sub ? <div className="truncate text-xs text-content-muted">{sub}</div> : null}
      </CardBody>
    </Card>
  )
}

function IdentityRow({
  label,
  value,
  mono,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-edge-subtle pb-2.5 text-sm last:border-0 last:pb-0">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
        {label}
      </span>
      <span
        className={cn(
          'text-right text-content',
          mono && 'font-mono text-xs',
        )}
      >
        {value}
      </span>
    </div>
  )
}

/* ───── aggregations ───── */

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
  return {
    cpu: parseQuantity(m?.usage?.cpu),
    mem: parseQuantity(m?.usage?.memory),
  }
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

function topPodsByNamespace(
  pods: Array<{ metadata: { namespace?: string } }>,
  limit: number,
) {
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

function nodePressures(node: {
  status?: { conditions?: Array<{ type: string; status: string }> }
}): string[] {
  return (node.status?.conditions ?? [])
    .filter(
      (c) =>
        c.status === 'True' &&
        ['MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable'].includes(c.type),
    )
    .map((c) => c.type.replace('Pressure', '').replace('NetworkUnavailable', 'Network'))
}

function nodeRolesOf(labels: Record<string, string> | undefined): string[] {
  if (!labels) return []
  const out: string[] = []
  for (const k of Object.keys(labels)) {
    const m = k.match(/^node-role\.kubernetes\.io\/(.+)$/)
    if (m) out.push(m[1])
  }
  return out
}

// Sparkline is imported so it'll be tree-kept — kept for future node-level
// historical charts without another edit.
export const _chartPin = { Sparkline }
