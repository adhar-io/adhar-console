import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Spinner, StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { kube } from '@adhar-console/api-clients/k8s'
import { client, isDevK8s, LOCAL_CLUSTER } from '../data/client.ts'
import { GVRS } from '../data/gvr.ts'
import { age } from '../data/format.ts'
import { useHasK8sPermission } from '../data/access.ts'
import { K8sRolePill } from '../components/role-gate.tsx'

/**
 * Workload operations — scale, rollout restart, pause/resume — OpenShift-style.
 *
 * Two entry points share one core (`WorkloadOps`):
 *   • `WorkloadOpsPanel({ pod })` walks a pod's owner chain (Pod → ReplicaSet →
 *     Deployment, or a direct StatefulSet/DaemonSet owner) and drives the
 *     controller's operations.
 *   • `WorkloadOps({ namespace, target })` acts directly on a known workload —
 *     used by the Deployment/StatefulSet/DaemonSet drawers.
 *
 * Reads go through the dev-aware `client` (stub fixtures in dev). Mutations use
 * the gateway `kube.patch` in production and are simulated (optimistic-only) in
 * dev so the widget is fully demoable without a cluster.
 */

type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'ReplicaSet' | 'Job'

const KIND_GVR: Record<WorkloadKind, typeof GVRS.deployments> = {
  Deployment: GVRS.deployments,
  StatefulSet: GVRS.statefulsets,
  DaemonSet: GVRS.daemonsets,
  ReplicaSet: GVRS.replicasets,
  Job: GVRS.jobs,
}

/** Kinds that carry a `spec.replicas` we can scale. */
const SCALABLE: WorkloadKind[] = ['Deployment', 'StatefulSet', 'ReplicaSet']
/** Kinds whose pod template we can annotate to trigger a rolling restart. */
const RESTARTABLE: WorkloadKind[] = ['Deployment', 'StatefulSet', 'DaemonSet']

interface OwnerRef {
  kind: string
  name: string
  controller?: boolean
}

interface WorkloadObj {
  metadata: {
    name: string
    namespace?: string
    creationTimestamp?: string
    annotations?: Record<string, string>
    ownerReferences?: OwnerRef[]
  }
  spec?: {
    replicas?: number
    paused?: boolean
    strategy?: { type?: string }
    updateStrategy?: { type?: string }
    template?: { spec?: { containers?: Array<{ image?: string }> } }
  }
  status?: {
    replicas?: number
    updatedReplicas?: number
    readyReplicas?: number
    availableReplicas?: number
    currentReplicas?: number
    numberReady?: number
    desiredNumberScheduled?: number
    updatedNumberScheduled?: number
  }
}

interface Target {
  kind: WorkloadKind
  name: string
  gvr: typeof GVRS.deployments
}

interface Resolved extends Target {
  obj: WorkloadObj
}

function controllerRef(refs?: OwnerRef[]): OwnerRef | undefined {
  if (!refs?.length) return undefined
  return refs.find((r) => r.controller) ?? refs[0]
}

/* ── entry: from a pod (resolve the owning controller) ──────────────────── */

export function WorkloadOpsPanel({
  pod,
}: {
  pod: {
    metadata: { namespace?: string; name?: string; ownerReferences?: OwnerRef[] }
  }
}) {
  const namespace = pod.metadata.namespace ?? 'default'
  const ctrl = controllerRef(pod.metadata.ownerReferences)

  const resolveQ = useQuery<Target | null>({
    queryKey: ['k8s', 'workload-target', namespace, ctrl?.kind, ctrl?.name],
    enabled: Boolean(ctrl),
    queryFn: async () => {
      if (!ctrl) return null
      let kind = ctrl.kind
      let name = ctrl.name
      // Deployments own pods indirectly through a ReplicaSet — hop up so
      // scale/rollout act on the thing users actually manage.
      if (kind === 'ReplicaSet') {
        const rs = (await client.getGeneric(
          LOCAL_CLUSTER,
          GVRS.replicasets,
          namespace,
          name,
        )) as WorkloadObj
        const owner = controllerRef(rs.metadata.ownerReferences)
        if (owner) {
          kind = owner.kind
          name = owner.name
        }
      }
      const gvr = KIND_GVR[kind as WorkloadKind]
      if (!gvr) return null
      return { kind: kind as WorkloadKind, name, gvr }
    },
  })

  if (!ctrl) {
    return (
      <div className="rounded-xl border border-dashed border-edge-default bg-surface-sunken p-8 text-center">
        <div className="text-sm font-medium text-content">Standalone pod</div>
        <p className="mx-auto mt-1 max-w-md text-xs text-content-muted">
          This pod isn't managed by a controller, so it has no rollout or replica count. Use the
          Restart / Delete actions in the header for pod-level operations.
        </p>
      </div>
    )
  }
  if (resolveQ.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 p-8 text-sm text-content-muted">
        <Spinner size={14} /> Resolving owner workload…
      </div>
    )
  }
  const target = resolveQ.data
  if (!target) {
    return (
      <div className="rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        Owner <code className="font-mono">{ctrl.kind}/{ctrl.name}</code> could not be resolved — it may
        have been deleted or you may lack read access.
      </div>
    )
  }
  return <WorkloadOps namespace={namespace} target={target} showOwner />
}

