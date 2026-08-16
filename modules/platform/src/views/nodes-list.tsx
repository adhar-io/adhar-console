import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  StatusBadge,
  Tabs,
  type TabDef,
} from '@adhar-console/shell-ui'
import { kube } from '@adhar-console/api-clients/k8s'
import { useNodes } from '../data/hooks.ts'
import { GVRS } from '../data/gvr.ts'
import { useHasK8sPermission } from '../data/access.ts'
import { K8sRolePill } from '../components/role-gate.tsx'
import {
  age,
  findCondition,
  formatBytes,
  formatCpu,
  nodeRoles,
  parseQuantity,
} from '../data/format.ts'

type Sub = 'overview' | 'conditions' | 'addresses' | 'taints' | 'labels' | 'system'

const SUB_TABS: readonly TabDef<Sub>[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'conditions', label: 'Conditions' },
  { id: 'addresses', label: 'Addresses' },
  { id: 'taints', label: 'Taints' },
  { id: 'labels', label: 'Labels' },
  { id: 'system', label: 'System info' },
]

/* ── drain support ─────────────────────────────────────────────────────── */

interface DrainPod {
  metadata: {
    name: string
    namespace?: string
    annotations?: Record<string, string>
    ownerReferences?: Array<{ kind: string; name: string; controller?: boolean }>
  }
  status?: { phase?: string }
}

interface DrainSummary {
  evicted: number
  skipped: number
  failed: Array<{ pod: string; error: string }>
}

/**
 * True when a pod should be evicted during a drain — mirrors `kubectl drain`
 * defaults: skip completed pods, DaemonSet-managed pods (the DS controller
 * would immediately reschedule them) and static/mirror pods (kubelet-owned,
 * not evictable through the API).
 */
function isEvictable(p: DrainPod): boolean {
  const phase = p.status?.phase
  if (phase === 'Succeeded' || phase === 'Failed') return false
  if (p.metadata.annotations?.['kubernetes.io/config.mirror']) return false
  const owner =
    p.metadata.ownerReferences?.find((r) => r.controller) ?? p.metadata.ownerReferences?.[0]
  if (owner?.kind === 'DaemonSet') return false
  return true
}

/**
 * Evict a single pod via the apiserver's eviction subresource
 * (`POST /api/v1/namespaces/<ns>/pods/<pod>/eviction`) through the per-user
 * gateway — respects PodDisruptionBudgets, unlike a plain delete.
 */
async function evictPod(namespace: string, name: string): Promise<void> {
  const res = await fetch(
    `/api/k8s/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}/eviction`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        apiVersion: 'policy/v1',
        kind: 'Eviction',
        metadata: { name, namespace },
      }),
    },
  )
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const body = (await res.json()) as { message?: string }
      if (body?.message) message = body.message
    } catch {
      /* keep the HTTP status message */
    }
    throw new Error(message)
  }
}

