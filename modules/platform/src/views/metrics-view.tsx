import { useMemo, useState } from 'react'
import {
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Spinner,
  StatusBadge,
  type Column,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { useNodeMetrics, useNodes, usePodMetrics, usePods } from '../data/hooks.ts'
import { formatBytes, formatCpu, nodeRoles, parseQuantity } from '../data/format.ts'

/**
 * Cluster metrics dashboard — live CPU + memory utilization sourced from
 * `metrics.k8s.io/v1beta1` (metrics-server) joined against node allocatable
 * capacity. Three sections: cluster totals with usage bars, a per-node
 * breakdown, and top pod consumers by CPU / memory.
 *
 * Quantities are parsed with the shared `parseQuantity` helper — it already
 * yields **cores** for CPU (`250m`, `2`, `1500000n`) and **bytes** for memory
 * (`128Mi`, `2Gi`, `1000000Ki`), so aggregation stays in those units and
 * renders through `formatCpu` / `formatBytes` like every other view.
 *
 * metrics-server may be absent (bare kind clusters) — the metrics hooks return
 * `[]` in that case, and we fall back to "allocatable only" with a clear note.
 */
export function MetricsView() {
  const nodes = useNodes()
  const nodeMetrics = useNodeMetrics()
  const pods = usePods()
  const podMetrics = usePodMetrics()

  const nodeList = nodes.data ?? []
  const metricByNode = useMemo(
    () => indexNodeMetrics(nodeMetrics.data as NodeMetric[] | undefined),
    [nodeMetrics.data],
  )
  const podRows = useMemo(
    () => podConsumers(podMetrics.data as PodMetricItem[] | undefined),
    [podMetrics.data],
  )

  if (nodes.isError) {
    return <EmptyState title="Couldn't load cluster metrics" description={(nodes.error as Error).message} />
  }

  if (nodes.isLoading && nodeList.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading cluster metrics…
      </div>
    )
  }

  const hasNodeMetrics = Array.isArray(nodeMetrics.data) && nodeMetrics.data.length > 0
  const hasPodMetrics = Array.isArray(podMetrics.data) && podMetrics.data.length > 0

  // Cluster totals — CPU in cores, memory in bytes, pods as a count.
  const totals = nodeList.reduce(
    (acc, n) => {
      const alloc = n.status?.allocatable ?? {}
      const m = metricByNode.get(n.metadata.name)
      acc.cpuAlloc += parseQuantity(alloc.cpu)
      acc.memAlloc += parseQuantity(alloc.memory)
      acc.podAlloc += parseQuantity(alloc.pods)
      acc.storageAlloc += parseQuantity(alloc['ephemeral-storage'])
      acc.cpuUsed += m?.cpu ?? 0
      acc.memUsed += m?.mem ?? 0
      return acc
    },
    { cpuAlloc: 0, memAlloc: 0, podAlloc: 0, storageAlloc: 0, cpuUsed: 0, memUsed: 0 },
  )
  const podCount = pods.data?.length ?? 0
  const podCapacity = Math.round(totals.podAlloc)
  const readyNodes = nodeList.filter(isNodeReady).length

  const cpuPct = pct(totals.cpuUsed, totals.cpuAlloc)
  const memPct = pct(totals.memUsed, totals.memAlloc)
  const podPct = pct(podCount, podCapacity)

  return (
    <div className="space-y-6">
      {!hasNodeMetrics ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
          <IconWarn />
          <span>
            <span className="font-semibold">metrics-server is not installed.</span> Live CPU and
            memory usage require the{' '}
            <code className="font-mono">metrics.k8s.io</code> API — showing allocatable capacity
            only. Install{' '}
            <a
              href="https://github.com/kubernetes-sigs/metrics-server"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-amber-900 dark:text-amber-200 underline hover:text-amber-950"
            >
              metrics-server
            </a>{' '}
            to populate the usage bars below.
          </span>
        </div>
      ) : null}

      {/* ── Cluster totals ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label="CPU"
          primary={hasNodeMetrics ? `${formatCpu(totals.cpuUsed)} / ${formatCpu(totals.cpuAlloc)} cores` : `${formatCpu(totals.cpuAlloc)} cores`}
          secondary={hasNodeMetrics ? `${formatCpu(Math.max(0, totals.cpuAlloc - totals.cpuUsed))} free` : 'allocatable'}
          pct={hasNodeMetrics ? cpuPct : null}
        />
        <StatTile
          label="Memory"
          primary={hasNodeMetrics ? `${formatBytes(totals.memUsed)} / ${formatBytes(totals.memAlloc)}` : formatBytes(totals.memAlloc)}
          secondary={hasNodeMetrics ? `${formatBytes(Math.max(0, totals.memAlloc - totals.memUsed))} free` : 'allocatable'}
          pct={hasNodeMetrics ? memPct : null}
        />
        <StatTile
          label="Storage"
          primary={totals.storageAlloc > 0 ? formatBytes(totals.storageAlloc) : '—'}
          secondary="ephemeral allocatable"
          pct={null}
        />
        <StatTile
          label="Pods"
          primary={`${podCount} / ${podCapacity}`}
          secondary={`${Math.max(0, podCapacity - podCount)} slots free`}
          pct={podPct}
        />
        <StatTile
          label="Nodes"
          primary={String(nodeList.length)}
          secondary={`${readyNodes} ready · ${nodeList.length - readyNodes} attention`}
          pct={null}
          badge={
            <StatusBadge kind={readyNodes === nodeList.length && nodeList.length > 0 ? 'healthy' : 'degraded'}>
              {readyNodes === nodeList.length && nodeList.length > 0 ? 'healthy' : 'attention'}
            </StatusBadge>
          }
        />
      </div>

      {/* ── Per-node breakdown ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-content">Node utilization</div>
              <div className="text-[11px] text-content-subtle">
                Usage vs allocatable · auto-refresh 10s
              </div>
            </div>
            <StatusBadge kind={hasNodeMetrics ? 'healthy' : 'unknown'}>
              {hasNodeMetrics ? 'metrics live' : 'static capacity'}
            </StatusBadge>
          </div>
        </CardHeader>
        <CardBody className="p-0!">
          <NodeTable nodes={nodeList} metrics={metricByNode} loading={nodes.isLoading} showUsage={hasNodeMetrics} />
        </CardBody>
      </Card>

      {/* ── Top pods ───────────────────────────────────────────────── */}
      <TopPods rows={podRows} hasMetrics={hasPodMetrics} loading={podMetrics.isLoading} />
    </div>
  )
}