/* ── entry: directly on a known workload (drawer use) ───────────────────── */

export function WorkloadOpsForKind({
  namespace,
  kind,
  name,
  showStatus = true,
}: {
  namespace: string
  kind: WorkloadKind
  name: string
  /** Hide the rollout-status card when the host already shows status tiles. */
  showStatus?: boolean
}) {
  const gvr = KIND_GVR[kind]
  if (!gvr) return null
  return <WorkloadOps namespace={namespace} target={{ kind, name, gvr }} showStatus={showStatus} />
}

/* ── core ───────────────────────────────────────────────────────────────── */

function WorkloadOps({
  namespace,
  target,
  showOwner = false,
  showStatus = true,
}: {
  namespace: string
  target: Target
  showOwner?: boolean
  showStatus?: boolean
}) {
  const { kind, name, gvr } = target
  const qc = useQueryClient()
  const canScale = useHasK8sPermission('workloads.scale')
  const canWrite = useHasK8sPermission('workloads.write')
  const key = ['k8s', 'workload-ops', namespace, kind, name]

  const q = useQuery<WorkloadObj | null>({
    queryKey: key,
    refetchInterval: 8_000,
    queryFn: async () =>
      (await client.getGeneric(LOCAL_CLUSTER, gvr, namespace, name)) as unknown as WorkloadObj,
  })

  const patchWorkload = async (patch: unknown) => {
    // Dev runs on read-only stub fixtures — simulate success (the optimistic
    // cache update reflects the change) instead of hitting the gateway.
    if (isDevK8s) return
    await kube.patch(gvr, namespace, name, patch, 'merge')
  }

  const scaleMut = useMutation({
    mutationFn: (replicas: number) => patchWorkload({ spec: { replicas } }),
    onMutate: (replicas) => {
      qc.setQueryData<WorkloadObj | null>(key, (prev) =>
        prev ? { ...prev, spec: { ...prev.spec, replicas } } : prev,
      )
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['k8s', 'workload-ops'] })
      qc.invalidateQueries({ queryKey: ['k8s', 'pods'] })
    },
  })

  const restartMut = useMutation({
    mutationFn: () =>
      patchWorkload({
        spec: {
          template: {
            metadata: {
              annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() },
            },
          },
        },
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['k8s', 'pods'] }),
  })

  const pauseMut = useMutation({
    mutationFn: (paused: boolean) => patchWorkload({ spec: { paused } }),
    onMutate: (paused) => {
      qc.setQueryData<WorkloadObj | null>(key, (prev) =>
        prev ? { ...prev, spec: { ...prev.spec, paused } } : prev,
      )
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['k8s', 'workload-ops'] }),
  })

  if (q.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 p-8 text-sm text-content-muted">
        <Spinner size={14} /> Loading workload…
      </div>
    )
  }
  const obj = q.data
  if (!obj) {
    return (
      <div className="rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <code className="font-mono">{kind}/{name}</code> could not be loaded.
      </div>
    )
  }
  const resolved: Resolved = { kind, name, gvr, obj }

  return (
    <div className="space-y-4">
      {showOwner ? <OwnerCard resolved={resolved} /> : null}
      {showStatus ? <RolloutStatus resolved={resolved} /> : null}

      {SCALABLE.includes(kind) ? (
        <ScaleWidget
          resolved={resolved}
          canScale={canScale}
          pending={scaleMut.isPending}
          error={scaleMut.error ? String(scaleMut.error) : undefined}
          onScale={(replicas) => scaleMut.mutate(replicas)}
        />
      ) : null}

      {RESTARTABLE.includes(kind) ? (
        <RolloutActions
          resolved={resolved}
          canWrite={canWrite}
          restarting={restartMut.isPending}
          pausing={pauseMut.isPending}
          onRestart={() => restartMut.mutate()}
          onPause={(paused) => pauseMut.mutate(paused)}
        />
      ) : null}

      {isDevK8s ? (
        <p className="text-center text-[11px] text-content-subtle">
          Dev mode — operations are simulated against stub fixtures (no cluster).
        </p>
      ) : null}
    </div>
  )
}

