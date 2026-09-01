import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Kbd,
  StatusBadge,
  Tabs,
  type TabDef,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { client, LOCAL_CLUSTER } from '../data/client.ts'
import { GVRS } from '../data/gvr.ts'
import { age, shortImage } from '../data/format.ts'
import { PodShell } from './pod-shell.tsx'
import { PodLogsPanel } from './pod-logs.tsx'
import { PodYamlPanel } from './pod-yaml.tsx'
import { PodMetricsPanel } from './pod-metrics.tsx'
import { WorkloadOpsPanel } from './workload-ops.tsx'
import {
  K8sPermissionDenied,
  K8sRolePill,
} from '../components/role-gate.tsx'
import { useHasK8sPermission } from '../data/access.ts'

type Sub = 'overview' | 'operations' | 'metrics' | 'logs' | 'shell' | 'yaml' | 'events'
const TABS: readonly TabDef<Sub>[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'operations', label: 'Operations' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'logs', label: 'Logs' },
  { id: 'shell', label: 'Shell' },
  { id: 'yaml', label: 'YAML' },
  { id: 'events', label: 'Events' },
]

interface Props {
  namespace: string
  name: string
  onClose(): void
}

export function PodDrawer({ namespace, name, onClose }: Props) {
  const qc = useQueryClient()
  const pod = useQuery({
    queryKey: ['k8s', 'pod', namespace, name],
    queryFn: () => client.getPod(LOCAL_CLUSTER, namespace, name),
    refetchInterval: 10_000,
  })

  const canDelete = useHasK8sPermission('pods.delete')
  const canExec = useHasK8sPermission('pods.exec')
  const canLogs = useHasK8sPermission('pods.logs')
  const canRead = useHasK8sPermission('pods.read')

  const deleteMutation = useMutation({
    mutationFn: () => client.deletePod(LOCAL_CLUSTER, namespace, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['k8s', 'pods'] })
      onClose()
    },
  })

  const [confirm, setConfirm] = useState<null | 'restart' | 'delete'>(null)

  // Close on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (confirm) setConfirm(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, onClose])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <aside className="relative flex h-full w-full max-w-4xl flex-col border-l border-edge-default bg-surface-raised shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default px-6 py-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wider text-content-subtle">
              Pod · {namespace}
            </div>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-content">{name}</h2>
            {pod.data?.spec?.nodeName ? (
              <div className="mt-1 font-mono text-[11px] text-content-muted">
                node: {pod.data.spec.nodeName}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {pod.data ? (
              <StatusBadge
                kind={
                  pod.data.status.phase === 'Running'
                    ? 'healthy'
                    : pod.data.status.phase === 'Failed'
                      ? 'failed'
                      : 'progressing'
                }
              >
                {pod.data.status.phase}
              </StatusBadge>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              disabled={deleteMutation.isPending || !pod.data || !canDelete}
              onClick={() => setConfirm('restart')}
              title={
                canDelete
                  ? 'Delete the pod so its controller recreates it'
                  : 'Restart requires the Tenant Admin or Platform Admin role'
              }
            >
              <span className="mr-1 text-content-subtle">
                <IconRefresh />
              </span>
              Restart
              {canDelete ? null : (
                <span className="ml-1.5">
                  <K8sRolePill perm="pods.delete" />
                </span>
              )}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={deleteMutation.isPending || !pod.data || !canDelete}
              onClick={() => setConfirm('delete')}
              className={canDelete ? 'text-rose-700 hover:text-rose-800 dark:text-rose-300' : ''}
              title={
                canDelete
                  ? 'Permanently remove this pod'
                  : 'Delete requires the Tenant Admin or Platform Admin role'
              }
            >
              <span className={cn('mr-1', canDelete ? 'text-rose-500' : 'text-content-subtle')}>
                <IconTrash />
              </span>
              Delete
              {canDelete ? null : (
                <span className="ml-1.5">
                  <K8sRolePill perm="pods.delete" />
                </span>
              )}
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
              ✕ <Kbd size="xs">esc</Kbd>
            </Button>
          </div>
        </header>
        {confirm ? (
          <ConfirmBar
            kind={confirm}
            podName={name}
            namespace={namespace}
            isPending={deleteMutation.isPending}
            error={deleteMutation.error ? String(deleteMutation.error) : undefined}
            onCancel={() => setConfirm(null)}
            onConfirm={() => deleteMutation.mutate()}
          />
        ) : null}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <Tabs<Sub> tabs={TABS} defaultValue="overview" ariaLabel="Pod sections">
            {(active) => (
              <>
                {active === 'overview' && <Overview pod={pod.data} loading={pod.isLoading} />}
                {active === 'operations' && pod.data ? (
                  <WorkloadOpsPanel pod={pod.data} />
                ) : null}
                {active === 'metrics' && pod.data ? (
                  <PodMetricsPanel
                    namespace={namespace}
                    podName={name}
                    containers={pod.data.spec.containers.map((c) => ({
                      name: c.name,
                      resources: c.resources,
                    }))}
                  />
                ) : null}
                {active === 'logs' && pod.data ? (
                  canLogs ? (
                    <PodLogsPanel
                      namespace={namespace}
                      podName={name}
                      containers={pod.data.spec.containers.map((c) => c.name)}
                    />
                  ) : (
                    <K8sPermissionDenied perm="pods.logs" />
                  )
                ) : null}
                {active === 'shell' && pod.data ? (
                  canExec ? (
                    <PodShell
                      namespace={namespace}
                      name={name}
                      containers={pod.data.spec.containers.map((c) => c.name)}
                      defaultContainer={pod.data.spec.containers[0]?.name}
                    />
                  ) : (
                    <K8sPermissionDenied perm="pods.exec" />
                  )
                ) : null}
                {active === 'yaml' &&
                  (canRead ? (
                    <PodYamlPanel pod={pod.data} />
                  ) : (
                    <K8sPermissionDenied perm="pods.read" />
                  ))}
                {active === 'events' && <Events namespace={namespace} name={name} />}
              </>
            )}
          </Tabs>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function Overview({
  pod,
  loading,
}: {
  pod?: Awaited<ReturnType<typeof client.getPod>>
  loading: boolean
}) {
  if (loading) return <Centered>Loading…</Centered>
  if (!pod) return null
  return (
    <div className="space-y-6">
      <Section title="Metadata">
        <Row label="Namespace" value={pod.metadata.namespace ?? '—'} />
        <Row label="Node" value={pod.spec.nodeName ?? '—'} />
        <Row label="Pod IP" value={<Mono>{pod.status.podIP ?? '—'}</Mono>} />
        <Row label="Host IP" value={<Mono>{pod.status.hostIP ?? '—'}</Mono>} />
        <Row label="QoS class" value={pod.status.qosClass ?? '—'} />
        <Row label="Service account" value={pod.spec.serviceAccountName ?? pod.spec.serviceAccount ?? 'default'} />
        <Row label="Priority class" value={pod.spec.priorityClassName ?? '—'} />
        <Row label="Scheduler" value={pod.spec.schedulerName ?? '—'} />
        <Row label="Restart policy" value={pod.spec.restartPolicy ?? 'Always'} />
        <Row label="Termination grace" value={pod.spec.terminationGracePeriodSeconds ? `${pod.spec.terminationGracePeriodSeconds}s` : '—'} />
        <Row label="DNS policy" value={pod.spec.dnsPolicy ?? '—'} />
        <Row label="Host network" value={pod.spec.hostNetwork ? 'yes' : 'no'} />
        <Row label="Age" value={age(pod.metadata.creationTimestamp)} />
        <Row label="Started" value={pod.status.startTime ? age(pod.status.startTime) : '—'} />
        <Row label="Labels" value={<KeyValueList obj={pod.metadata.labels} />} />
        <Row label="Annotations" value={<KeyValueList obj={pod.metadata.annotations} />} />
      </Section>

      {pod.spec.initContainers?.length ? (
        <Section title={`Init containers (${pod.spec.initContainers.length})`}>
          <div className="space-y-2 p-3">
            {pod.spec.initContainers.map((c) => (
              <ContainerCard
                key={c.name}
                container={c}
                status={pod.status.initContainerStatuses?.find((s) => s.name === c.name)}
              />
            ))}
          </div>
        </Section>
      ) : null}

      <Section title={`Containers (${pod.spec.containers.length})`}>
        <div className="space-y-2 p-3">
          {pod.spec.containers.map((c) => (
            <ContainerCard
              key={c.name}
              container={c}
              status={pod.status.containerStatuses?.find((s) => s.name === c.name)}
            />
          ))}
        </div>
      </Section>

      {pod.spec.volumes?.length ? (
        <Section title={`Volumes (${pod.spec.volumes.length})`}>
          <div className="divide-y divide-edge-subtle">
            {pod.spec.volumes.map((v) => (
              <Row key={v.name} label={v.name} value={<VolumeSource vol={v} />} />
            ))}
          </div>
        </Section>
      ) : null}

      {pod.spec.tolerations?.length ? (
        <Section title={`Tolerations (${pod.spec.tolerations.length})`}>
          <div className="divide-y divide-edge-subtle">
            {pod.spec.tolerations.map((t, i) => (
              <Row
                key={i}
                label={t.key || 'all taints'}
                value={
                  <code className="font-mono text-xs text-content-muted">
                    {t.operator ?? 'Equal'}
                    {t.value ? ` "${t.value}"` : ''}
                    {t.effect ? ` · ${t.effect}` : ''}
                    {t.tolerationSeconds ? ` · ${t.tolerationSeconds}s` : ''}
                  </code>
                }
              />
            ))}
          </div>
        </Section>
      ) : null}

      {pod.spec.nodeSelector && Object.keys(pod.spec.nodeSelector).length ? (
        <Section title="Node selector">
          <Row label="Match" value={<KeyValueList obj={pod.spec.nodeSelector} />} />
        </Section>
      ) : null}

      {pod.spec.affinity && affinitySummary(pod.spec.affinity) ? (
        <Section title="Affinity">
          <Row label="Rules" value={<Mono>{affinitySummary(pod.spec.affinity)}</Mono>} />
        </Section>
      ) : null}

      <Section title="Conditions">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-left text-content-subtle">
                <th className="px-4 py-1.5 font-medium">Type</th>
                <th className="px-2 py-1.5 font-medium">Status</th>
                <th className="px-2 py-1.5 font-medium">Reason</th>
                <th className="px-4 py-1.5 font-medium">Last transition</th>
              </tr>
            </thead>
            <tbody>
              {(pod.status.conditions ?? []).map((c) => (
                <tr key={c.type} className="border-t border-edge-subtle align-top">
                  <td className="px-4 py-1.5 text-content">
                    {c.type}
                    {c.message ? (
                      <div className="text-[11px] text-content-subtle">{c.message}</div>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5">
                    <StatusBadge
                      kind={c.status === 'True' ? 'healthy' : c.status === 'False' ? 'degraded' : 'unknown'}
                    >
                      {c.status}
                    </StatusBadge>
                  </td>
                  <td className="px-2 py-1.5 text-content-muted">{c.reason ?? '—'}</td>
                  <td className="px-4 py-1.5 tabular-nums text-content-muted">
                    {c.lastTransitionTime ? age(c.lastTransitionTime) : '—'}
                  </td>
                </tr>
              ))}
              {(pod.status.conditions ?? []).length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-2 text-content-subtle">No conditions reported.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Section>

      <PodRelations pod={pod} />

      <RecentEvents namespace={pod.metadata.namespace ?? ''} name={pod.metadata.name} kind="Pod" />

      {pod.status.message || pod.status.reason ? (
        <Section title="Status message">
          <Row label="Reason" value={pod.status.reason ?? '—'} />
          {pod.status.message ? (
            <Row label="Message" value={<span className="text-xs">{pod.status.message}</span>} />
          ) : null}
        </Section>
      ) : null}
    </div>
  )
}

function ContainerCard({
  container,
  status,
}: {
  container: Awaited<ReturnType<typeof client.getPod>>['spec']['containers'][number]
  status?: Awaited<ReturnType<typeof client.getPod>>['status']['containerStatuses'] extends
    | infer T
    | undefined
    ? T extends Array<infer U>
      ? U
      : never
    : never
}) {
  const stateEntry = status?.state ? Object.entries(status.state)[0] : undefined
  const stateName = stateEntry?.[0]
  const stateData = stateEntry?.[1] as
    | { reason?: string; message?: string; exitCode?: number; startedAt?: string }
    | undefined

  const envCount = container.env?.length ?? 0
  const mountCount = container.volumeMounts?.length ?? 0
  const digest = digestOf(status?.imageID)
  const probes: Array<[string, string]> = []
  if (container.livenessProbe) probes.push(['liveness', probeSummary(container.livenessProbe)])
  if (container.readinessProbe) probes.push(['readiness', probeSummary(container.readinessProbe)])
  if (container.startupProbe) probes.push(['startup', probeSummary(container.startupProbe)])
  return (
    <div className="rounded-lg border border-edge-default bg-surface-raised p-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium text-content">{container.name}</span>
            {status?.restartCount && status.restartCount > 0 ? (
              <span className="rounded-md bg-amber-50 dark:bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-300 ring-1 ring-inset ring-amber-200 dark:ring-amber-500/25">
                {status.restartCount} restarts
              </span>
            ) : null}
          </div>
          <code className="mt-0.5 block text-xs text-content-muted">{shortImage(container.image)}</code>
          {digest ? (
            <code className="mt-0.5 block truncate font-mono text-[10px] text-content-subtle" title={status?.imageID}>
              digest {digest}
            </code>
          ) : null}
        </div>
        <StatusBadge
          kind={
            status?.ready
              ? 'healthy'
              : stateName === 'waiting'
                ? 'progressing'
                : stateName === 'terminated'
                  ? 'failed'
                  : 'unknown'
          }
        >
          {status?.ready ? 'ready' : stateName ?? 'pending'}
        </StatusBadge>
      </div>
      {stateData && (stateData.reason || stateData.message) ? (
        <div className="mt-2 rounded-md bg-surface-sunken px-2 py-1.5 text-[11px] text-content-muted">
          {stateData.reason ? <span className="font-medium">{stateData.reason}: </span> : null}
          {stateData.message ?? ''}
          {typeof stateData.exitCode === 'number' ? ` (exit ${stateData.exitCode})` : ''}
        </div>
      ) : null}
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-content-muted sm:grid-cols-4">
        <KV label="Image pull" value={container.imagePullPolicy ?? 'IfNotPresent'} />
        <KV label="Ports" value={(container.ports ?? []).map((p) => p.containerPort).join(', ') || '—'} />
        <KV label="Env vars" value={envCount} />
        <KV label="Mounts" value={mountCount} />
      </div>
      {container.resources ? (
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-surface-sunken px-2 py-1.5 text-[11px]">
          <KV label="CPU req" value={container.resources.requests?.cpu ?? '—'} mono />
          <KV label="CPU limit" value={container.resources.limits?.cpu ?? '—'} mono />
          <KV label="Mem req" value={container.resources.requests?.memory ?? '—'} mono />
          <KV label="Mem limit" value={container.resources.limits?.memory ?? '—'} mono />
        </div>
      ) : null}
      {probes.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {probes.map(([k, v]) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 rounded-md bg-surface-sunken px-1.5 py-0.5 text-[10px] text-content-muted ring-1 ring-inset ring-edge-subtle"
            >
              <span className="font-medium text-content-subtle">{k}</span>
              <span className="font-mono">{v}</span>
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-[10px] text-content-subtle">No probes configured</div>
      )}
      {container.ports?.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {container.ports.map((p, i) => (
            <span key={i} className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted ring-1 ring-inset ring-edge-subtle">
              {p.name ? `${p.name} ` : ''}{p.containerPort}/{p.protocol ?? 'TCP'}
            </span>
          ))}
        </div>
      ) : null}
      {container.volumeMounts?.length ? (
        <details className="mt-2 text-[11px]">
          <summary className="cursor-pointer text-content-muted hover:text-content">
            Volume mounts ({mountCount})
          </summary>
          <div className="mt-1 space-y-0.5">
            {container.volumeMounts.map((m, i) => (
              <div key={i} className="font-mono text-[10px] text-content-muted">
                <span className="text-content">{m.name}</span> → {m.mountPath}
                {m.readOnly ? ' (ro)' : ''}
                {m.subPath ? ` [${m.subPath}]` : ''}
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {container.command?.length ? (
        <details className="mt-2 text-[11px]">
          <summary className="cursor-pointer text-content-muted hover:text-content">
            Command & args
          </summary>
          <pre className="mt-1 overflow-x-auto rounded bg-slate-900 p-2 font-mono text-[11px] text-slate-100">
            {container.command.concat(container.args ?? []).join(' ')}
          </pre>
        </details>
      ) : null}
    </div>
  )
}

function KV({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-content-subtle">{label}</span>
      <span className={cn('text-content', mono && 'font-mono')}>{value}</span>
    </div>
  )
}

/** Short image digest (`sha256:abc123…`) from a container status `imageID`. */
function digestOf(imageID?: string): string | null {
  if (!imageID) return null
  const m = imageID.match(/sha256:([0-9a-f]{6,})/i)
  return m ? `sha256:${m[1].slice(0, 12)}` : null
}

/** One-line probe summary from a probe object (`httpGet`/`tcpSocket`/`exec`). */
function probeSummary(probe: Record<string, unknown>): string {
  const http = probe.httpGet as { path?: string; port?: number | string } | undefined
  if (http) return `HTTP ${http.port ?? ''}${http.path ?? ''}`
  const tcp = probe.tcpSocket as { port?: number | string } | undefined
  if (tcp) return `TCP ${tcp.port ?? ''}`
  const grpc = probe.grpc as { port?: number | string } | undefined
  if (grpc) return `gRPC ${grpc.port ?? ''}`
  if (probe.exec) return 'exec'
  return 'probe'
}

/** Compact affinity summary (rule counts) — the full tree lives in YAML. */
function affinitySummary(affinity?: Record<string, unknown>): string | null {
  if (!affinity) return null
  const parts: string[] = []
  if (affinity.nodeAffinity) parts.push('node')
  if (affinity.podAffinity) parts.push('pod')
  if (affinity.podAntiAffinity) parts.push('pod-anti')
  return parts.length ? parts.join(' · ') : null
}

function VolumeSource({
  vol,
}: {
  vol: NonNullable<Awaited<ReturnType<typeof client.getPod>>['spec']['volumes']>[number]
}) {
  if (vol.configMap) return <code className="text-xs">configMap: {vol.configMap.name}</code>
  if (vol.secret)
    return <code className="text-xs">secret: {vol.secret.secretName ?? '—'}</code>
  if (vol.persistentVolumeClaim)
    return <code className="text-xs">pvc: {vol.persistentVolumeClaim.claimName}</code>
  if (vol.emptyDir) return <code className="text-xs">emptyDir</code>
  if (vol.hostPath) return <code className="text-xs">hostPath: {vol.hostPath.path}</code>
  if (vol.projected) return <code className="text-xs">projected</code>
  if (vol.downwardAPI) return <code className="text-xs">downwardAPI</code>
  return <code className="text-xs text-content-subtle">—</code>
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-xs">{children}</code>
}

function Events({ namespace, name }: { namespace: string; name: string }) {
  const q = useQuery({
    queryKey: ['k8s', 'pod-events', namespace, name],
    queryFn: () => client.listEvents(LOCAL_CLUSTER, namespace),
    refetchInterval: 5_000,
  })
  const filtered = (q.data ?? []).filter(
    (e) =>
      e.involvedObject.namespace === namespace &&
      e.involvedObject.name === name &&
      e.involvedObject.kind === 'Pod',
  )
  if (q.isLoading) return <Centered>Loading events…</Centered>
  if (filtered.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-edge-default bg-surface-sunken p-6 text-center text-sm text-content-muted">
        No recent events for this pod.
      </div>
    )
  }
  return (
    <ul className="space-y-2">
      {filtered.map((e) => (
        <li
          key={e.metadata.name}
          className="rounded-lg border border-edge-default bg-surface-raised p-3 shadow-sm"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-content">{e.reason}</div>
              <div className="text-xs text-content-muted">{e.message}</div>
            </div>
            <StatusBadge kind={e.type === 'Warning' ? 'degraded' : 'info'}>{e.type}</StatusBadge>
          </div>
          <div className="mt-1 text-[11px] text-content-subtle">
            {e.count ? `×${e.count} · ` : ''}
            {age(e.lastTimestamp)}
          </div>
        </li>
      ))}
    </ul>
  )
}

/* ── owner chain + related resources ─────────────────────────────────── */

interface GenericLite {
  kind?: string
  metadata: { name: string; namespace?: string; ownerReferences?: Array<{ kind: string; name: string; controller?: boolean }> }
}

function PodRelations({ pod }: { pod: Awaited<ReturnType<typeof client.getPod>> }) {
  const ns = pod.metadata.namespace ?? ''
  const owner = pod.metadata.ownerReferences?.find((o) => o.controller) ?? pod.metadata.ownerReferences?.[0]

  // If the controller is a ReplicaSet, walk one more hop to its Deployment.
  const rsQ = useQuery({
    queryKey: ['k8s', 'pod-owner-rs', ns, owner?.name],
    enabled: Boolean(owner && owner.kind === 'ReplicaSet' && ns),
    retry: false,
    queryFn: () =>
      client.getGeneric(LOCAL_CLUSTER, GVRS.replicasets, ns, owner!.name) as unknown as Promise<GenericLite>,
  })
  const deployOwner = rsQ.data?.metadata.ownerReferences?.find((o) => o.controller)

  if (!owner) return null
  return (
    <Section title="Owner chain">
      <div className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {deployOwner ? (
            <>
              <ChainNode kind={deployOwner.kind} name={deployOwner.name} />
              <Arrow />
            </>
          ) : null}
          <ChainNode kind={owner.kind} name={owner.name} />
          <Arrow />
          <ChainNode kind="Pod" name={pod.metadata.name} current />
        </div>
      </div>
    </Section>
  )
}

function ChainNode({ kind, name, current }: { kind: string; name: string; current?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono',
        current
          ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/25 dark:bg-brand-500/10 dark:text-brand-300'
          : 'border-edge-default bg-surface-sunken text-content-muted',
      )}
    >
      <span className="text-[10px] uppercase tracking-wide text-content-subtle">{kind}</span>
      <span className="truncate text-content">{name}</span>
    </span>
  )
}

function Arrow() {
  return <span className="text-content-subtle">→</span>
}

function RecentEvents({ namespace, name, kind }: { namespace: string; name: string; kind: string }) {
  const q = useQuery({
    queryKey: ['k8s', 'pod-events', namespace, name],
    queryFn: () => client.listEvents(LOCAL_CLUSTER, namespace),
    refetchInterval: 15_000,
    retry: false,
  })
  const events = (q.data ?? [])
    .filter(
      (e) =>
        e.involvedObject.namespace === namespace &&
        e.involvedObject.name === name &&
        e.involvedObject.kind === kind,
    )
    .sort((a, b) => new Date(b.lastTimestamp ?? 0).getTime() - new Date(a.lastTimestamp ?? 0).getTime())
    .slice(0, 5)

  return (
    <Section title="Recent events">
      {q.isLoading ? (
        <div className="px-4 py-3 text-xs text-content-muted">Loading…</div>
      ) : events.length === 0 ? (
        <div className="px-4 py-3 text-xs text-content-subtle">No recent events. See the Events tab for the full stream.</div>
      ) : (
        <div className="divide-y divide-edge-subtle">
          {events.map((e) => (
            <div key={e.metadata.name} className="flex items-start justify-between gap-3 px-4 py-2">
              <div className="min-w-0">
                <div className="text-xs font-medium text-content">{e.reason}</div>
                <div className="truncate text-[11px] text-content-muted" title={e.message}>{e.message}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <StatusBadge kind={e.type === 'Warning' ? 'degraded' : 'info'}>{e.type}</StatusBadge>
                <span className="text-[11px] tabular-nums text-content-subtle">{age(e.lastTimestamp)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-content-subtle">
        {title}
      </h3>
      <div className="rounded-lg border border-edge-default bg-surface-raised">
        <div className="divide-y divide-edge-subtle">{children}</div>
      </div>
    </section>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <span className="w-32 shrink-0 text-xs font-medium text-content-muted">{label}</span>
      <span className="min-w-0 flex-1 text-sm text-content">{value}</span>
    </div>
  )
}

function KeyValueList({ obj }: { obj?: Record<string, string> }) {
  if (!obj || Object.keys(obj).length === 0)
    return <span className="text-content-subtle">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {Object.entries(obj).map(([k, v]) => (
        <span
          key={k}
          className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted"
        >
          {k}
          <span className="text-content-subtle">=</span>
          <span className="text-content">{v}</span>
        </span>
      ))}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-center p-8 text-sm text-content-muted">{children}</div>
}

function ConfirmBar({
  kind,
  podName,
  namespace,
  isPending,
  error,
  onCancel,
  onConfirm,
}: {
  kind: 'restart' | 'delete'
  podName: string
  namespace: string
  isPending: boolean
  error?: string
  onCancel(): void
  onConfirm(): void
}) {
  const isRestart = kind === 'restart'
  return (
    <div
      className={cn(
        'border-b px-6 py-3',
        isRestart
          ? 'border-amber-200 dark:border-amber-500/25 bg-amber-50/70 dark:bg-amber-500/10'
          : 'border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10',
      )}
      role="alert"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
            isRestart ? 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300',
          )}
        >
          {isRestart ? <IconRefresh /> : <IconTrash />}
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <div className={cn('font-semibold', isRestart ? 'text-amber-900 dark:text-amber-200' : 'text-rose-900 dark:text-rose-200')}>
            {isRestart ? 'Restart this pod?' : 'Delete this pod?'}
          </div>
          <div className="text-[12px] text-content-muted">
            {isRestart
              ? 'Deletes the pod — its owner controller will recreate it. Brief downtime expected.'
              : 'Permanently removes the pod. If standalone, it will not be recreated.'}{' '}
            <code className="font-mono text-[11px]">
              {namespace}/{podName}
            </code>
          </div>
          {error ? (
            <div className="mt-1 text-[11px] text-rose-700 dark:text-rose-300">Error: {error}</div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant={isRestart ? 'primary' : 'danger'}
            size="sm"
            disabled={isPending}
            onClick={onConfirm}
          >
            {isPending ? 'Working…' : isRestart ? 'Restart' : 'Delete'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function IconRefresh() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  )
}

function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  )
}

