import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, canResource, POLL_FLOOR_MS, Spinner, StatusBadge, useCan, useLiveRefetch, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { kube } from '@adhar/api-clients/k8s'
import { client, clusterParam, useActiveCluster } from '../data/client.ts'
import { GVRS } from '../data/gvr.ts'
import { watchOf } from '../data/live.ts'
import { age } from '../data/format.ts'

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
 * Reads go through the gateway-backed `client`; mutations use the gateway
 * `kube.patch`. Nothing is simulated — without a cluster the reads error.
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
  const { cluster } = useActiveCluster()
  const namespace = pod.metadata.namespace ?? 'default'
  const ctrl = controllerRef(pod.metadata.ownerReferences)

  const resolveQ = useQuery<Target | null>({
    queryKey: ['k8s', 'workload-target', namespace, ctrl?.kind, ctrl?.name, cluster],
    enabled: Boolean(ctrl),
    // An owner chain never changes for the life of a pod.
    staleTime: Infinity,
    queryFn: async () => {
      if (!ctrl) return null
      let kind = ctrl.kind
      let name = ctrl.name
      // Deployments own pods indirectly through a ReplicaSet — hop up so
      // scale/rollout act on the thing users actually manage.
      if (kind === 'ReplicaSet') {
        const rs = (await client.getGeneric(
          cluster,
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
  const { cluster } = useActiveCluster()
  const { kind, name, gvr } = target
  const qc = useQueryClient()
  const toast = useToast()
  // Scale, restart, pause/resume and rollback are all PATCHes of the workload
  // object itself (spec.replicas / template annotation / spec.paused /
  // spec.template) — not the /scale subresource — so one check covers them.
  const canPatch = useCan(canResource(gvr, 'patch', { namespace, name }))
  // Same key + watch as the workload drawer's own read of this object, so the
  // drawer and this panel share one GET and one upstream watch.
  const key = ['k8s', 'workload', kind, namespace, name, cluster]

  const q = useQuery<WorkloadObj | null>({
    queryKey: key,
    refetchInterval: useLiveRefetch(
      watchOf(gvr, { namespace, fieldSelector: `metadata.name=${name}`, cluster }),
      [key],
      POLL_FLOOR_MS,
    ),
    queryFn: async () =>
      (await client.getGeneric(cluster, gvr, namespace, name)) as unknown as WorkloadObj,
  })

  const patchWorkload = async (patch: unknown) => {
    await kube.patch(gvr, namespace, name, patch, 'merge', { cluster: clusterParam(cluster) })
  }

  const scaleMut = useMutation({
    mutationFn: (replicas: number) => patchWorkload({ spec: { replicas } }),
    onMutate: (replicas) => {
      qc.setQueryData<WorkloadObj | null>(key, (prev) =>
        prev ? { ...prev, spec: { ...prev.spec, replicas } } : prev,
      )
    },
    onSuccess: (_d, replicas) => toast.success(`Scaled ${name} to ${replicas}`),
    onError: (e) => toast.error('Scale failed', { description: (e as Error).message }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: key })
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
    onSuccess: () => toast.success(`Restarting ${kind} ${name}`),
    // Without this a denied/failed patch looked exactly like a success.
    onError: (e) => toast.error(`Restart failed: ${(e as Error).message}`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['k8s', 'pods'] }),
  })

  const pauseMut = useMutation({
    mutationFn: (paused: boolean) => patchWorkload({ spec: { paused } }),
    onMutate: (paused) => {
      qc.setQueryData<WorkloadObj | null>(key, (prev) =>
        prev ? { ...prev, spec: { ...prev.spec, paused } } : prev,
      )
    },
    onSuccess: (_d, paused) => toast.success(`${paused ? 'Paused' : 'Resumed'} rollout of ${name}`),
    // The optimistic flip is undone by the onSettled refetch; say why it bounced back.
    onError: (e, paused) => toast.error(`Could not ${paused ? 'pause' : 'resume'} rollout: ${(e as Error).message}`),
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
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
          canScale={canPatch}
          pending={scaleMut.isPending}
          onScale={(replicas) => scaleMut.mutate(replicas)}
        />
      ) : null}

      {RESTARTABLE.includes(kind) && canPatch ? (
        <RolloutActions
          resolved={resolved}
          restarting={restartMut.isPending}
          pausing={pauseMut.isPending}
          onRestart={() => restartMut.mutate()}
          onPause={(paused) => pauseMut.mutate(paused)}
        />
      ) : null}

      {kind === 'Deployment' ? (
        <RollbackPanel namespace={namespace} name={name} obj={obj} canWrite={canPatch} />
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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-center">
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
          tone === 'good'
            ? 'text-emerald-600 dark:text-emerald-400'
            : tone === 'warn'
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-content',
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
  onScale,
}: {
  resolved: Resolved
  /** False = read-only: the current count is shown, the controls are not. */
  canScale: boolean
  pending: boolean
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
      {canScale ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center rounded-lg border border-edge-default bg-surface-raised">
            <button
              type="button"
              disabled={pending || target <= 0}
              onClick={() => setTarget((t) => clamp(t - 1))}
              className="flex h-9 w-9 items-center justify-center rounded-l-lg text-lg text-content-muted hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/40 disabled:opacity-40"
              aria-label="Decrease replicas"
            >
              −
            </button>
            <input
              type="number"
              value={target}
              min={0}
              disabled={pending}
              onChange={(e) => setTarget(clamp(Number(e.target.value)))}
              aria-label="Replicas"
              className="h-9 w-16 border-x border-edge-default bg-transparent text-center text-sm tabular-nums text-content outline-none focus-visible:ring-2 focus-visible:ring-brand-400/40 disabled:opacity-60"
            />
            <button
              type="button"
              disabled={pending}
              onClick={() => setTarget((t) => clamp(t + 1))}
              className="flex h-9 w-9 items-center justify-center rounded-r-lg text-lg text-content-muted hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/40 disabled:opacity-40"
              aria-label="Increase replicas"
            >
              +
            </button>
          </div>

          <Button size="sm" variant="primary" disabled={!dirty || pending} onClick={() => onScale(target)}>
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
        </div>
      ) : null}
    </div>
  )
}

/* ── rollout actions ────────────────────────────────────────────────────── */

function RolloutActions({
  resolved,
  restarting,
  pausing,
  onRestart,
  onPause,
}: {
  resolved: Resolved
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
                variant="primary"
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

      <p className="mt-2 text-[11px] text-content-subtle">
        Restart sets <code className="font-mono">kubectl.kubernetes.io/restartedAt</code> to trigger a
        rolling restart — the same as <code className="font-mono">kubectl rollout restart</code>.
      </p>
    </div>
  )
}

/* ── rollback (Deployments) ─────────────────────────────────────────────── */

interface RevisionRs {
  metadata: {
    name: string
    creationTimestamp?: string
    annotations?: Record<string, string>
    ownerReferences?: OwnerRef[]
  }
  spec?: {
    replicas?: number
    template?: {
      metadata?: { labels?: Record<string, string> }
      spec?: { containers?: Array<{ name?: string; image?: string }> }
    }
  }
  status?: { replicas?: number }
}

function revisionOf(rs: RevisionRs): number {
  return Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0)
}

/**
 * Revision history + rollback — the console equivalent of
 * `kubectl rollout history` / `kubectl rollout undo`. Lists the ReplicaSets
 * owned by the Deployment (each one is a retained revision), and rolls back
 * by replacing `spec.template` with the selected revision's pod template
 * (minus the RS-injected `pod-template-hash` label) via a JSON patch, so the
 * old template fully replaces the current one.
 */
function RollbackPanel({
  namespace,
  name,
  obj,
  canWrite,
}: {
  namespace: string
  name: string
  obj: WorkloadObj
  canWrite: boolean
}) {
  const { cluster } = useActiveCluster()
  const qc = useQueryClient()
  const toast = useToast()
  const [confirmRs, setConfirmRs] = useState<string | null>(null)
  const currentRevision = Number(
    obj.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0,
  )

  const rsKey = ['k8s', 'rollout-history', namespace, name, cluster]
  const rsQ = useQuery<RevisionRs[]>({
    queryKey: rsKey,
    // Same watch params as the ReplicaSets list (useReplicaSets), so the hub
    // shares one upstream watch.
    refetchInterval: useLiveRefetch(watchOf(GVRS.replicasets, { namespace, cluster }), [rsKey], POLL_FLOOR_MS),
    queryFn: async () => {
      const list = await kube.list<RevisionRs>(GVRS.replicasets, { namespace, cluster: clusterParam(cluster) })
      return list.items
        .filter((rs) => {
          const owner = controllerRef(rs.metadata.ownerReferences)
          return owner?.kind === 'Deployment' && owner.name === name
        })
        .sort((a, b) => revisionOf(b) - revisionOf(a))
    },
  })

  const rollbackMut = useMutation({
    mutationFn: async (rs: RevisionRs) => {
      const template = JSON.parse(JSON.stringify(rs.spec?.template ?? {})) as {
        metadata?: { labels?: Record<string, string> }
      }
      // The RS carries the controller-injected hash label — it must not leak
      // back into the Deployment's template (same strip kubectl undo does).
      if (template.metadata?.labels) delete template.metadata.labels['pod-template-hash']
      await kube.patch(
        GVRS.deployments,
        namespace,
        name,
        [{ op: 'replace', path: '/spec/template', value: template }],
        'json',
        { cluster: clusterParam(cluster) },
      )
    },
    onSuccess: (_d, rs) => {
      setConfirmRs(null)
      toast.success(`Rolling back ${name} to revision ${revisionOf(rs)}`)
      qc.invalidateQueries({ queryKey: ['k8s'] })
    },
    onError: (e) => toast.error('Rollback failed', { description: (e as Error).message }),
  })

  const revisions = rsQ.data ?? []
  if (rsQ.isLoading || revisions.length <= 1) return null

  const selected = confirmRs ? revisions.find((r) => r.metadata.name === confirmRs) : undefined

  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold text-content">Revision history</div>
        <span className="text-[11px] text-content-subtle">
          current revision <span className="font-semibold text-content">{currentRevision}</span>
        </span>
      </div>

      <ul className="divide-y divide-edge-subtle">
        {revisions.map((rs) => {
          const rev = revisionOf(rs)
          const isCurrent = rev === currentRevision
          const images = (rs.spec?.template?.spec?.containers ?? [])
            .map((c) => c.image)
            .filter(Boolean) as string[]
          return (
            <li key={rs.metadata.name} className="flex items-center gap-3 py-2">
              <span
                className={cn(
                  'w-14 shrink-0 font-mono text-xs tabular-nums',
                  isCurrent ? 'font-semibold text-content' : 'text-content-muted',
                )}
              >
                rev {rev}
              </span>
              <div className="min-w-0 flex-1">
                {images.length ? (
                  <code className="block truncate text-[11px] text-content-muted" title={images.join(', ')}>
                    {images.join(', ')}
                  </code>
                ) : (
                  <span className="text-[11px] text-content-subtle">no images recorded</span>
                )}
                <div className="text-[10px] text-content-subtle">
                  created {age(rs.metadata.creationTimestamp)} ago · {rs.status?.replicas ?? 0}{' '}
                  replica{(rs.status?.replicas ?? 0) === 1 ? '' : 's'}
                </div>
              </div>
              {isCurrent ? (
                <StatusBadge kind="healthy">Current</StatusBadge>
              ) : canWrite ? (
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={rollbackMut.isPending}
                  onClick={() => setConfirmRs(rs.metadata.name)}
                  title={`Roll back to revision ${rev}`}
                >
                  Roll back
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>

      {selected && canWrite ? (
        <div className="mt-3 rounded-lg border border-amber-200 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/10 p-3">
          <div className="text-[12px] text-amber-900 dark:text-amber-200">
            Roll back <code className="font-mono">{name}</code> from revision{' '}
            <span className="font-semibold">{currentRevision}</span> to revision{' '}
            <span className="font-semibold">{revisionOf(selected)}</span>? The pod template will be
            replaced with the older revision's and a new rollout starts immediately.
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmRs(null)}
              disabled={rollbackMut.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={rollbackMut.isPending}
              onClick={() => rollbackMut.mutate(selected)}
            >
              {rollbackMut.isPending ? 'Rolling back…' : `Roll back to rev ${revisionOf(selected)}`}
            </Button>
          </div>
        </div>
      ) : null}

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
