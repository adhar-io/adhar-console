import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  canResource,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  StatusBadge,
  useAccessReview,
  useCan,
  useOverlayDismiss,
  DrawerWidenButton,
  useDrawerWidth,
  useToast,
} from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { kube } from '@adhar/api-clients/k8s'
import type { KubeObject } from '@adhar/api-clients/k8s'
import { GVRS } from '../data/gvr.ts'
import { useDeployments, useHorizontalPodAutoscalers, useStatefulSets } from '../data/hooks.ts'
import { AccessDenied } from '../components/role-gate.tsx'
import { age } from '../data/format.ts'
import { ListShell, matchesSearch } from './list-shell.tsx'

/**
 * HorizontalPodAutoscaler dashboard — live (watch-backed) `autoscaling/v2`
 * list with real current-vs-target metric readings from `status.currentMetrics`,
 * scaling conditions straight from the controller, and RBAC-gated
 * create / edit-bounds / delete (Kubernetes RBAC as the signed-in user; actions
 * the user may not take are not rendered). Metric values are only ever rendered from
 * what the apiserver reports — a metric with no reading shows "—", never a
 * made-up number.
 */

/* ── autoscaling/v2 shapes (cast from the generic gateway objects) ─────── */

interface MetricTarget {
  type?: string
  averageUtilization?: number
  averageValue?: string
  value?: string
}

interface MetricIdentifier {
  name?: string
}

interface MetricSpec {
  type?: string
  resource?: { name?: string; target?: MetricTarget }
  containerResource?: { name?: string; container?: string; target?: MetricTarget }
  pods?: { metric?: MetricIdentifier; target?: MetricTarget }
  object?: { metric?: MetricIdentifier; describedObject?: { kind?: string; name?: string }; target?: MetricTarget }
  external?: { metric?: MetricIdentifier; target?: MetricTarget }
}

interface MetricStatus {
  type?: string
  resource?: { name?: string; current?: MetricTarget }
  containerResource?: { name?: string; container?: string; current?: MetricTarget }
  pods?: { metric?: MetricIdentifier; current?: MetricTarget }
  object?: { metric?: MetricIdentifier; current?: MetricTarget }
  external?: { metric?: MetricIdentifier; current?: MetricTarget }
}

interface HpaCondition {
  type: string
  status: string
  reason?: string
  message?: string
  lastTransitionTime?: string
}

interface Hpa extends KubeObject {
  spec?: {
    scaleTargetRef?: { apiVersion?: string; kind?: string; name?: string }
    minReplicas?: number
    maxReplicas?: number
    metrics?: MetricSpec[]
  }
  status?: {
    currentReplicas?: number
    desiredReplicas?: number
    lastScaleTime?: string
    currentMetrics?: MetricStatus[]
    conditions?: HpaCondition[]
  }
}

/* ── metric formatting (from live data only) ───────────────────────────── */

function metricName(m: MetricSpec | MetricStatus): string {
  switch (m.type) {
    case 'Resource':
      return m.resource?.name ?? '—'
    case 'ContainerResource':
      return `${m.containerResource?.name ?? '—'} (${m.containerResource?.container ?? '?'})`
    case 'Pods':
      return m.pods?.metric?.name ?? '—'
    case 'Object':
      return m.object?.metric?.name ?? '—'
    case 'External':
      return m.external?.metric?.name ?? '—'
    default:
      return m.type ?? '—'
  }
}

function targetOf(m: MetricSpec): MetricTarget | undefined {
  return (
    m.resource?.target ??
    m.containerResource?.target ??
    m.pods?.target ??
    m.object?.target ??
    m.external?.target
  )
}

function currentOf(m: MetricStatus): MetricTarget | undefined {
  return (
    m.resource?.current ??
    m.containerResource?.current ??
    m.pods?.current ??
    m.object?.current ??
    m.external?.current
  )
}