/* ── owner + status ─────────────────────────────────────────────────────── */

function OwnerCard({ resolved }: { resolved: Resolved }) {
  const { kind, obj } = resolved
  const revision = obj.metadata.annotations?.['deployment.kubernetes.io/revision']
  const image = obj.spec?.template?.spec?.containers?.[0]?.image
  const strategy = obj.spec?.strategy?.type ?? obj.spec?.updateStrategy?.type
  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wider text-content-subtle">
            Managed by
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="rounded-md bg-brand-50 dark:bg-brand-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-brand-700 dark:text-brand-300 ring-1 ring-inset ring-brand-100 dark:ring-brand-500/20">
              {kind}
            </span>
            <span className="truncate text-sm font-semibold text-content">{resolved.name}</span>
          </div>
          {image ? (
            <code className="mt-1 block truncate text-[11px] text-content-muted">{image}</code>
          ) : null}
        </div>
        <div className="shrink-0 text-right text-[11px] text-content-subtle">
          {revision ? <div>revision {revision}</div> : null}
          {strategy ? <div>{strategy}</div> : null}
          <div>{age(obj.metadata.creationTimestamp)}</div>
        </div>
      </div>
    </div>
  )
}

function RolloutStatus({ resolved }: { resolved: Resolved }) {
  const { kind, obj } = resolved
  const paused = obj.spec?.paused
  // Normalise the differently-named fields across Deployment/STS/DaemonSet.
  const desired =
    kind === 'DaemonSet'
      ? obj.status?.desiredNumberScheduled ?? 0
      : obj.spec?.replicas ?? obj.status?.replicas ?? 0
  const updated =
    kind === 'DaemonSet' ? obj.status?.updatedNumberScheduled ?? 0 : obj.status?.updatedReplicas ?? 0
  const ready =
    kind === 'DaemonSet'
      ? obj.status?.numberReady ?? 0
      : obj.status?.readyReplicas ?? obj.status?.currentReplicas ?? 0
  const available = obj.status?.availableReplicas ?? ready

  const rolling = updated < desired || ready < desired
  const isHealthy = !paused && desired > 0 && !rolling
  const label = paused ? 'Paused' : desired === 0 ? 'Scaled to 0' : rolling ? 'Rolling out' : 'Complete'

  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold text-content">Rollout status</div>
        <StatusBadge kind={isHealthy ? 'healthy' : rolling && !paused ? 'progressing' : 'paused'}>
          {label}
        </StatusBadge>
      </div>
      <div className="grid grid-cols-4 gap-2 text-center">
        <Stat label="Desired" value={desired} />
        <Stat label="Updated" value={updated} />
        <Stat
          label="Ready"
          value={ready}
          tone={ready >= desired && desired > 0 ? 'good' : ready > 0 ? 'warn' : undefined}
        />
        <Stat label="Available" value={available} />
      </div>
      <ReplicaBar desired={desired} ready={ready} />
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'warn' }) {
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken px-2 py-2">
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

function ReplicaBar({ desired, ready }: { desired: number; ready: number }) {
  if (desired <= 0) return null
  const pct = Math.min(100, Math.round((ready / desired) * 100))
  return (
    <div className="mt-3">
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            ready >= desired ? 'bg-emerald-500' : 'bg-brand-500',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 text-right text-[10px] text-content-subtle">
        {ready}/{desired} ready
      </div>
    </div>
  )
}

/* ── scale ──────────────────────────────────────────────────────────────── */

function ScaleWidget({
  resolved,
  canScale,
  pending,
  error,
  onScale,
}: {
  resolved: Resolved
  canScale: boolean
  pending: boolean
  error?: string
  onScale(replicas: number): void
}) {
  const current = resolved.obj.spec?.replicas ?? 0
  const [target, setTarget] = useState(current)
  // Keep the input in sync when the live replica count changes.
  useEffect(() => setTarget(current), [current])

  const dirty = target !== current
  const clamp = (n: number) => Math.max(0, Math.min(1000, n))

  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold text-content">Scale</div>
        <span className="text-[11px] text-content-subtle">
          current <span className="font-semibold text-content">{current}</span> replica
          {current === 1 ? '' : 's'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center rounded-lg border border-edge-default bg-surface-raised">
          <button
            type="button"
            disabled={!canScale || pending || target <= 0}
            onClick={() => setTarget((t) => clamp(t - 1))}
            className="flex h-9 w-9 items-center justify-center text-lg text-content-muted hover:bg-surface-sunken disabled:opacity-40"
            aria-label="Decrease replicas"
          >
            −
          </button>
          <input
            type="number"
            value={target}
            min={0}
            disabled={!canScale || pending}
            onChange={(e) => setTarget(clamp(Number(e.target.value)))}
            className="h-9 w-16 border-x border-edge-default text-center text-sm tabular-nums outline-none disabled:opacity-60"
          />
          <button
            type="button"
            disabled={!canScale || pending}
            onClick={() => setTarget((t) => clamp(t + 1))}
            className="flex h-9 w-9 items-center justify-center text-lg text-content-muted hover:bg-surface-sunken disabled:opacity-40"
            aria-label="Increase replicas"
          >
            +
          </button>
        </div>

        {canScale ? (
          <>
            <Button size="sm" disabled={!dirty || pending} onClick={() => onScale(target)}>
              {pending ? 'Scaling…' : `Scale to ${target}`}
            </Button>
            {current !== 0 ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  setTarget(0)
                  onScale(0)
                }}
                title="Scale to zero (keeps the workload, removes all pods)"
              >
                Scale to 0
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  setTarget(1)
                  onScale(1)
                }}
              >
                Restore to 1
              </Button>
            )}
          </>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-content-muted">
            Scaling requires <K8sRolePill perm="workloads.scale" />
          </span>
        )}
      </div>
      {error ? <div className="mt-2 text-[11px] text-rose-700 dark:text-rose-300">Error: {error}</div> : null}
    </div>
  )
}