export default MetricsView

/* ─────────── cluster stat tile ─────────── */

function StatTile({
  label,
  primary,
  secondary,
  pct,
  badge,
}: {
  label: string
  primary: string
  secondary: string
  /** Null hides the usage bar (unknown / not-a-ratio metric). */
  pct: number | null
  badge?: React.ReactNode
}) {
  return (
    <Card>
      <CardBody className="space-y-2 p-4">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
            {label}
          </span>
          {badge ?? (pct !== null ? (
            <span className="font-mono text-xs tabular-nums text-content-muted">{pct}%</span>
          ) : null)}
        </div>
        <div className="truncate font-mono text-lg font-semibold tabular-nums text-content">
          {primary}
        </div>
        {pct !== null ? <UsageBar pct={pct} /> : null}
        <div className="text-[11px] text-content-muted">{secondary}</div>
      </CardBody>
    </Card>
  )
}

/* ─────────── node table ─────────── */

type NodeItem = NonNullable<ReturnType<typeof useNodes>['data']>[number]

function NodeTable({
  nodes,
  metrics,
  loading,
  showUsage,
}: {
  nodes: NodeItem[]
  metrics: Map<string, { cpu: number; mem: number }>
  loading: boolean
  showUsage: boolean
}) {
  const columns: Column<NodeItem>[] = [
    {
      key: 'name',
      header: 'Node',
      cell: (n) => {
        const roles = nodeRoles(n.metadata.labels)
        return (
          <div className="min-w-0">
            <div className="truncate font-medium text-content">{n.metadata.name}</div>
            <div className="text-[11px] text-content-subtle">
              {roles.length ? roles.join(', ') : 'worker'}
            </div>
          </div>
        )
      },
    },
    {
      key: 'cpu',
      header: 'CPU',
      cell: (n) => {
        const alloc = parseQuantity(n.status?.allocatable?.cpu)
        const used = metrics.get(n.metadata.name)?.cpu ?? 0
        return (
          <ResourceCell
            text={showUsage ? `${formatCpu(used)} / ${formatCpu(alloc)}` : formatCpu(alloc)}
            pct={showUsage ? pct(used, alloc) : null}
          />
        )
      },
    },
    {
      key: 'mem',
      header: 'Memory',
      cell: (n) => {
        const alloc = parseQuantity(n.status?.allocatable?.memory)
        const used = metrics.get(n.metadata.name)?.mem ?? 0
        return (
          <ResourceCell
            text={showUsage ? `${formatBytes(used)} / ${formatBytes(alloc)}` : formatBytes(alloc)}
            pct={showUsage ? pct(used, alloc) : null}
          />
        )
      },
    },
    {
      key: 'pods',
      header: 'Pods',
      numeric: true,
      cell: (n) => Math.round(parseQuantity(n.status?.allocatable?.pods)),
    },
  ]
  return (
    <DataTable
      loading={loading}
      columns={columns}
      rows={nodes}
      rowKey={(n) => n.metadata.name}
      empty={<EmptyState compact title="No nodes" />}
    />
  )
}

