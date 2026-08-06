import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
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
import { isDevK8s } from '../data/client.ts'
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

type Sub = 'overview' | 'conditions' | 'addresses' | 'taints' | 'system'

const SUB_TABS: readonly TabDef<Sub>[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'conditions', label: 'Conditions' },
  { id: 'addresses', label: 'Addresses' },
  { id: 'taints', label: 'Taints' },
  { id: 'system', label: 'System info' },
]

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
                      className="rounded-md bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-700 ring-1 ring-inset ring-brand-200"
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
  const qc = useQueryClient()
  // Local override reflects the new state immediately (and is the only feedback
  // in dev, where the stub node list won't actually change).
  const [override, setOverride] = useState<boolean | null>(null)
  const [confirmCordon, setConfirmCordon] = useState(false)
  const unschedulable = override ?? Boolean(node.spec.unschedulable)

  const cordonMut = useMutation({
    mutationFn: async (next: boolean) => {
      if (!isDevK8s) {
        await kube.patch(GVRS.nodes, undefined, node.metadata.name, { spec: { unschedulable: next } }, 'merge')
      }
      return next
    },
    onSuccess: (next) => {
      setOverride(next)
      qc.invalidateQueries({ queryKey: ['k8s'] })
    },
  })

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <aside className="relative flex h-full w-full max-w-2xl flex-col border-l border-edge-default bg-white shadow-2xl">
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
          <div className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50/70 px-6 py-3" role="alert">
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-semibold text-amber-900">Cordon this node?</div>
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
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <Tabs<Sub> tabs={SUB_TABS} defaultValue="overview" ariaLabel="Node sections">
            {(active) => (
              <>
                {active === 'overview' && <NodeOverview node={node} />}
                {active === 'conditions' && <NodeConditions node={node} />}
                {active === 'addresses' && <NodeAddresses node={node} />}
                {active === 'taints' && <NodeTaints node={node} />}
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
    <div className="rounded-xl border border-edge-default bg-white">
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
    <div className="overflow-hidden rounded-xl border border-edge-default bg-white">
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

function NodeTaints({ node }: { node: N }) {
  const rows = node.spec.taints ?? []
  if (!rows.length)
    return (
      <EmptyState
        compact
        title="No taints"
        description="Any pod tolerating default schedule-ability can land here."
      />
    )
  return (
    <div className="overflow-hidden rounded-xl border border-edge-default bg-white">
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
          </tr>
        </thead>
        <tbody className="divide-y divide-edge-subtle">
          {rows.map((t, i) => (
            <tr key={i}>
              <td className="px-4 py-2 font-mono text-xs">{t.key}</td>
              <td className="px-4 py-2 font-mono text-xs">{t.value ?? ''}</td>
              <td className="px-4 py-2">
                <StatusBadge kind={t.effect === 'NoExecute' ? 'failed' : 'paused'}>
                  {t.effect}
                </StatusBadge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