function formatMetricValue(v: MetricTarget | undefined): string {
  if (!v) return '—'
  if (typeof v.averageUtilization === 'number') return `${v.averageUtilization}%`
  if (v.averageValue) return v.averageValue
  if (v.value) return v.value
  return '—'
}

/** Match a spec metric to its live reading by type + metric identity. */
function currentFor(hpa: Hpa, spec: MetricSpec): MetricTarget | undefined {
  const match = (hpa.status?.currentMetrics ?? []).find(
    (s) => s.type === spec.type && metricName(s) === metricName(spec),
  )
  return match ? currentOf(match) : undefined
}

function condition(hpa: Hpa, type: string): HpaCondition | undefined {
  return hpa.status?.conditions?.find((c) => c.type === type)
}

/* ── list view ─────────────────────────────────────────────────────────── */

/**
 * Create is a server-side apply of a new HPA, which the apiserver authorizes as
 * `patch` AND `create` on horizontalpodautoscalers in the target namespace.
 * Without a namespace the question is cluster-wide (all namespaces).
 */
function createChecks(namespace?: string) {
  return [
    canResource(GVRS.hpa, 'create', { namespace }),
    canResource(GVRS.hpa, 'patch', { namespace }),
  ]
}

export function AutoscalingView({ namespace }: { namespace?: string }) {
  const live = useHorizontalPodAutoscalers(namespace)
  const canCreate = useCan(createChecks(namespace))
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const all = live.data as unknown as Hpa[]
  const rows = useMemo(
    () =>
      all.filter(
        (h) =>
          matchesSearch(h.metadata.name, search) ||
          matchesSearch(h.metadata.namespace, search) ||
          matchesSearch(h.spec?.scaleTargetRef?.name, search),
      ),
    [all, search],
  )

  if (live.isError) {
    return (
      <EmptyState title="Couldn't list HorizontalPodAutoscalers" description={live.error?.message} />
    )
  }

  const selectedHpa = selected ? all.find((h) => `${h.metadata.namespace}/${h.metadata.name}` === selected) : undefined

  return (
    <>
      <ListShell
        title="HorizontalPodAutoscalers"
        total={all.length}
        visible={rows.length}
        loading={live.isLoading}
        onRefresh={() => live.refetch()}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search by name or target…"
        actions={
          canCreate ? (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              Create HPA
            </Button>
          ) : null
        }
      >
        <DataTable
          loading={live.isLoading}
          onRowClick={(h) => setSelected(`${h.metadata.namespace}/${h.metadata.name}`)}
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (h) => (
                <div>
                  <div className="font-medium text-content">{h.metadata.name}</div>
                  <div className="text-xs text-content-muted">{h.metadata.namespace}</div>
                </div>
              ),
            },
            {
              key: 'target',
              header: 'Target',
              cell: (h) => (
                <code className="text-xs text-content-muted">
                  {h.spec?.scaleTargetRef?.kind ?? '?'}/{h.spec?.scaleTargetRef?.name ?? '?'}
                </code>
              ),
            },
            {
              key: 'metrics',
              header: 'Metrics (current / target)',
              cell: (h) => {
                const metrics = h.spec?.metrics ?? []
                if (!metrics.length) return <span className="text-content-subtle">None</span>
                return (
                  <div className="space-y-0.5">
                    {metrics.slice(0, 2).map((m, i) => (
                      <div key={i} className="font-mono text-[11px] tabular-nums">
                        <span className="text-content-subtle">{metricName(m)} </span>
                        <span className="text-content">{formatMetricValue(currentFor(h, m))}</span>
                        <span className="text-content-subtle"> / {formatMetricValue(targetOf(m))}</span>
                      </div>
                    ))}
                    {metrics.length > 2 ? (
                      <div className="text-[10px] text-content-subtle">+{metrics.length - 2} more</div>
                    ) : null}
                  </div>
                )
              },
            },
            {
              key: 'minmax',
              header: 'Min / Max',
              numeric: true,
              cell: (h) => `${h.spec?.minReplicas ?? 1} / ${h.spec?.maxReplicas ?? '—'}`,
            },
            {
              key: 'replicas',
              header: 'Replicas',
              numeric: true,
              cell: (h) => {
                const cur = h.status?.currentReplicas
                const want = h.status?.desiredReplicas
                if (cur === undefined) return '—'
                return want !== undefined && want !== cur ? `${cur} → ${want}` : `${cur}`
              },
            },
            {
              key: 'lastScale',
              header: 'Last scale',
              cell: (h) =>
                h.status?.lastScaleTime ? (
                  <span title={h.status.lastScaleTime}>{age(h.status.lastScaleTime)} ago</span>
                ) : (
                  <span className="text-content-subtle">Never</span>
                ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (h) => <HpaStatusBadge hpa={h} />,
            },
            { key: 'age', header: 'Age', cell: (h) => age(h.metadata.creationTimestamp) },
          ]}
          rows={rows}
          rowKey={(h) => `${h.metadata.namespace}/${h.metadata.name}`}
          empty={
            <EmptyState
              title="No HorizontalPodAutoscalers"
              description={canCreate
                ? 'Create one to scale a Deployment or StatefulSet on live metrics.'
                : 'None in scope. Ask a platform admin to add one for a Deployment or StatefulSet that should scale on live metrics.'}
            />
          }
        />
      </ListShell>

      {selectedHpa ? <HpaDrawer hpa={selectedHpa} onClose={() => setSelected(null)} /> : null}
      {creating && canCreate ? <CreateHpaModal namespace={namespace} onClose={() => setCreating(false)} /> : null}
    </>
  )
}