export function NodesView() {
  const q = useNodes()
  const [selectedName, setSelectedName] = useState<string | null>(null)
  if (q.isError) {
    return <EmptyState title="Couldn't list nodes" description={(q.error as Error).message} />
  }
  const nodes = q.data ?? []
  return (
    <>
      <DataTable
        loading={q.isLoading}
        onRowClick={(n) => setSelectedName(n.metadata.name)}
        columns={[
          {
            key: 'name',
            header: 'Name',
            cell: (n) => (
              <div>
                <div className="font-medium text-content">{n.metadata.name}</div>
                <div className="text-xs text-content-muted">
                  {n.status.nodeInfo.osImage} · {n.status.nodeInfo.architecture}
                </div>
              </div>
            ),
          },
          {
            key: 'roles',
            header: 'Roles',
            cell: (n) => {
              const roles = nodeRoles(n.metadata.labels)
              if (roles.length === 0)
                return <span className="text-xs text-content-subtle">worker</span>
              return (
                <div className="flex flex-wrap gap-1">
                  {roles.map((r) => (
                    <span
                      key={r}
                      className="rounded-md bg-brand-50 dark:bg-brand-500/10 px-1.5 py-0.5 text-[11px] font-medium text-brand-700 dark:text-brand-300 ring-1 ring-inset ring-brand-200 dark:ring-brand-500/25"
                    >
                      {r}
                    </span>
                  ))}
                </div>
              )
            },
          },
          {
            key: 'status',
            header: 'Status',
            cell: (n) => {
              const ready = findCondition(n.status.conditions, 'Ready')
              const schedulable = !n.spec.unschedulable
              if (ready?.status !== 'True')
                return <StatusBadge kind="degraded">NotReady</StatusBadge>
              if (!schedulable)
                return <StatusBadge kind="paused">SchedulingDisabled</StatusBadge>
              return <StatusBadge kind="healthy">Ready</StatusBadge>
            },
          },
          {
            key: 'version',
            header: 'Version',
            cell: (n) => (
              <code className="text-xs text-content-muted">{n.status.nodeInfo.kubeletVersion}</code>
            ),
          },
          {
            key: 'cpu',
            header: 'CPU',
            numeric: true,
            cell: (n) => formatCpu(parseQuantity(n.status.allocatable.cpu)),
          },
          {
            key: 'mem',
            header: 'Memory',
            numeric: true,
            cell: (n) => formatBytes(parseQuantity(n.status.allocatable.memory)),
          },
          { key: 'pods', header: 'Pods', numeric: true, cell: (n) => n.status.allocatable.pods },
          {
            key: 'addrs',
            header: 'Address',
            cell: (n) => {
              const internal = n.status.addresses?.find((a) => a.type === 'InternalIP')
              return internal ? (
                <code className="text-xs text-content-muted">{internal.address}</code>
              ) : (
                <span className="text-content-subtle">—</span>
              )
            },
          },
          {
            key: 'taints',
            header: 'Taints',
            numeric: true,
            cell: (n) => n.spec.taints?.length ?? 0,
          },
          {
            key: 'images',
            header: 'Images',
            numeric: true,
            cell: (n) => n.status.images?.length ?? 0,
          },
          { key: 'age', header: 'Age', cell: (n) => age(n.metadata.creationTimestamp) },
        ]}
        rows={nodes}
        rowKey={(n) => n.metadata.name}
        empty={<EmptyState title="No nodes" />}
      />
      {selectedName ? (
        <NodeDrawer
          node={nodes.find((n) => n.metadata.name === selectedName)!}
          onClose={() => setSelectedName(null)}
        />
      ) : null}
    </>
  )
}

/* ── Node drawer ───────────────────────────────────────────────────────── */

