import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Button,
  DonutGauge,
  Kbd,
  Spinner,
  StatusBadge,
  Tabs,
  type StatusKind,
  type TabDef,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import type { k8s } from '@adhar-console/api-clients'
import { client, LOCAL_CLUSTER } from '../data/client.ts'
import { GVRS } from '../data/gvr.ts'
import { age, formatBytes, formatCpu, parseQuantity, shortImage } from '../data/format.ts'
import { usePods } from '../data/hooks.ts'
import { PodShell } from './pod-shell.tsx'
import { PodLogsPanel } from './pod-logs.tsx'
import { PodYamlPanel } from './pod-yaml.tsx'
import { PodMetricsPanel } from './pod-metrics.tsx'
import { WorkloadOpsForKind } from './workload-ops.tsx'
import { K8sPermissionDenied } from '../components/role-gate.tsx'
import { useHasK8sPermission } from '../data/access.ts'

/**
 * Rich, OpenShift-style detail drawer for Deployments / StatefulSets /
 * DaemonSets — the workload-level twin of `pod-drawer.tsx`. One component,
 * parameterised by kind, mirrors the pod drawer's portal + `Tabs` shell and its
 * visual language exactly (same tokens, StatusBadge, spacing helpers).
 *
 * The pod-scoped panels (Metrics / Logs / Shell) are reused verbatim; because a
 * workload fronts many pods, each of those tabs adds a **pod picker** that lists
 * the workload's pods (via `usePods` filtered by the selector labels) and feeds
 * the chosen pod to the existing panel. YAML re-targets the generic
 * `PodYamlPanel` at the workload's own GVR. The marquee **Scale / Rollout** tab
 * adds a live replica gauge, an HPA card, and an Argo-Rollout step ladder on top
 * of the shared `WorkloadOpsForKind` scale/rollout/revision controls.
 */

export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet'

const KIND_GVR: Record<WorkloadKind, k8s.GVR> = {
  Deployment: GVRS.deployments,
  StatefulSet: GVRS.statefulsets,
  DaemonSet: GVRS.daemonsets,
}

const KIND_API_VERSION = 'apps/v1'

const ARGO_ROLLOUTS_GVR: k8s.GVR = {
  group: 'argoproj.io',
  version: 'v1alpha1',
  resource: 'rollouts',
  namespaced: true,
}

interface OwnerRef {
  apiVersion?: string
  kind?: string
  name?: string
  uid?: string
  controller?: boolean
}

interface Container {
  name: string
  image?: string
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> }
  ports?: Array<{ name?: string; containerPort: number; protocol?: string }>
  env?: unknown[]
  volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean; subPath?: string }>
  livenessProbe?: Record<string, unknown>
  readinessProbe?: Record<string, unknown>
  startupProbe?: Record<string, unknown>
}

interface PodTemplateSpec {
  containers?: Container[]
  nodeSelector?: Record<string, string>
  tolerations?: Array<{ key?: string; operator?: string; value?: string; effect?: string }>
  affinity?: Record<string, unknown>
  priorityClassName?: string
  serviceAccountName?: string
}

interface WorkloadObj {
  apiVersion?: string
  kind?: string
  metadata: {
    name: string
    namespace?: string
    uid?: string
    creationTimestamp?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    ownerReferences?: OwnerRef[]
  }
  spec?: {
    replicas?: number
    paused?: boolean
    strategy?: { type?: string; rollingUpdate?: Record<string, unknown> }
    updateStrategy?: { type?: string; rollingUpdate?: Record<string, unknown> }
    selector?: { matchLabels?: Record<string, string> }
    template?: { metadata?: { labels?: Record<string, string> }; spec?: PodTemplateSpec }
  }
  status?: {
    replicas?: number
    readyReplicas?: number
    updatedReplicas?: number
    availableReplicas?: number
    currentReplicas?: number
    // DaemonSet
    desiredNumberScheduled?: number
    currentNumberScheduled?: number
    numberReady?: number
    numberAvailable?: number
    updatedNumberScheduled?: number
    conditions?: Array<{
      type: string
      status: string
      reason?: string
      message?: string
      lastTransitionTime?: string
    }>
  }
}

/** Normalised replica accounting across the three workload shapes. */
interface ReplicaCounts {
  desired: number
  ready: number
  updated: number
  available: number
  /** DaemonSet-only: nodes the controller wants a pod on vs. actually placed. */
  isDaemonSet: boolean
  currentScheduled?: number
}

function countsOf(kind: WorkloadKind, obj: WorkloadObj): ReplicaCounts {
  if (kind === 'DaemonSet') {
    const s = obj.status ?? {}
    return {
      isDaemonSet: true,
      desired: s.desiredNumberScheduled ?? 0,
      ready: s.numberReady ?? 0,
      updated: s.updatedNumberScheduled ?? 0,
      available: s.numberAvailable ?? 0,
      currentScheduled: s.currentNumberScheduled ?? 0,
    }
  }
  const desired = obj.spec?.replicas ?? obj.status?.replicas ?? 0
  return {
    isDaemonSet: false,
    desired,
    ready: obj.status?.readyReplicas ?? obj.status?.currentReplicas ?? 0,
    updated: obj.status?.updatedReplicas ?? 0,
    available: obj.status?.availableReplicas ?? 0,
  }
}