function HpaStatusBadge({ hpa }: { hpa: Hpa }) {
  const able = condition(hpa, 'AbleToScale')
  const active = condition(hpa, 'ScalingActive')
  const limited = condition(hpa, 'ScalingLimited')
  if (!hpa.status?.conditions?.length) return <StatusBadge kind="unknown">Unknown</StatusBadge>
  if (able?.status === 'False') return <StatusBadge kind="failed">Unable</StatusBadge>
  if (active?.status === 'False') return <StatusBadge kind="degraded">Inactive</StatusBadge>
  if (limited?.status === 'True') return <StatusBadge kind="paused">Limited</StatusBadge>
  return <StatusBadge kind="healthy">Active</StatusBadge>
}

/* ── drawer ────────────────────────────────────────────────────────────── */

function HpaDrawer({ hpa, onClose }: { hpa: Hpa; onClose(): void }) {
  const width = useDrawerWidth('platform.hpa', { base: 'max-w-2xl' })
  const target = { namespace: hpa.metadata.namespace, name: hpa.metadata.name }
  // Edit bounds is a merge-PATCH; Delete is a DELETE — of this exact HPA.
  const canEdit = useCan(canResource(GVRS.hpa, 'patch', target))
  const canDelete = useCan(canResource(GVRS.hpa, 'delete', target))
  const [editing, setEditing] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const qc = useQueryClient()
  const toast = useToast()

  const deleteMut = useMutation({
    mutationFn: () => kube.delete(GVRS.hpa, hpa.metadata.namespace, hpa.metadata.name),
    onSuccess: () => {
      toast.success(`Deleted HPA ${hpa.metadata.name}`)
      qc.invalidateQueries({ queryKey: ['k8s'] })
      onClose()
    },
    onError: (e) => toast.error('Could not delete HPA', { description: (e as Error).message }),
  })

  const metrics = hpa.spec?.metrics ?? []
  const conditions = hpa.status?.conditions ?? []

  useOverlayDismiss(true, onClose)

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <aside className={cn('relative flex h-full w-full flex-col border-l border-edge-default bg-surface-canvas shadow-2xl', width.className)}>
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wider text-content-subtle">
              HorizontalPodAutoscaler
            </div>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-content">{hpa.metadata.name}</h2>
            <div className="mt-0.5 text-xs text-content-muted">
              {hpa.metadata.namespace} · targets{' '}
              <code className="font-mono">
                {hpa.spec?.scaleTargetRef?.kind}/{hpa.spec?.scaleTargetRef?.name}
              </code>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <HpaStatusBadge hpa={hpa} />
            {canEdit ? (
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                Edit bounds
              </Button>
            ) : null}
            {canDelete ? (
              <Button size="sm" variant="danger" onClick={() => setConfirmingDelete(true)}>
                Delete
              </Button>
            ) : null}
            <DrawerWidenButton wide={width.wide} onToggle={width.toggle} />
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-content-muted hover:bg-surface-sunken hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/40"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </header>

        {confirmingDelete && canDelete ? (
          <div
            className="flex flex-wrap items-center gap-3 border-b border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10 px-6 py-3"
            role="alert"
          >
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-semibold text-rose-900 dark:text-rose-300">Delete this HPA?</div>
              <div className="text-[12px] text-content-muted">
                The workload keeps its current replica count but stops autoscaling.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)} disabled={deleteMut.isPending}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" disabled={deleteMut.isPending} onClick={() => deleteMut.mutate()}>
                {deleteMut.isPending ? 'Deleting…' : 'Delete HPA'}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Replicas</div>
            </CardHeader>
            <CardBody>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <ReplicaTile label="Min" value={hpa.spec?.minReplicas ?? 1} />
                <ReplicaTile label="Max" value={hpa.spec?.maxReplicas ?? '—'} />
                <ReplicaTile label="Current" value={hpa.status?.currentReplicas ?? '—'} />
                <ReplicaTile label="Desired" value={hpa.status?.desiredReplicas ?? '—'} />
              </div>
              <div className="mt-3 text-xs text-content-muted">
                Last scale:{' '}
                {hpa.status?.lastScaleTime ? (
                  <span title={hpa.status.lastScaleTime}>{age(hpa.status.lastScaleTime)} ago</span>
                ) : (
                  'never'
                )}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Metrics</div>
            </CardHeader>
            <CardBody>
              {metrics.length === 0 ? (
                <EmptyState compact title="No metrics configured" />
              ) : (
                <div className="overflow-x-auto rounded-lg border border-edge-default">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-edge-default bg-surface-sunken text-left">
                        {['Type', 'Metric', 'Current', 'Target'].map((h) => (
                          <th
                            key={h}
                            className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-content-muted"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-edge-subtle">
                      {metrics.map((m, i) => (
                        <tr key={i}>
                          <td className="px-3 py-1.5 text-content-muted">{m.type ?? '—'}</td>
                          <td className="px-3 py-1.5 font-mono text-xs">{metricName(m)}</td>
                          <td className="px-3 py-1.5 font-mono text-xs tabular-nums">
                            {formatMetricValue(currentFor(hpa, m))}
                          </td>
                          <td className="px-3 py-1.5 font-mono text-xs tabular-nums">
                            {formatMetricValue(targetOf(m))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-2 text-[11px] text-content-subtle">
                Current readings come from the autoscaler's own <code>status.currentMetrics</code>; "—"
                means the controller has no reading yet (e.g. metrics-server missing).
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Scaling activity</div>
            </CardHeader>
            <CardBody>
              {conditions.length === 0 ? (
                <EmptyState
                  compact
                  title="No conditions reported yet"
                  description="The controller hasn't evaluated this HPA — check back shortly."
                />
              ) : (
                <div className="divide-y divide-edge-subtle">
                  {conditions.map((c) => (
                    <div key={c.type} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                      <StatusBadge
                        kind={
                          c.type === 'ScalingLimited'
                            ? c.status === 'True'
                              ? 'paused'
                              : 'healthy'
                            : c.status === 'True'
                              ? 'healthy'
                              : 'degraded'
                        }
                      >
                        {c.type}
                      </StatusBadge>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-content">{c.reason ?? c.status}</div>
                        {c.message ? <div className="mt-0.5 text-xs text-content-muted">{c.message}</div> : null}
                        {c.lastTransitionTime ? (
                          <div className="mt-0.5 text-[11px] text-content-subtle">
                            transitioned {age(c.lastTransitionTime)} ago
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      </aside>

      {editing && canEdit ? <EditBoundsModal hpa={hpa} onClose={() => setEditing(false)} /> : null}
    </div>,
    document.body,
  )
}

function ReplicaTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-edge-default bg-surface-sunken/50 px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-content-subtle">{label}</div>
      <div className="mt-0.5 font-mono text-lg tabular-nums text-content">{value}</div>
    </div>
  )
}

/* ── edit min/max (PATCH) ──────────────────────────────────────────────── */

function EditBoundsModal({ hpa, onClose }: { hpa: Hpa; onClose(): void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [min, setMin] = useState(String(hpa.spec?.minReplicas ?? 1))
  const [max, setMax] = useState(String(hpa.spec?.maxReplicas ?? 1))

  const minN = Number.parseInt(min, 10)
  const maxN = Number.parseInt(max, 10)
  const invalid =
    Number.isNaN(minN) || Number.isNaN(maxN) || minN < 1 || maxN < minN
      ? 'Min must be ≥ 1 and Max must be ≥ Min.'
      : undefined

  const mut = useMutation({
    mutationFn: () =>
      kube.patch(
        GVRS.hpa,
        hpa.metadata.namespace,
        hpa.metadata.name,
        { spec: { minReplicas: minN, maxReplicas: maxN } },
        'merge',
      ),
    onSuccess: () => {
      toast.success(`Updated bounds of ${hpa.metadata.name}`, { description: `min ${minN} · max ${maxN}` })
      qc.invalidateQueries({ queryKey: ['k8s'] })
      onClose()
    },
    onError: (e) => toast.error('Could not update bounds', { description: (e as Error).message }),
  })

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit bounds — ${hpa.metadata.name}`}
      description="Patches spec.minReplicas / spec.maxReplicas on the live object."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={mut.isPending}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={Boolean(invalid) || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Min replicas" error={invalid}>
          <Input type="number" min={1} value={min} onChange={(e) => setMin(e.target.value)} />
        </Field>
        <Field label="Max replicas">
          <Input type="number" min={1} value={max} onChange={(e) => setMax(e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

/* ── create HPA ────────────────────────────────────────────────────────── */

function CreateHpaModal({ namespace, onClose }: { namespace?: string; onClose(): void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const deployments = useDeployments(namespace)
  const statefulsets = useStatefulSets(namespace)

  const workloads = useMemo(() => {
    const opts: Array<{ value: string; label: string; kind: string; name: string; ns: string }> = []
    for (const d of deployments.data ?? []) {
      const ns = d.metadata.namespace ?? ''
      opts.push({
        value: `Deployment|${ns}|${d.metadata.name}`,
        label: `${ns}/${d.metadata.name} (Deployment)`,
        kind: 'Deployment',
        name: d.metadata.name,
        ns,
      })
    }
    for (const s of statefulsets.data ?? []) {
      const ns = s.metadata.namespace ?? ''
      opts.push({
        value: `StatefulSet|${ns}|${s.metadata.name}`,
        label: `${ns}/${s.metadata.name} (StatefulSet)`,
        kind: 'StatefulSet',
        name: s.metadata.name,
        ns,
      })
    }
    return opts.sort((a, b) => a.label.localeCompare(b.label))
  }, [deployments.data, statefulsets.data])

  const [workload, setWorkload] = useState('')
  const [metric, setMetric] = useState<'cpu' | 'memory'>('cpu')
  const [utilization, setUtilization] = useState('80')
  const [min, setMin] = useState('1')
  const [max, setMax] = useState('5')

  const picked = workloads.find((w) => w.value === workload)
  const minN = Number.parseInt(min, 10)
  const maxN = Number.parseInt(max, 10)
  const utilN = Number.parseInt(utilization, 10)
  const boundsError =
    Number.isNaN(minN) || Number.isNaN(maxN) || minN < 1 || maxN < minN
      ? 'Min must be ≥ 1 and Max must be ≥ Min.'
      : undefined
  const utilError = Number.isNaN(utilN) || utilN < 1 || utilN > 100 ? 'Target must be 1–100%.' : undefined
  // The entry point asked about the list's namespace (or all of them); the
  // workload picked here names the namespace the HPA actually lands in.
  const pickedChecks = createChecks(picked?.ns)
  const pickedAccess = useAccessReview(pickedChecks, { enabled: Boolean(picked) })
  const deniedCheck = pickedChecks.find((_, i) => pickedAccess.results[i] === false)

  const mut = useMutation({
    mutationFn: () =>
      kube.apply({
        apiVersion: 'autoscaling/v2',
        kind: 'HorizontalPodAutoscaler',
        metadata: { name: picked!.name, namespace: picked!.ns },
        spec: {
          scaleTargetRef: { apiVersion: 'apps/v1', kind: picked!.kind, name: picked!.name },
          minReplicas: minN,
          maxReplicas: maxN,
          metrics: [
            {
              type: 'Resource',
              resource: { name: metric, target: { type: 'Utilization', averageUtilization: utilN } },
            },
          ],
        },
      }),
    onSuccess: () => {
      toast.success(`Created HPA ${picked?.name ?? ''}`, { description: picked ? `in ${picked.ns}` : undefined })
      qc.invalidateQueries({ queryKey: ['k8s'] })
      onClose()
    },
    onError: (e) => toast.error('Could not create HPA', { description: (e as Error).message }),
  })

  const loadingWorkloads = deployments.isLoading || statefulsets.isLoading

  return (
    <Modal
      open
      onClose={onClose}
      title="Create HorizontalPodAutoscaler"
      description="Scales a live Deployment or StatefulSet on average resource utilization."
      branded
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={mut.isPending}>
            Cancel
          </Button>
          {!picked || pickedAccess.allowed ? (
            <Button
              size="sm"
              variant="primary"
              disabled={!picked || Boolean(boundsError) || Boolean(utilError) || mut.isPending}
              onClick={() => mut.mutate()}
            >
              {mut.isPending ? 'Creating…' : 'Create'}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Workload"
          required
          hint={loadingWorkloads ? 'loading workloads…' : `${workloads.length} available`}
        >
          <Select value={workload} onChange={(e) => setWorkload(e.target.value)}>
            <option value="" disabled>
              {loadingWorkloads ? 'Loading…' : 'Select a Deployment or StatefulSet'}
            </option>
            {workloads.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Metric">
            <Select
              value={metric}
              onChange={(e) => setMetric(e.target.value as 'cpu' | 'memory')}
              options={[
                { value: 'cpu', label: 'CPU utilization' },
                { value: 'memory', label: 'Memory utilization' },
              ]}
            />
          </Field>
          <Field label="Target utilization %" error={utilError}>
            <Input
              type="number"
              min={1}
              max={100}
              value={utilization}
              onChange={(e) => setUtilization(e.target.value)}
              invalid={Boolean(utilError)}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Min replicas" error={boundsError}>
            <Input type="number" min={1} value={min} onChange={(e) => setMin(e.target.value)} />
          </Field>
          <Field label="Max replicas">
            <Input type="number" min={1} value={max} onChange={(e) => setMax(e.target.value)} />
          </Field>
        </div>
        {deniedCheck ? (
          <AccessDenied compact what={`creating autoscalers in ${picked?.ns}`} check={deniedCheck} />
        ) : null}
      </div>
    </Modal>
  )
}