/* ── rollout actions ────────────────────────────────────────────────────── */

function RolloutActions({
  resolved,
  canWrite,
  restarting,
  pausing,
  onRestart,
  onPause,
}: {
  resolved: Resolved
  canWrite: boolean
  restarting: boolean
  pausing: boolean
  onRestart(): void
  onPause(paused: boolean): void
}) {
  const paused = Boolean(resolved.obj.spec?.paused)
  const canPause = resolved.kind === 'Deployment' // only Deployments support spec.paused
  const [confirmRestart, setConfirmRestart] = useState(false)

  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="mb-3 text-sm font-semibold text-content">Rollout</div>

      {!canWrite ? (
        <div className="flex items-center gap-2 text-[11px] text-content-muted">
          Rollout actions require <K8sRolePill perm="workloads.write" />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {confirmRestart ? (
            <div className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-amber-200 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/10 p-2">
              <span className="text-[12px] text-amber-900 dark:text-amber-200">
                Restart the rollout? All pods of {resolved.kind.toLowerCase()}{' '}
                <code className="font-mono">{resolved.name}</code> will be recreated (rolling).
              </span>
              <div className="ml-auto flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setConfirmRestart(false)} disabled={restarting}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    onRestart()
                    setConfirmRestart(false)
                  }}
                  disabled={restarting}
                >
                  {restarting ? 'Restarting…' : 'Restart rollout'}
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setConfirmRestart(true)} disabled={restarting}>
              <span className="mr-1 text-content-subtle">
                <IconRefresh />
              </span>
              Restart rollout
            </Button>
          )}

          {canPause ? (
            <Button
              size="sm"
              variant={paused ? 'primary' : 'secondary'}
              disabled={pausing}
              onClick={() => onPause(!paused)}
              title={paused ? 'Resume the rollout' : 'Pause the rollout (freeze new rollouts)'}
            >
              <span className="mr-1">{paused ? <IconPlay /> : <IconPause />}</span>
              {pausing ? 'Working…' : paused ? 'Resume rollout' : 'Pause rollout'}
            </Button>
          ) : null}
        </div>
      )}

      <p className="mt-2 text-[11px] text-content-subtle">
        Restart sets <code className="font-mono">kubectl.kubernetes.io/restartedAt</code> to trigger a
        rolling restart — the same as <code className="font-mono">kubectl rollout restart</code>.
      </p>
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
function IconPause() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  )
}
function IconPlay() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 3 14 9-14 9V3z" />
    </svg>
  )
}