function healthOf(kind: WorkloadKind, obj: WorkloadObj): { kind: StatusKind; label: string } {
  const c = countsOf(kind, obj)
  const paused = Boolean(obj.spec?.paused)
  if (paused) return { kind: 'paused', label: 'Paused' }
  if (!c.isDaemonSet && c.desired === 0) return { kind: 'paused', label: 'Scaled to 0' }
  const rolling = c.updated < c.desired || c.ready < c.desired
  if (rolling) return { kind: 'progressing', label: 'Rolling out' }
  return { kind: 'healthy', label: 'Complete' }
}

type Sub = 'overview' | 'scale' | 'metrics' | 'logs' | 'shell' | 'yaml' | 'events'
const TABS: readonly TabDef<Sub>[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'scale', label: 'Scale / Rollout' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'logs', label: 'Logs' },
  { id: 'shell', label: 'Shell' },
  { id: 'yaml', label: 'YAML' },
  { id: 'events', label: 'Events' },
]

interface Props {
  kind: WorkloadKind
  namespace: string
  name: string
  onClose(): void
}

export function WorkloadDrawer({ kind, namespace, name, onClose }: Props) {
  const gvr = KIND_GVR[kind]
  const wl = useQuery({
    queryKey: ['k8s', 'workload', kind, namespace, name],
    queryFn: () =>
      client.getGeneric(LOCAL_CLUSTER, gvr, namespace, name) as unknown as Promise<WorkloadObj>,
    refetchInterval: 10_000,
  })

  const canExec = useHasK8sPermission('pods.exec')
  const canLogs = useHasK8sPermission('pods.logs')

  // Close on Esc — matches the pod drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const obj = wl.data
  const health = obj ? healthOf(kind, obj) : undefined
  const matchLabels = obj?.spec?.selector?.matchLabels

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
              {kind} · {namespace}
            </div>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-content">{name}</h2>
            <div className="mt-1 font-mono text-[11px] text-content-muted">
              {KIND_API_VERSION}/{kind}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {health ? <StatusBadge kind={health.kind}>{health.label}</StatusBadge> : null}
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
              ✕ <Kbd size="xs">esc</Kbd>
            </Button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <Tabs<Sub> tabs={TABS} defaultValue="overview" ariaLabel="Workload sections">
            {(active) => (
              <>
                {active === 'overview' && (
                  <Overview kind={kind} obj={obj} loading={wl.isLoading} />
                )}
                {active === 'scale' && (
                  <ScaleRollout kind={kind} namespace={namespace} name={name} obj={obj} loading={wl.isLoading} />
                )}
                {active === 'metrics' && (
                  <PodScopedTab
                    namespace={namespace}
                    matchLabels={matchLabels}
                    label="metrics"
                    render={(pod) => (
                      <PodMetricsPanel
                        namespace={namespace}
                        podName={pod.metadata.name}
                        containers={(pod.spec?.containers ?? []).map((c) => ({
                          name: c.name,
                          resources: c.resources,
                        }))}
                      />
                    )}
                    footer={<WorkloadMetricsRollup namespace={namespace} matchLabels={matchLabels} />}
                  />
                )}
                {active === 'logs' && (
                  canLogs ? (
                    <PodScopedTab
                      namespace={namespace}
                      matchLabels={matchLabels}
                      label="logs"
                      render={(pod) => (
                        <PodLogsPanel
                          namespace={namespace}
                          podName={pod.metadata.name}
                          containers={(pod.spec?.containers ?? []).map((c) => c.name)}
                        />
                      )}
                    />
                  ) : (
                    <K8sPermissionDenied perm="pods.logs" />
                  )
                )}
                {active === 'shell' && (
                  canExec ? (
                    <PodScopedTab
                      namespace={namespace}
                      matchLabels={matchLabels}
                      label="shell"
                      render={(pod) => (
                        <PodShell
                          namespace={namespace}
                          name={pod.metadata.name}
                          containers={(pod.spec?.containers ?? []).map((c) => c.name)}
                          defaultContainer={pod.spec?.containers?.[0]?.name}
                        />
                      )}
                    />
                  ) : (
                    <K8sPermissionDenied perm="pods.exec" />
                  )
                )}
                {active === 'yaml' && (
                  <PodYamlPanel pod={obj} gvr={gvr} writePerm="workloads.write" />
                )}
                {active === 'events' && (
                  <Events namespace={namespace} name={name} kind={kind} />
                )}
              </>
            )}
          </Tabs>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

/* ── Overview ────────────────────────────────────────────────────────────── */

function Overview({
  kind,
  obj,
  loading,
}: {
  kind: WorkloadKind
  obj?: WorkloadObj
  loading: boolean
}) {
  if (loading) return <Centered>Loading…</Centered>
  if (!obj) return <Centered>Workload could not be loaded.</Centered>
  const c = countsOf(kind, obj)
  const containers = obj.spec?.template?.spec?.containers ?? []
  const strategy = obj.spec?.strategy?.type ?? obj.spec?.updateStrategy?.type
  const selector = Object.entries(obj.spec?.selector?.matchLabels ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')
  const revision = obj.metadata.annotations?.['deployment.kubernetes.io/revision']

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label={c.isDaemonSet ? 'Desired nodes' : 'Desired'} value={c.desired} />
        <Tile
          label="Ready"
          value={c.ready}
          tone={c.ready >= c.desired && c.desired > 0 ? 'good' : c.ready > 0 ? 'warn' : undefined}
        />
        <Tile label="Up-to-date" value={c.updated} />
        <Tile label="Available" value={c.available} />
      </section>

      <Section title="Details">
        <Row label="Namespace" value={obj.metadata.namespace ?? '—'} />
        <Row label="Kind" value={`${KIND_API_VERSION}/${kind}`} />
        {revision ? <Row label="Revision" value={revision} /> : null}
        <Row label="Strategy" value={strategy ?? '—'} />
        {obj.spec?.paused ? <Row label="Rollout" value={<StatusBadge kind="paused">Paused</StatusBadge>} /> : null}
        <Row label="Selector" value={<Mono>{selector || '—'}</Mono>} />
        <Row label="Age" value={age(obj.metadata.creationTimestamp)} />
        <Row label="UID" value={<Mono>{obj.metadata.uid ?? '—'}</Mono>} />
        <Row label="Labels" value={<KeyValueList obj={obj.metadata.labels} />} />
        <Row label="Annotations" value={<KeyValueList obj={obj.metadata.annotations} />} />
      </Section>

      {obj.metadata.ownerReferences?.length ? (
        <Section title="Owner references">
          <div className="divide-y divide-edge-subtle">
            {obj.metadata.ownerReferences.map((o, i) => (
              <Row
                key={i}
                label={o.kind ?? 'owner'}
                value={
                  <Mono>
                    {o.name}
                    {o.controller ? ' · controller' : ''}
                  </Mono>
                }
              />
            ))}
          </div>
        </Section>
      ) : null}

      <Section title={`Containers (${containers.length})`}>
        <div className="space-y-2 p-3">
          {containers.length === 0 ? (
            <div className="text-sm text-content-muted">No container template found.</div>
          ) : (
            containers.map((cn0, i) => (
              <div
                key={cn0.name ?? i}
                className="rounded-lg border border-edge-default bg-surface-raised p-3 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-content">{cn0.name}</div>
                    <code className="mt-0.5 block truncate text-xs text-content-muted">
                      {shortImage(cn0.image)}
                    </code>
                  </div>
                </div>
                {cn0.resources?.requests || cn0.resources?.limits ? (
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-surface-sunken px-2 py-1.5 text-[11px]">
                    <KV label="CPU req" value={cn0.resources?.requests?.cpu ?? '—'} mono />
                    <KV label="CPU limit" value={cn0.resources?.limits?.cpu ?? '—'} mono />
                    <KV label="Mem req" value={cn0.resources?.requests?.memory ?? '—'} mono />
                    <KV label="Mem limit" value={cn0.resources?.limits?.memory ?? '—'} mono />
                  </div>
                ) : null}
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-content-muted sm:grid-cols-4">
                  <KV label="Ports" value={(cn0.ports ?? []).map((p) => `${p.containerPort}/${p.protocol ?? 'TCP'}`).join(', ') || '—'} />
                  <KV label="Env vars" value={cn0.env?.length ?? 0} />
                  <KV label="Mounts" value={cn0.volumeMounts?.length ?? 0} />
                  <KV label="Probes" value={probeList(cn0).length || '—'} />
                </div>
                {probeList(cn0).length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {probeList(cn0).map(([k, v]) => (
                      <span key={k} className="inline-flex items-center gap-1 rounded-md bg-surface-sunken px-1.5 py-0.5 text-[10px] text-content-muted ring-1 ring-inset ring-edge-subtle">
                        <span className="font-medium text-content-subtle">{k}</span>
                        <span className="font-mono">{v}</span>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </Section>

      <SchedulingSection spec={obj.spec?.template?.spec} />

      <RelatedResources
        namespace={obj.metadata.namespace ?? ''}
        matchLabels={obj.spec?.selector?.matchLabels ?? obj.spec?.template?.metadata?.labels}
      />

      {obj.status?.conditions?.length ? (
        <Section title="Conditions">
          <div className="divide-y divide-edge-subtle">
            {obj.status.conditions.map((cond) => (
              <div key={cond.type} className="flex items-start justify-between gap-3 px-4 py-2">
                <div className="min-w-0">
                  <div className="text-sm text-content">{cond.type}</div>
                  {cond.reason ? (
                    <div className="text-xs text-content-muted">{cond.reason}</div>
                  ) : null}
                  {cond.message ? (
                    <div className="text-xs text-content-subtle">{cond.message}</div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge
                    kind={cond.status === 'True' ? 'healthy' : cond.status === 'False' ? 'degraded' : 'unknown'}
                  >
                    {cond.status}
                  </StatusBadge>
                  {cond.lastTransitionTime ? (
                    <span className="text-[11px] tabular-nums text-content-subtle">{age(cond.lastTransitionTime)}</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <WorkloadRecentEvents namespace={obj.metadata.namespace ?? ''} name={obj.metadata.name} kind={kind} />
    </div>
  )
}

/* ── scheduling / related resources / recent events ──────────────────────── */

function probeList(c: Container): Array<[string, string]> {
  const out: Array<[string, string]> = []
  if (c.livenessProbe) out.push(['liveness', probeSummary(c.livenessProbe)])
  if (c.readinessProbe) out.push(['readiness', probeSummary(c.readinessProbe)])
  if (c.startupProbe) out.push(['startup', probeSummary(c.startupProbe)])
  return out
}

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

function affinitySummary(affinity?: Record<string, unknown>): string | null {
  if (!affinity) return null
  const parts: string[] = []
  if (affinity.nodeAffinity) parts.push('node')
  if (affinity.podAffinity) parts.push('pod')
  if (affinity.podAntiAffinity) parts.push('pod-anti')
  return parts.length ? parts.join(' · ') : null
}

function SchedulingSection({ spec }: { spec?: PodTemplateSpec }) {
  if (!spec) return null
  const hasNodeSelector = spec.nodeSelector && Object.keys(spec.nodeSelector).length > 0
  const affinity = affinitySummary(spec.affinity)
  if (!hasNodeSelector && !spec.tolerations?.length && !affinity && !spec.priorityClassName && !spec.serviceAccountName) {
    return null
  }
  return (
    <Section title="Scheduling">
      {spec.priorityClassName ? <Row label="Priority class" value={<Mono>{spec.priorityClassName}</Mono>} /> : null}
      {spec.serviceAccountName ? <Row label="Service account" value={<Mono>{spec.serviceAccountName}</Mono>} /> : null}
      {hasNodeSelector ? <Row label="Node selector" value={<KeyValueList obj={spec.nodeSelector} />} /> : null}
      {affinity ? <Row label="Affinity" value={<Mono>{affinity}</Mono>} /> : null}
      {spec.tolerations?.length ? (
        <Row
          label="Tolerations"
          value={
            <div className="flex flex-wrap gap-1">
              {spec.tolerations.map((t, i) => (
                <code key={i} className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted">
                  {t.key || 'all'}{t.effect ? `:${t.effect}` : ''}
                </code>
              ))}
            </div>
          }
        />
      ) : null}
    </Section>
  )
}

interface ServiceLite {
  metadata: { name: string; namespace?: string }
  spec?: { selector?: Record<string, string>; type?: string; ports?: Array<{ port: number; protocol?: string }> }
}
interface IngressLite {
  metadata: { name: string }
  spec?: { rules?: Array<{ host?: string; http?: { paths?: Array<{ backend?: { service?: { name?: string } } }> } }> }
}

/** Selector match: a Service targets these pods if all its selector keys match. */
function serviceMatches(svc: ServiceLite, labels?: Record<string, string>): boolean {
  const sel = svc.spec?.selector
  if (!sel || Object.keys(sel).length === 0 || !labels) return false
  return Object.entries(sel).every(([k, v]) => labels[k] === v)
}

function RelatedResources({
  namespace,
  matchLabels,
}: {
  namespace: string
  matchLabels?: Record<string, string>
}) {
  const svcQ = useQuery({
    queryKey: ['k8s', 'workload-related-svc', namespace],
    enabled: Boolean(namespace && matchLabels),
    retry: false,
    refetchInterval: 30_000,
    queryFn: () => client.listServices(LOCAL_CLUSTER, namespace) as unknown as Promise<ServiceLite[]>,
  })
  const ingQ = useQuery({
    queryKey: ['k8s', 'workload-related-ing', namespace],
    enabled: Boolean(namespace && matchLabels),
    retry: false,
    refetchInterval: 30_000,
    queryFn: () => client.listIngresses(LOCAL_CLUSTER, namespace) as unknown as Promise<IngressLite[]>,
  })

  const services = useMemo(
    () => (svcQ.data ?? []).filter((s) => serviceMatches(s, matchLabels)),
    [svcQ.data, matchLabels],
  )
  const serviceNames = useMemo(() => new Set(services.map((s) => s.metadata.name)), [services])
  const ingresses = useMemo(
    () =>
      (ingQ.data ?? []).filter((ing) =>
        (ing.spec?.rules ?? []).some((r) =>
          (r.http?.paths ?? []).some((p) => p.backend?.service?.name && serviceNames.has(p.backend.service.name)),
        ),
      ),
    [ingQ.data, serviceNames],
  )

  if (!matchLabels) return null
  if (svcQ.isLoading) {
    return (
      <Section title="Related resources">
        <div className="px-4 py-3 text-xs text-content-muted">Resolving Services / Ingress…</div>
      </Section>
    )
  }
  if (services.length === 0 && ingresses.length === 0) {
    return (
      <Section title="Related resources">
        <div className="px-4 py-3 text-xs text-content-subtle">No Services or Ingress select these pods.</div>
      </Section>
    )
  }

  return (
    <Section title="Related resources">
      <div className="divide-y divide-edge-subtle">
        {services.map((s) => (
          <Row
            key={s.metadata.name}
            label="Service"
            value={
              <span className="flex flex-wrap items-center gap-2">
                <Mono>{s.metadata.name}</Mono>
                <StatusBadge kind="info">{s.spec?.type ?? 'ClusterIP'}</StatusBadge>
                <span className="text-[11px] text-content-subtle">
                  {(s.spec?.ports ?? []).map((p) => `${p.port}/${p.protocol ?? 'TCP'}`).join(', ')}
                </span>
              </span>
            }
          />
        ))}
        {ingresses.map((ing) => (
          <Row
            key={ing.metadata.name}
            label="Ingress"
            value={
              <span className="flex flex-wrap items-center gap-2">
                <Mono>{ing.metadata.name}</Mono>
                <span className="text-[11px] text-content-subtle">
                  {(ing.spec?.rules ?? []).map((r) => r.host).filter(Boolean).join(', ') || 'no host rules'}
                </span>
              </span>
            }
          />
        ))}
      </div>
    </Section>
  )
}

function WorkloadRecentEvents({ namespace, name, kind }: { namespace: string; name: string; kind: WorkloadKind }) {
  const q = useQuery({
    queryKey: ['k8s', 'workload-events', namespace, kind, name],
    queryFn: () => client.listEvents(LOCAL_CLUSTER, namespace),
    refetchInterval: 15_000,
    retry: false,
  })
  const events = (q.data ?? [])
    .filter((e) => e.involvedObject.namespace === namespace && e.involvedObject.name === name && e.involvedObject.kind === kind)
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

/* ── Scale / Rollout (marquee) ───────────────────────────────────────────── */

function ScaleRollout({
  kind,
  namespace,
  name,
  obj,
  loading,
}: {
  kind: WorkloadKind
  namespace: string
  name: string
  obj?: WorkloadObj
  loading: boolean
}) {
  if (loading) return <Centered>Loading…</Centered>
  if (!obj) return <Centered>Workload could not be loaded.</Centered>
  const c = countsOf(kind, obj)

  return (
    <div className="space-y-4">
      <ReplicaGauge counts={c} paused={Boolean(obj.spec?.paused)} />

      <ArgoRolloutLadder kind={kind} namespace={namespace} name={name} obj={obj} />

      {/* Shared scale + rollout + revision-history controls (RBAC-gated). */}
      <WorkloadOpsForKind namespace={namespace} kind={kind} name={name} showStatus={false} />

      <HpaCard kind={kind} namespace={namespace} name={name} />
    </div>
  )
}

function ReplicaGauge({ counts, paused }: { counts: ReplicaCounts; paused: boolean }) {
  const { desired, ready, updated, available, isDaemonSet, currentScheduled } = counts
  const pct = desired > 0 ? Math.round((ready / desired) * 100) : 0
  const gaugeColor =
    ready >= desired && desired > 0
      ? 'var(--color-emerald-500, #10b981)'
      : 'var(--color-brand-500)'

  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold text-content">
          {isDaemonSet ? 'Node coverage' : 'Replicas'}
        </div>
        <StatusBadge
          kind={paused ? 'paused' : ready >= desired && desired > 0 ? 'healthy' : 'progressing'}
        >
          {paused ? 'Paused' : `${ready}/${desired} ready`}
        </StatusBadge>
      </div>
      <div className="flex flex-wrap items-center gap-6">
        <DonutGauge
          value={ready}
          max={Math.max(1, desired)}
          size={128}
          thickness={14}
          color={gaugeColor}
          label={`${pct}%`}
          caption="ready"
        />
        <div className="min-w-[12rem] flex-1 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Tile label={isDaemonSet ? 'Desired nodes' : 'Desired'} value={desired} />
            <Tile
              label="Ready"
              value={ready}
              tone={ready >= desired && desired > 0 ? 'good' : ready > 0 ? 'warn' : undefined}
            />
            <Tile label={isDaemonSet ? 'Scheduled' : 'Up-to-date'} value={isDaemonSet ? currentScheduled ?? 0 : updated} />
            <Tile label="Available" value={available} />
          </div>
          <StackedReplicaBar desired={desired} ready={ready} updated={updated} />
        </div>
      </div>
      {isDaemonSet ? (
        <p className="mt-3 text-[11px] text-content-subtle">
          DaemonSets have no replica count — they run one pod per matching node, so coverage is shown
          instead of a scale control.
        </p>
      ) : null}
    </div>
  )
}

function StackedReplicaBar({
  desired,
  ready,
  updated,
}: {
  desired: number
  ready: number
  updated: number
}) {
  if (desired <= 0) {
    return (
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
        <div className="h-full w-0" />
      </div>
    )
  }
  const readyPct = Math.min(100, Math.round((ready / desired) * 100))
  const updatedPct = Math.min(100, Math.round((updated / desired) * 100))
  return (
    <div>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
        {/* up-to-date underlay, ready overlay */}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-brand-400/50"
          style={{ width: `${updatedPct}%` }}
        />
        <div
          className={cn(
            'absolute inset-y-0 left-0 rounded-full transition-all',
            ready >= desired ? 'bg-emerald-500' : 'bg-brand-500',
          )}
          style={{ width: `${readyPct}%` }}
        />
      </div>
      <div className="mt-1 flex items-center gap-3 text-[10px] text-content-subtle">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> ready {ready}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-brand-400/60" /> up-to-date {updated}
        </span>
        <span className="ml-auto">{readyPct}%</span>
      </div>
    </div>
  )
}

/* ── HPA association ─────────────────────────────────────────────────────── */

interface HpaObj {
  metadata: { name: string; namespace?: string }
  spec?: {
    minReplicas?: number
    maxReplicas?: number
    scaleTargetRef?: { kind?: string; name?: string }
    metrics?: Array<{
      type?: string
      resource?: { name?: string; target?: { averageUtilization?: number; type?: string } }
    }>
  }
  status?: {
    currentReplicas?: number
    desiredReplicas?: number
    currentMetrics?: Array<{
      type?: string
      resource?: { name?: string; current?: { averageUtilization?: number } }
    }>
  }
}

function HpaCard({
  kind,
  namespace,
  name,
}: {
  kind: WorkloadKind
  namespace: string
  name: string
}) {
  const q = useQuery({
    queryKey: ['k8s', 'workload-hpa', namespace, kind, name],
    refetchInterval: 15_000,
    retry: false,
    queryFn: async () => {
      const list = (await client
        .listGeneric(LOCAL_CLUSTER, GVRS.hpa, namespace)
        .catch(() => [])) as unknown as HpaObj[]
      return list.filter(
        (h) => h.spec?.scaleTargetRef?.kind === kind && h.spec?.scaleTargetRef?.name === name,
      )
    },
  })
  const hpas = q.data ?? []
  if (q.isLoading || hpas.length === 0) return null

  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold text-content">Horizontal Pod Autoscaler</div>
        <StatusBadge kind="info">{hpas.length === 1 ? '1 HPA' : `${hpas.length} HPAs`}</StatusBadge>
      </div>
      <div className="space-y-3">
        {hpas.map((h) => {
          const cur = h.status?.currentReplicas ?? 0
          const min = h.spec?.minReplicas ?? 1
          const max = h.spec?.maxReplicas ?? 0
          const span = Math.max(1, max - min)
          const pos = Math.min(100, Math.max(0, Math.round(((cur - min) / span) * 100)))
          return (
            <div
              key={h.metadata.name}
              className="rounded-lg border border-edge-subtle bg-surface-sunken px-3 py-2"
            >
              <div className="flex items-center justify-between gap-2">
                <code className="font-mono text-xs text-content">{h.metadata.name}</code>
                <span className="text-[11px] text-content-muted">
                  current <span className="font-semibold text-content">{cur}</span> · desired{' '}
                  {h.status?.desiredReplicas ?? '—'}
                </span>
              </div>
              <div className="mt-2">
                <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-edge-subtle">
                  <div className="h-full rounded-full bg-brand-500" style={{ width: `${pos}%` }} />
                </div>
                <div className="mt-1 flex justify-between text-[10px] text-content-subtle">
                  <span>min {min}</span>
                  <span>max {max || '∞'}</span>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(h.spec?.metrics ?? []).map((m, i) => {
                  const target = m.resource?.target?.averageUtilization
                  const currentM = h.status?.currentMetrics?.[i]?.resource?.current?.averageUtilization
                  return (
                    <span
                      key={i}
                      className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] text-content-muted ring-1 ring-inset ring-edge-subtle"
                    >
                      {m.resource?.name ?? m.type}
                      {currentM != null ? ` ${currentM}%` : ''}
                      {target != null ? ` / ${target}%` : ''}
                    </span>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ── Argo Rollout step ladder ────────────────────────────────────────────── */

interface RolloutObj {
  metadata: { name: string; namespace?: string }
  spec?: {
    workloadRef?: { kind?: string; name?: string }
    strategy?: {
      canary?: { steps?: Array<Record<string, unknown>> }
      blueGreen?: Record<string, unknown>
    }
  }
  status?: {
    currentStepIndex?: number
    phase?: string
    message?: string
    canary?: { weights?: { canary?: { weight?: number } } }
  }
}

function ArgoRolloutLadder({
  kind,
  namespace,
  name,
  obj,
}: {
  kind: WorkloadKind
  namespace: string
  name: string
  obj: WorkloadObj
}) {
  const q = useQuery({
    queryKey: ['k8s', 'argo-rollouts', namespace, name],
    refetchInterval: 15_000,
    retry: false,
    queryFn: async () => {
      const list = (await client
        .listGeneric(LOCAL_CLUSTER, ARGO_ROLLOUTS_GVR, namespace)
        .catch(() => [])) as unknown as RolloutObj[]
      return list.find(
        (r) =>
          r.metadata.name === name ||
          (r.spec?.workloadRef?.name === name &&
            (!r.spec.workloadRef.kind || r.spec.workloadRef.kind === kind)),
      )
    },
  })

  // Argo Rollouts only front Deployments; skip the card entirely for STS/DS.
  if (kind !== 'Deployment') return null
  if (q.isLoading) return null

  const rollout = q.data
  if (!rollout) {
    return (
      <div className="rounded-xl border border-dashed border-edge-default bg-surface-sunken p-4 text-center">
        <div className="text-sm font-medium text-content">Plain Deployment</div>
        <p className="mx-auto mt-1 max-w-md text-xs text-content-muted">
          No Argo <code className="font-mono">Rollout</code> backs this workload — rollouts use the
          native Deployment strategy above. Progressive canary / blue-green steps appear here when an
          <code className="font-mono"> argoproj.io/Rollout</code> targets it.
        </p>
      </div>
    )
  }

  const steps = rollout.spec?.strategy?.canary?.steps ?? []
  const isBlueGreen = Boolean(rollout.spec?.strategy?.blueGreen)
  const currentStep = rollout.status?.currentStepIndex ?? 0
  const phase = rollout.status?.phase ?? 'Unknown'
  const weight = rollout.status?.canary?.weights?.canary?.weight

  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-content">
          Argo Rollout
          <span className="rounded-md bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700 ring-1 ring-inset ring-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20">
            {isBlueGreen ? 'blue-green' : 'canary'}
          </span>
        </div>
        <StatusBadge
          kind={
            phase === 'Healthy'
              ? 'healthy'
              : phase === 'Degraded'
                ? 'failed'
                : phase === 'Paused'
                  ? 'paused'
                  : 'progressing'
          }
        >
          {phase}
        </StatusBadge>
      </div>

      {weight != null ? (
        <div className="mb-3">
          <div className="mb-1 flex justify-between text-[11px] text-content-muted">
            <span>canary weight</span>
            <span className="font-semibold text-content">{weight}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
            <div className="h-full rounded-full bg-brand-500" style={{ width: `${weight}%` }} />
          </div>
        </div>
      ) : null}

      {steps.length ? (
        <ol className="overflow-x-auto">
          <div className="flex min-w-0 items-stretch gap-2">
            {steps.map((step, i) => {
              const done = i < currentStep
              const active = i === currentStep
              const label = stepLabel(step)
              return (
                <li
                  key={i}
                  className={cn(
                    'flex min-w-[7rem] flex-col rounded-lg border px-2.5 py-2 text-[11px]',
                    active
                      ? 'border-brand-300 bg-brand-50 dark:border-brand-500/30 dark:bg-brand-500/10'
                      : done
                        ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-500/25 dark:bg-emerald-500/10'
                        : 'border-edge-subtle bg-surface-sunken',
                  )}
                >
                  <span className="font-semibold text-content-subtle">step {i + 1}</span>
                  <span className="mt-0.5 truncate text-content" title={label}>
                    {label}
                  </span>
                  <span className="mt-1">
                    {done ? (
                      <StatusBadge kind="healthy">done</StatusBadge>
                    ) : active ? (
                      <StatusBadge kind="progressing">current</StatusBadge>
                    ) : (
                      <span className="text-content-subtle">pending</span>
                    )}
                  </span>
                </li>
              )
            })}
          </div>
        </ol>
      ) : (
        <p className="text-[11px] text-content-subtle">
          {isBlueGreen
            ? 'Blue-green strategy — promotion is gated on the preview service; no incremental steps.'
            : 'No canary steps defined on this Rollout.'}
        </p>
      )}

      {rollout.status?.message ? (
        <p className="mt-2 text-[11px] text-content-muted">{rollout.status.message}</p>
      ) : null}
    </div>
  )
}

function stepLabel(step: Record<string, unknown>): string {
  if ('setWeight' in step) return `set weight ${String(step.setWeight)}%`
  if ('pause' in step) {
    const p = step.pause as { duration?: string | number } | null
    return p && p.duration != null ? `pause ${p.duration}` : 'pause ∞'
  }
  if ('setCanaryScale' in step) return 'set canary scale'
  if ('analysis' in step) return 'analysis'
  if ('experiment' in step) return 'experiment'
  const k = Object.keys(step)[0]
  return k ?? 'step'
}

/* ── pod picker (feeds Logs / Shell / Metrics) ───────────────────────────── */

interface PickerPod {
  metadata: { name: string; namespace?: string; labels?: Record<string, string> }
  spec?: { containers?: Array<{ name: string; resources?: Container['resources'] }> }
  status?: {
    phase?: string
    containerStatuses?: Array<{ ready?: boolean }>
  }
}

function matchesSelector(pod: PickerPod, matchLabels?: Record<string, string>): boolean {
  if (!matchLabels || Object.keys(matchLabels).length === 0) return false
  const labels = pod.metadata.labels ?? {}
  return Object.entries(matchLabels).every(([k, v]) => labels[k] === v)
}

function podIsReady(pod: PickerPod): boolean {
  if (pod.status?.phase !== 'Running') return false
  const cs = pod.status?.containerStatuses ?? []
  return cs.length === 0 || cs.every((c) => c.ready)
}

function PodScopedTab({
  namespace,
  matchLabels,
  label,
  render,
  footer,
}: {
  namespace: string
  matchLabels?: Record<string, string>
  label: string
  render(pod: PickerPod): React.ReactNode
  footer?: React.ReactNode
}) {
  const podsQ = usePods(namespace)
  const pods = useMemo(
    () =>
      ((podsQ.data ?? []) as unknown as PickerPod[]).filter((p) => matchesSelector(p, matchLabels)),
    [podsQ.data, matchLabels],
  )
  const [selected, setSelected] = useState<string | null>(null)

  // Default to the first ready pod (or the first pod) whenever the set changes
  // and the current selection is gone.
  const activeName = useMemo(() => {
    if (selected && pods.some((p) => p.metadata.name === selected)) return selected
    return (pods.find(podIsReady) ?? pods[0])?.metadata.name ?? null
  }, [selected, pods])

  if (podsQ.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 p-8 text-sm text-content-muted">
        <Spinner size={14} /> Loading pods…
      </div>
    )
  }
  if (pods.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-edge-default bg-surface-sunken p-6 text-center text-sm text-content-muted">
        No pods match this workload's selector — nothing to show {label} for.
      </div>
    )
  }

  const activePod = pods.find((p) => p.metadata.name === activeName)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-surface-sunken p-2">
        <label className="text-[11px] font-medium text-content-subtle">Pod</label>
        <select
          value={activeName ?? ''}
          onChange={(e) => setSelected(e.target.value)}
          className="rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-xs"
        >
          {pods.map((p) => (
            <option key={p.metadata.name} value={p.metadata.name}>
              {p.metadata.name}
              {podIsReady(p) ? '' : ` (${p.status?.phase ?? 'pending'})`}
            </option>
          ))}
        </select>
        <span className="ml-auto text-[11px] text-content-subtle">
          {pods.length} pod{pods.length === 1 ? '' : 's'} · showing {label} for the selected pod
        </span>
      </div>

      {footer}

      {activePod ? (
        <div key={activePod.metadata.name}>{render(activePod)}</div>
      ) : (
        <Centered>Select a pod.</Centered>
      )}
    </div>
  )
}

/* ── workload metrics rollup (Metrics tab header) ────────────────────────── */

interface PodMetricItem {
  metadata: { name: string; namespace?: string; labels?: Record<string, string> }
  containers?: Array<{ usage?: { cpu?: string; memory?: string } }>
}

function WorkloadMetricsRollup({
  namespace,
  matchLabels,
}: {
  namespace: string
  matchLabels?: Record<string, string>
}) {
  const podsQ = usePods(namespace)
  const podNames = useMemo(() => {
    const set = new Set<string>()
    for (const p of (podsQ.data ?? []) as unknown as PickerPod[]) {
      if (matchesSelector(p, matchLabels)) set.add(p.metadata.name)
    }
    return set
  }, [podsQ.data, matchLabels])

  const q = useQuery({
    queryKey: ['k8s', 'workload-metrics-rollup', namespace],
    refetchInterval: 10_000,
    retry: false,
    queryFn: async () =>
      (await client
        .listGeneric(LOCAL_CLUSTER, GVRS.podMetrics, namespace)
        .catch(() => [])) as unknown as PodMetricItem[],
  })

  const rollup = useMemo(() => {
    let cpu = 0
    let mem = 0
    let counted = 0
    for (const item of q.data ?? []) {
      if (!podNames.has(item.metadata.name)) continue
      counted++
      for (const c of item.containers ?? []) {
        cpu += parseQuantity(c.usage?.cpu)
        mem += parseQuantity(c.usage?.memory)
      }
    }
    return { cpu, mem, counted }
  }, [q.data, podNames])

  if (q.isLoading || rollup.counted === 0) return null

  return (
    <div className="grid grid-cols-3 gap-2">
      <Tile label="Pods sampled" value={rollup.counted} />
      <div className="rounded-lg border border-edge-subtle bg-surface-sunken px-2 py-2 text-center">
        <div className="text-lg font-semibold tabular-nums text-content">{formatCpu(rollup.cpu)}</div>
        <div className="text-[10px] uppercase tracking-wide text-content-subtle">CPU (sum)</div>
      </div>
      <div className="rounded-lg border border-edge-subtle bg-surface-sunken px-2 py-2 text-center">
        <div className="text-lg font-semibold tabular-nums text-content">{formatBytes(rollup.mem)}</div>
        <div className="text-[10px] uppercase tracking-wide text-content-subtle">Memory (sum)</div>
      </div>
    </div>
  )
}

/* ── Events ──────────────────────────────────────────────────────────────── */

function Events({ namespace, name, kind }: { namespace: string; name: string; kind: WorkloadKind }) {
  const q = useQuery({
    queryKey: ['k8s', 'workload-events', namespace, kind, name],
    queryFn: () => client.listEvents(LOCAL_CLUSTER, namespace),
    refetchInterval: 5_000,
  })
  const filtered = (q.data ?? []).filter(
    (e) =>
      e.involvedObject.namespace === namespace &&
      e.involvedObject.name === name &&
      e.involvedObject.kind === kind,
  )
  if (q.isLoading) return <Centered>Loading events…</Centered>
  if (filtered.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-edge-default bg-surface-sunken p-6 text-center text-sm text-content-muted">
        No recent events for this {kind.toLowerCase()}.
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

/* ── shared helpers (mirror pod-drawer.tsx's visual language) ────────────── */

function Tile({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'warn' }) {
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken px-2 py-2 text-center">
      <div
        className={cn(
          'text-lg font-semibold tabular-nums',
          tone === 'good' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : 'text-content',
        )}
      >
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-content-subtle">{label}</div>
    </div>
  )
}

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

function KV({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-content-subtle">{label}</span>
      <span className={cn('text-content', mono && 'font-mono')}>{value}</span>
    </div>
  )
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-xs">{children}</code>
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
  return (
    <div className="flex items-center justify-center p-8 text-sm text-content-muted">{children}</div>
  )
}