function ResourceCell({ text, pct }: { text: string; pct: number | null }) {
  return (
    <div className="w-40 space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-xs tabular-nums text-content">{text}</span>
        {pct !== null ? (
          <span className="font-mono text-[11px] tabular-nums text-content-subtle">{pct}%</span>
        ) : null}
      </div>
      {pct !== null ? <UsageBar pct={pct} /> : null}
    </div>
  )
}

/* ─────────── top pods ─────────── */

function TopPods({
  rows,
  hasMetrics,
  loading,
}: {
  rows: PodConsumer[]
  hasMetrics: boolean
  loading: boolean
}) {
  const [tab, setTab] = useState<'cpu' | 'mem'>('cpu')
  const sorted = useMemo(
    () =>
      rows
        .slice()
        .sort((a, b) => (tab === 'cpu' ? b.cpu - a.cpu : b.mem - a.mem))
        .slice(0, 10),
    [rows, tab],
  )
  const max =
    tab === 'cpu'
      ? Math.max(...sorted.map((r) => r.cpu), 0.001)
      : Math.max(...sorted.map((r) => r.mem), 1)

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-content">Top pods</div>
            <div className="text-[11px] text-content-subtle">
              {hasMetrics ? 'live · metrics-server' : 'metrics-server unavailable'}
            </div>
          </div>
          <div className="inline-flex rounded-lg border border-edge-default bg-surface-sunken/60 p-0.5">
            {(['cpu', 'mem'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                  tab === t
                    ? 'bg-surface-raised text-content shadow-sm'
                    : 'text-content-muted hover:text-content',
                )}
              >
                {t === 'cpu' ? 'By CPU' : 'By memory'}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardBody className="p-0!">
        {!hasMetrics ? (
          <EmptyState
            compact
            title="No pod metrics"
            description="Install metrics-server to see live CPU / memory usage per pod."
          />
        ) : loading && sorted.length === 0 ? (
          <div className="flex items-center gap-2 p-5 text-sm text-content-muted">
            <Spinner size={14} /> Loading…
          </div>
        ) : sorted.length === 0 ? (
          <EmptyState compact title="No data" />
        ) : (
          <ul className="divide-y divide-edge-subtle">
            {sorted.map((p) => {
              const value = tab === 'cpu' ? p.cpu : p.mem
              const label = tab === 'cpu' ? formatCpu(p.cpu) : formatBytes(p.mem)
              const barPct = (value / max) * 100
              return (
                <li key={`${p.namespace}/${p.name}`} className="space-y-1 px-5 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium text-content">{p.name}</div>
                      <code className="font-mono text-[10px] text-content-subtle">{p.namespace}</code>
                    </div>
                    <span className="font-mono text-xs tabular-nums text-content">{label}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                    <div
                      className={cn(
                        'h-full rounded-full transition-[width] duration-500',
                        tab === 'cpu' ? 'bg-brand-500' : 'bg-violet-500',
                      )}
                      style={{ width: `${Math.max(2, Math.min(100, barPct))}%` }}
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

/* ─────────── shared atoms ─────────── */

function UsageBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct))
  // green < 70% · amber < 85% · rose ≥ 85%
  const color = clamped >= 85 ? '#f43f5e' : clamped >= 70 ? '#f59e0b' : '#10b981'
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${clamped}%`, backgroundColor: color }}
      />
    </div>
  )
}

function IconWarn() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-0.5 shrink-0"
      aria-hidden
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

/* ─────────── data shaping ─────────── */

interface NodeMetric {
  metadata: { name: string }
  usage?: { cpu?: string; memory?: string }
}

interface PodMetricItem {
  metadata: { name: string; namespace?: string }
  containers?: Array<{ usage?: { cpu?: string; memory?: string } }>
}

interface PodConsumer {
  name: string
  namespace: string
  cpu: number
  mem: number
}

/** Index node metrics by name → { cpu cores, mem bytes }. */
function indexNodeMetrics(metrics: NodeMetric[] | undefined): Map<string, { cpu: number; mem: number }> {
  const map = new Map<string, { cpu: number; mem: number }>()
  for (const m of metrics ?? []) {
    map.set(m.metadata.name, {
      cpu: parseQuantity(m.usage?.cpu),
      mem: parseQuantity(m.usage?.memory),
    })
  }
  return map
}

/** Sum each pod's container usage → { cpu cores, mem bytes }. */
function podConsumers(metrics: PodMetricItem[] | undefined): PodConsumer[] {
  const out: PodConsumer[] = []
  for (const p of metrics ?? []) {
    let cpu = 0
    let mem = 0
    for (const c of p.containers ?? []) {
      cpu += parseQuantity(c.usage?.cpu)
      mem += parseQuantity(c.usage?.memory)
    }
    out.push({ name: p.metadata.name, namespace: p.metadata.namespace ?? '—', cpu, mem })
  }
  return out
}

function pct(used: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.round((used / total) * 100))
}

function isNodeReady(node: {
  status?: { conditions?: Array<{ type: string; status: string }> }
}): boolean {
  return (node.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True')
}