function NodeDrawer({
  node,
  onClose,
}: {
  node: NonNullable<ReturnType<typeof useNodes>['data']>[number]
  onClose(): void
}) {
  const canCordon = useHasK8sPermission('nodes.cordon')
  const canEvict = useHasK8sPermission('pods.delete')
  const canDrain = canCordon && canEvict
  const qc = useQueryClient()
  // Local override reflects the new state immediately, before the node list
  // refetch catches up.
  const [override, setOverride] = useState<boolean | null>(null)
  const [confirmCordon, setConfirmCordon] = useState(false)
  const [confirmDrain, setConfirmDrain] = useState(false)
  const [drainTyped, setDrainTyped] = useState('')
  const [drainProgress, setDrainProgress] = useState<{ total: number; done: number } | null>(null)
  const [drainSummary, setDrainSummary] = useState<DrainSummary | null>(null)
  const unschedulable = override ?? Boolean(node.spec.unschedulable)

  const cordonMut = useMutation({
    mutationFn: async (next: boolean) => {
      await kube.patch(GVRS.nodes, undefined, node.metadata.name, { spec: { unschedulable: next } }, 'merge')
      return next
    },
    onSuccess: (next) => {
      setOverride(next)
      qc.invalidateQueries({ queryKey: ['k8s'] })
    },
  })

  // Blast-radius preview for the drain confirm — what's actually on the node.
  const drainPodsQ = useQuery<DrainPod[]>({
    queryKey: ['k8s', 'node-pods', node.metadata.name],
    enabled: confirmDrain,
    queryFn: async () =>
      (
        await kube.list<DrainPod>(GVRS.pods, {
          fieldSelector: `spec.nodeName=${node.metadata.name}`,
        })
      ).items,
  })

  const drainMut = useMutation({
    mutationFn: async (): Promise<DrainSummary> => {
      // 1. Cordon first so evicted pods can't land back on this node.
      await kube.patch(
        GVRS.nodes,
        undefined,
        node.metadata.name,
        { spec: { unschedulable: true } },
        'merge',
      )
      setOverride(true)
      // 2. Re-list the node's pods, then evict the evictable ones one by one
      //    through the eviction subresource (honours PodDisruptionBudgets).
      const pods = (
        await kube.list<DrainPod>(GVRS.pods, {
          fieldSelector: `spec.nodeName=${node.metadata.name}`,
        })
      ).items
      const targets = pods.filter(isEvictable)
      const skipped = pods.length - targets.length
      setDrainProgress({ total: targets.length, done: 0 })
      const failed: DrainSummary['failed'] = []
      let evicted = 0
      for (const p of targets) {
        try {
          await evictPod(p.metadata.namespace ?? 'default', p.metadata.name)
          evicted++
        } catch (e) {
          failed.push({
            pod: `${p.metadata.namespace ?? 'default'}/${p.metadata.name}`,
            error: e instanceof Error ? e.message : String(e),
          })
        }
        setDrainProgress((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev))
      }
      return { evicted, skipped, failed }
    },
    onSuccess: (summary) => {
      setDrainSummary(summary)
      qc.invalidateQueries({ queryKey: ['k8s'] })
    },
    onSettled: () => setDrainProgress(null),
  })

  const drainEvictable = (drainPodsQ.data ?? []).filter(isEvictable).length
  const drainSkipped = (drainPodsQ.data?.length ?? 0) - drainEvictable

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <aside className="relative flex h-full w-full max-w-2xl flex-col border-l border-edge-default bg-surface-raised shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default px-6 py-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wider text-content-subtle">
              Node
            </div>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-content">
              {node.metadata.name}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge kind={unschedulable ? 'paused' : 'healthy'}>
              {unschedulable ? 'Cordoned' : 'Schedulable'}
            </StatusBadge>
            {canCordon ? (
              unschedulable ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={cordonMut.isPending}
                  onClick={() => cordonMut.mutate(false)}
                  title="Allow new pods to schedule onto this node"
                >
                  {cordonMut.isPending ? 'Working…' : 'Uncordon'}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={cordonMut.isPending}
                  onClick={() => setConfirmCordon(true)}
                  title="Mark unschedulable — new pods won't be placed here"
                >
                  Cordon
                </Button>
              )
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-edge-default px-2 py-1 text-[11px] text-content-muted">
                Cordon <K8sRolePill perm="nodes.cordon" />
              </span>
            )}
            {canDrain ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={drainMut.isPending}
                onClick={() => {
                  setDrainSummary(null)
                  setConfirmDrain(true)
                }}
                title="Cordon the node, then evict every pod on it (DaemonSet and mirror pods are skipped)"
              >
                {drainMut.isPending ? 'Draining…' : 'Drain'}
              </Button>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-edge-default px-2 py-1 text-[11px] text-content-muted">
                Drain <K8sRolePill perm={canCordon ? 'pods.delete' : 'nodes.cordon'} />
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-content-muted hover:bg-surface-sunken hover:text-content"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </header>
        {confirmCordon ? (
          <div className="flex flex-wrap items-center gap-3 border-b border-amber-200 dark:border-amber-500/25 bg-amber-50/70 dark:bg-amber-500/10 px-6 py-3" role="alert">
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-semibold text-amber-900 dark:text-amber-300">Cordon this node?</div>
              <div className="text-[12px] text-content-muted">
                New pods won't schedule onto <code className="font-mono">{node.metadata.name}</code>.
                Existing pods keep running — this is reversible with Uncordon.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmCordon(false)} disabled={cordonMut.isPending}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={cordonMut.isPending}
                onClick={() => {
                  cordonMut.mutate(true)
                  setConfirmCordon(false)
                }}
              >
                {cordonMut.isPending ? 'Cordoning…' : 'Cordon node'}
              </Button>
            </div>
          </div>
        ) : null}
        {confirmDrain ? (
          <div
            className="border-b border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10 px-6 py-3"
            role="alertdialog"
            aria-label="Confirm drain"
          >
            <div className="text-sm font-semibold text-rose-900 dark:text-rose-300">
              Drain this node?
            </div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-content-muted">
              Draining cordons <code className="font-mono">{node.metadata.name}</code> and evicts
              every pod scheduled on it — DaemonSet-managed and mirror pods are skipped, and
              evictions honour PodDisruptionBudgets. Workloads without spare replicas elsewhere
              <span className="font-semibold text-rose-800 dark:text-rose-300"> will incur downtime</span>.
              {drainPodsQ.isLoading ? (
                <span> Counting pods…</span>
              ) : drainPodsQ.data ? (
                <span>
                  {' '}
                  Blast radius: <span className="font-semibold text-content">{drainEvictable}</span>{' '}
                  pod{drainEvictable === 1 ? '' : 's'} will be evicted
                  {drainSkipped > 0 ? `, ${drainSkipped} skipped (DaemonSet/mirror/completed)` : ''}.
                </span>
              ) : null}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                value={drainTyped}
                onChange={(e) => setDrainTyped(e.target.value)}
                placeholder={`Type "${node.metadata.name}" to confirm`}
                className="h-8 w-full max-w-xs rounded-md border border-edge-default bg-surface-raised px-2 font-mono text-xs text-content outline-none placeholder:text-content-subtle focus:ring-2 focus:ring-rose-500/30"
                aria-label="Type the node name to confirm drain"
              />
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setConfirmDrain(false)
                    setDrainTyped('')
                  }}
                  disabled={drainMut.isPending}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={drainTyped !== node.metadata.name || drainMut.isPending}
                  onClick={() => {
                    setConfirmDrain(false)
                    setDrainTyped('')
                    drainMut.mutate()
                  }}
                >
                  Drain node
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        {drainProgress ? (
          <div className="border-b border-edge-default bg-surface-sunken px-6 py-3" role="status">
            <div className="flex items-center justify-between text-[12px] text-content-muted">
              <span>
                Draining — evicting pod {Math.min(drainProgress.done + 1, drainProgress.total)} of{' '}
                {drainProgress.total}…
              </span>
              <span className="font-mono tabular-nums">
                {drainProgress.done}/{drainProgress.total}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-raised">
              <div
                className="h-full rounded-full bg-rose-500 transition-all"
                style={{
                  width: `${drainProgress.total ? Math.round((drainProgress.done / drainProgress.total) * 100) : 100}%`,
                }}
              />
            </div>
          </div>
        ) : null}
        {drainMut.isError ? (
          <div className="border-b border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10 px-6 py-2 text-[12px] text-rose-800 dark:text-rose-300" role="alert">
            Drain failed: {(drainMut.error as Error).message}
          </div>
        ) : null}
        {drainSummary ? (
          <div
            className="flex flex-wrap items-start gap-3 border-b border-edge-default bg-surface-sunken px-6 py-3"
            role="status"
          >
            <div className="min-w-0 flex-1 text-[12px] text-content-muted">
              <div className="font-semibold text-content">Drain complete</div>
              <div>
                {drainSummary.evicted} evicted · {drainSummary.skipped} skipped
                {drainSummary.failed.length ? ` · ${drainSummary.failed.length} failed` : ''}
              </div>
              {drainSummary.failed.length ? (
                <ul className="mt-1 space-y-0.5">
                  {drainSummary.failed.map((f) => (
                    <li key={f.pod} className="text-rose-700 dark:text-rose-300">
                      <code className="font-mono">{f.pod}</code> — {f.error}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <Button variant="ghost" size="sm" onClick={() => setDrainSummary(null)}>
              Dismiss
            </Button>
          </div>
        ) : null}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <Tabs<Sub> tabs={SUB_TABS} defaultValue="overview" ariaLabel="Node sections">
            {(active) => (
              <>
                {active === 'overview' && <NodeOverview node={node} />}
                {active === 'conditions' && <NodeConditions node={node} />}
                {active === 'addresses' && <NodeAddresses node={node} />}
                {active === 'taints' && <NodeTaints node={node} />}
                {active === 'labels' && <NodeLabels node={node} />}
                {active === 'system' && <NodeSystem node={node} />}
              </>
            )}
          </Tabs>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

type N = NonNullable<ReturnType<typeof useNodes>['data']>[number]

function NodeOverview({ node }: { node: N }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <div className="text-sm font-semibold text-content">Capacity</div>
        </CardHeader>
        <CardBody className="space-y-2 text-sm">
          <MetricRow
            label="CPU"
            allocatable={formatCpu(parseQuantity(node.status.allocatable.cpu))}
            capacity={formatCpu(parseQuantity(node.status.capacity.cpu))}
          />
          <MetricRow
            label="Memory"
            allocatable={formatBytes(parseQuantity(node.status.allocatable.memory))}
            capacity={formatBytes(parseQuantity(node.status.capacity.memory))}
          />
          <MetricRow
            label="Pods"
            allocatable={node.status.allocatable.pods}
            capacity={node.status.capacity.pods}
          />
          <MetricRow
            label="Storage"
            allocatable={formatBytes(parseQuantity(node.status.allocatable['ephemeral-storage']))}
            capacity={formatBytes(parseQuantity(node.status.capacity['ephemeral-storage']))}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="text-sm font-semibold text-content">Identity</div>
        </CardHeader>
        <CardBody className="space-y-1.5 text-sm">
          <KVRow label="Provider ID" value={<Mono short>{node.spec.providerID ?? '—'}</Mono>} />
          <KVRow label="Pod CIDR" value={<Mono>{node.spec.podCIDR ?? '—'}</Mono>} />
          <KVRow label="Kubelet port" value={node.status.daemonEndpoints?.kubeletEndpoint?.Port ?? '—'} />
          <KVRow label="Roles">
            <div className="flex flex-wrap justify-end gap-1">
              {nodeRoles(node.metadata.labels).map((r) => (
                <span key={r} className="rounded bg-surface-sunken px-1.5 py-0.5 text-[11px]">
                  {r}
                </span>
              ))}
            </div>
          </KVRow>
          <KVRow label="Scheduling" value={node.spec.unschedulable ? 'Disabled' : 'Enabled'} />
          <KVRow label="Age" value={age(node.metadata.creationTimestamp)} />
        </CardBody>
      </Card>
    </div>
  )
}

function NodeConditions({ node }: { node: N }) {
  const conditions = node.status.conditions ?? []
  if (!conditions.length) return <EmptyState compact title="No conditions reported" />
  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised">
      <div className="divide-y divide-edge-subtle">
        {conditions.map((c) => (
          <div key={c.type} className="flex items-start gap-4 px-4 py-3">
            <StatusBadge
              kind={
                c.status === 'True' && c.type === 'Ready'
                  ? 'healthy'
                  : c.status === 'True'
                    ? 'degraded'
                    : 'unknown'
              }
            >
              {c.type}
            </StatusBadge>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-content">{c.reason ?? c.status}</div>
              {c.message ? (
                <div className="mt-0.5 text-xs text-content-muted">{c.message}</div>
              ) : null}
              {c.lastTransitionTime ? (
                <div className="mt-0.5 text-[11px] text-content-subtle">
                  transitioned {age(c.lastTransitionTime)} ago
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function NodeAddresses({ node }: { node: N }) {
  const rows = node.status.addresses ?? []
  if (!rows.length) return <EmptyState compact title="No addresses" />
  return (
    <div className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
      <table className="w-full text-sm">
        <tbody className="divide-y divide-edge-subtle">
          {rows.map((a, i) => (
            <tr key={i}>
              <td className="w-40 px-4 py-2 text-content-muted">{a.type}</td>
              <td className="px-4 py-2 font-mono text-xs">{a.address}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface NodeTaint {
  key: string
  value?: string
  effect: string
  timeAdded?: string
}

const TAINT_EFFECTS = ['NoSchedule', 'PreferNoSchedule', 'NoExecute'] as const

function NodeTaints({ node }: { node: N }) {
  const canEdit = useHasK8sPermission('nodes.cordon')
  const qc = useQueryClient()
  // Local override reflects the patched taint set immediately, before the
  // node list refetch lands.
  const [override, setOverride] = useState<NodeTaint[] | null>(null)
  const rows = override ?? ((node.spec.taints ?? []) as NodeTaint[])

  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [newEffect, setNewEffect] = useState<(typeof TAINT_EFFECTS)[number]>('NoSchedule')

  const taintMut = useMutation({
    mutationFn: async (next: NodeTaint[]) => {
      // JSON-merge patch replaces the whole array — exactly what we want.
      await kube.patch(GVRS.nodes, undefined, node.metadata.name, { spec: { taints: next } }, 'merge')
      return next
    },
    onSuccess: (next) => {
      setOverride(next)
      qc.invalidateQueries({ queryKey: ['k8s'] })
    },
  })

  const addTaint = () => {
    const key = newKey.trim()
    if (!key) return
    const next = [
      ...rows.filter((t) => !(t.key === key && t.effect === newEffect)),
      { key, ...(newValue.trim() ? { value: newValue.trim() } : {}), effect: newEffect },
    ]
    taintMut.mutate(next)
    setNewKey('')
    setNewValue('')
  }

  return (
    <div className="space-y-3">
      {rows.length ? (
        <div className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge-default bg-surface-sunken text-left">
                <th className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-content-muted">
                  Key
                </th>
                <th className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-content-muted">
                  Value
                </th>
                <th className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-content-muted">
                  Effect
                </th>
                {canEdit ? <th className="w-16 px-4 py-2" /> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-edge-subtle">
              {rows.map((t, i) => (
                <tr key={`${t.key}:${t.effect}:${i}`}>
                  <td className="px-4 py-2 font-mono text-xs">{t.key}</td>
                  <td className="px-4 py-2 font-mono text-xs">{t.value ?? ''}</td>
                  <td className="px-4 py-2">
                    <StatusBadge kind={t.effect === 'NoExecute' ? 'failed' : 'paused'}>
                      {t.effect}
                    </StatusBadge>
                  </td>
                  {canEdit ? (
                    <td className="px-4 py-2 text-right">
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={taintMut.isPending}
                        onClick={() =>
                          taintMut.mutate(
                            rows.filter(
                              (r) => !(r.key === t.key && r.effect === t.effect && r.value === t.value),
                            ),
                          )
                        }
                        title={`Remove taint ${t.key}:${t.effect}`}
                      >
                        Remove
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          compact
          title="No taints"
          description="Any pod tolerating default schedule-ability can land here."
        />
      )}

      {canEdit ? (
        <div className="rounded-xl border border-edge-default bg-surface-raised p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
            Add taint
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="key"
              className="h-8 w-44 rounded-md border border-edge-default bg-surface-raised px-2 font-mono text-xs text-content outline-none placeholder:text-content-subtle focus:ring-2 focus:ring-brand-500/30"
              aria-label="Taint key"
            />
            <input
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="value (optional)"
              className="h-8 w-40 rounded-md border border-edge-default bg-surface-raised px-2 font-mono text-xs text-content outline-none placeholder:text-content-subtle focus:ring-2 focus:ring-brand-500/30"
              aria-label="Taint value"
            />
            <select
              value={newEffect}
              onChange={(e) => setNewEffect(e.target.value as (typeof TAINT_EFFECTS)[number])}
              className="h-8 rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content outline-none focus:ring-2 focus:ring-brand-500/30"
              aria-label="Taint effect"
            >
              {TAINT_EFFECTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
            <Button size="sm" disabled={!newKey.trim() || taintMut.isPending} onClick={addTaint}>
              {taintMut.isPending ? 'Applying…' : 'Add taint'}
            </Button>
          </div>
          {newEffect === 'NoExecute' ? (
            <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
              NoExecute evicts running pods that don't tolerate the taint — apply with care.
            </p>
          ) : null}
          {taintMut.isError ? (
            <p className="mt-2 text-[11px] text-rose-700 dark:text-rose-300">
              Error: {(taintMut.error as Error).message}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-[11px] text-content-muted">
          Editing taints requires <K8sRolePill perm="nodes.cordon" />
        </p>
      )}
    </div>
  )
}

function NodeLabels({ node }: { node: N }) {
  const canEdit = useHasK8sPermission('nodes.cordon')
  const qc = useQueryClient()
  const [override, setOverride] = useState<Record<string, string> | null>(null)
  const labels = override ?? node.metadata.labels ?? {}
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))

  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')

  const labelMut = useMutation({
    // Merge-patch semantics: `null` deletes a key, a string sets it.
    mutationFn: async (change: Record<string, string | null>) => {
      await kube.patch(
        GVRS.nodes,
        undefined,
        node.metadata.name,
        { metadata: { labels: change } },
        'merge',
      )
      return change
    },
    onSuccess: (change) => {
      const next = { ...labels }
      for (const [k, v] of Object.entries(change)) {
        if (v === null) delete next[k]
        else next[k] = v
      }
      setOverride(next)
      qc.invalidateQueries({ queryKey: ['k8s'] })
    },
  })

  return (
    <div className="space-y-3">
      {entries.length ? (
        <div className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-edge-subtle">
              {entries.map(([k, v]) => (
                <tr key={k}>
                  <td className="px-4 py-2 font-mono text-xs text-content-muted">{k}</td>
                  <td className="px-4 py-2 font-mono text-xs">{v}</td>
                  {canEdit ? (
                    <td className="w-16 px-4 py-2 text-right">
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={labelMut.isPending}
                        onClick={() => labelMut.mutate({ [k]: null })}
                        title={`Remove label ${k}`}
                      >
                        Remove
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState compact title="No labels" />
      )}

      {canEdit ? (
        <div className="rounded-xl border border-edge-default bg-surface-raised p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
            Add / update label
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="key"
              className="h-8 w-52 rounded-md border border-edge-default bg-surface-raised px-2 font-mono text-xs text-content outline-none placeholder:text-content-subtle focus:ring-2 focus:ring-brand-500/30"
              aria-label="Label key"
            />
            <input
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="value"
              className="h-8 w-44 rounded-md border border-edge-default bg-surface-raised px-2 font-mono text-xs text-content outline-none placeholder:text-content-subtle focus:ring-2 focus:ring-brand-500/30"
              aria-label="Label value"
            />
            <Button
              size="sm"
              disabled={!newKey.trim() || labelMut.isPending}
              onClick={() => {
                labelMut.mutate({ [newKey.trim()]: newValue.trim() })
                setNewKey('')
                setNewValue('')
              }}
            >
              {labelMut.isPending ? 'Applying…' : 'Apply'}
            </Button>
          </div>
          {labelMut.isError ? (
            <p className="mt-2 text-[11px] text-rose-700 dark:text-rose-300">
              Error: {(labelMut.error as Error).message}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-[11px] text-content-muted">
          Editing labels requires <K8sRolePill perm="nodes.cordon" />
        </p>
      )}
    </div>
  )
}

function NodeSystem({ node }: { node: N }) {
  const info = node.status.nodeInfo
  const imageCount = node.status.images?.length ?? 0
  const cachedBytes = (node.status.images ?? []).reduce((a, img) => a + (img.sizeBytes ?? 0), 0)
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="text-sm font-semibold text-content">Node info</div>
        </CardHeader>
        <CardBody className="space-y-1.5 text-sm">
          <KVRow label="Kubelet" value={<Mono>{info.kubeletVersion}</Mono>} />
          <KVRow label="Kube-proxy" value={<Mono>{info.kubeProxyVersion ?? '—'}</Mono>} />
          <KVRow label="Container runtime" value={<Mono>{info.containerRuntimeVersion}</Mono>} />
          <KVRow label="OS image" value={info.osImage} />
          <KVRow label="Operating system" value={info.operatingSystem ?? '—'} />
          <KVRow label="Architecture" value={info.architecture} />
          <KVRow label="Machine ID" value={<Mono short>{info.machineID ?? '—'}</Mono>} />
          <KVRow label="Boot ID" value={<Mono short>{info.bootID ?? '—'}</Mono>} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader>
          <div className="text-sm font-semibold text-content">Cached images</div>
        </CardHeader>
        <CardBody className="space-y-2 text-sm">
          <KVRow label="Count" value={imageCount} />
          <KVRow label="Total size" value={formatBytes(cachedBytes)} />
        </CardBody>
      </Card>
    </div>
  )
}

function MetricRow({
  label,
  allocatable,
  capacity,
}: {
  label: string
  allocatable: React.ReactNode
  capacity: React.ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-content-muted">{label}</span>
      <div className="text-right font-mono tabular-nums text-xs">
        <span className="text-content">{allocatable}</span>
        <span className="text-content-subtle"> / {capacity}</span>
      </div>
    </div>
  )
}

function KVRow({
  label,
  value,
  children,
}: {
  label: string
  value?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-content-muted">{label}</span>
      <span className="min-w-0 text-right text-content">{children ?? value}</span>
    </div>
  )
}

function Mono({ children, short = false }: { children: React.ReactNode; short?: boolean }) {
  const text = String(children)
  return (
    <code title={short ? text : undefined} className="font-mono text-xs">
      {short && text.length > 24 ? `${text.slice(0, 10)}…${text.slice(-8)}` : text}
    </code>
  )
}
