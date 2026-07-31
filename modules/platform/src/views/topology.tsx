import { Fragment, useEffect, useState } from 'react'
import { kube, type GatewayGVR as GVR, type KubeObject } from '@adhar-console/api-clients/k8s'
import { cn } from '@adhar-console/utils'
import { GVRS } from '../data/gvr.ts'

/**
 * Read-only owner-reference topology for a single Kubernetes object. Walks
 * `ownerReferences` upward (fetching each owner) and lists controlled children
 * downward (Deployment → ReplicaSets → Pods, or controller → Pods), rendering a
 * hand-built layered diagram — no external graph library. Every fetch is
 * defensive: a failure just omits that node.
 */

type Health = 'green' | 'amber' | 'rose' | 'gray'

interface Node {
  id: string
  kind: string
  name: string
  health: Health
  focus?: boolean
}

interface Level {
  nodes: Node[]
}

const KNOWN_GVR: Record<string, GVR> = {
  deployment: GVRS.deployments,
  replicaset: GVRS.replicasets,
  statefulset: GVRS.statefulsets,
  daemonset: GVRS.daemonsets,
  job: GVRS.jobs,
  cronjob: GVRS.cronjobs,
  pod: GVRS.pods,
}

function kindToGvr(kind: string, apiVersion?: string): GVR {
  const known = KNOWN_GVR[kind.toLowerCase()]
  if (known) return known
  let group = ''
  let version = 'v1'
  if (apiVersion && apiVersion.includes('/')) {
    const [g, v] = apiVersion.split('/')
    group = g
    version = v
  } else if (apiVersion) {
    version = apiVersion
  }
  return { group, version, resource: `${kind.toLowerCase()}s`, namespaced: true }
}

function singularKind(resource: string): string {
  const s = resource.endsWith('s') ? resource.slice(0, -1) : resource
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function kindOf(obj: KubeObject, gvr?: GVR): string {
  if (obj.kind) return obj.kind
  if (gvr) return singularKind(gvr.resource)
  return 'Object'
}

function healthOf(obj: KubeObject): Health {
  const status = obj.status as Record<string, unknown> | undefined
  const spec = obj.spec as Record<string, unknown> | undefined
  const phase = status?.phase as string | undefined
  if (phase) {
    if (phase === 'Running' || phase === 'Succeeded' || phase === 'Active' || phase === 'Bound') return 'green'
    if (phase === 'Pending') return 'amber'
    if (phase === 'Failed' || phase === 'Unknown') return 'rose'
  }
  const desiredRaw = (spec?.replicas ?? status?.replicas) as number | undefined
  const readyRaw = (status?.readyReplicas ?? status?.numberReady) as number | undefined
  if (desiredRaw !== undefined || readyRaw !== undefined) {
    const desired = desiredRaw ?? 0
    const ready = readyRaw ?? 0
    if (desired === 0) return 'gray'
    return ready >= desired ? 'green' : ready > 0 ? 'amber' : 'rose'
  }
  return 'gray'
}

function nodeFromObj(obj: KubeObject, kindHint?: string, focus = false): Node {
  const kind = obj.kind ?? kindHint ?? 'Object'
  return {
    id: obj.metadata?.uid ?? `${kind}/${obj.metadata?.name}`,
    kind,
    name: obj.metadata?.name ?? '—',
    health: healthOf(obj),
    focus,
  }
}

async function listChildren(gvr: GVR, namespace: string | undefined, parentUid: string): Promise<KubeObject[]> {
  try {
    const res = await kube.list<KubeObject>(gvr, { namespace })
    return res.items.filter((it) => (it.metadata?.ownerReferences ?? []).some((r) => r.uid === parentUid))
  } catch {
    return []
  }
}

async function resolveUp(object: KubeObject): Promise<Level[]> {
  const ns = object.metadata?.namespace
  const levels: Level[] = []
  let current = object
  let guard = 0
  while (guard < 4) {
    guard++
    const refs = current.metadata?.ownerReferences ?? []
    if (!refs.length) break
    const ref = refs.find((r) => (r as { controller?: boolean }).controller) ?? refs[0]
    const gvr = kindToGvr(ref.kind, ref.apiVersion)
    try {
      const owner = await kube.get<KubeObject>(gvr, ns, ref.name)
      levels.unshift({ nodes: [nodeFromObj(owner, ref.kind)] })
      current = owner
    } catch {
      break
    }
  }
  return levels
}

async function resolveDown(object: KubeObject, focusKind: string): Promise<Level[]> {
  const ns = object.metadata?.namespace
  const uid = object.metadata?.uid
  if (!uid) return []
  const levels: Level[] = []

  if (focusKind === 'Deployment') {
    const rses = await listChildren(GVRS.replicasets, ns, uid)
    const active = rses.filter((rs) => ((rs.spec as { replicas?: number })?.replicas ?? 0) > 0)
    const rsList = active.length ? active : rses
    if (rsList.length) {
      levels.push({ nodes: rsList.map((rs) => nodeFromObj(rs, 'ReplicaSet')) })
      const pods: KubeObject[] = []
      for (const rs of rsList) {
        if (!rs.metadata?.uid) continue
        pods.push(...(await listChildren(GVRS.pods, ns, rs.metadata.uid)))
      }
      if (pods.length) levels.push({ nodes: pods.map((p) => nodeFromObj(p, 'Pod')) })
    }
  } else if (focusKind === 'ReplicaSet' || focusKind === 'StatefulSet' || focusKind === 'DaemonSet' || focusKind === 'Job') {
    const pods = await listChildren(GVRS.pods, ns, uid)
    if (pods.length) levels.push({ nodes: pods.map((p) => nodeFromObj(p, 'Pod')) })
  }

  return levels
}

export function Topology({ object, gvr }: { object: KubeObject; gvr?: GVR }) {
  const [levels, setLevels] = useState<Level[] | null>(null)

  useEffect(() => {
    let cancelled = false
    setLevels(null)
    ;(async () => {
      const focusKind = kindOf(object, gvr)
      const up = await resolveUp(object)
      const down = await resolveDown(object, focusKind)
      if (cancelled) return
      const focus: Level = { nodes: [nodeFromObj(object, focusKind, true)] }
      setLevels([...up, focus, ...down])
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [object.metadata?.uid, object.metadata?.namespace])

  if (levels === null) {
    return <div className="py-8 text-center text-sm text-content-muted">Building topology…</div>
  }

  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-max flex-col items-center py-2">
        {levels.map((level, li) => (
          <Fragment key={li}>
            {li > 0 ? <Connector /> : null}
            <div className="flex flex-wrap justify-center gap-3">
              {level.nodes.map((n) => (
                <NodeBox key={n.id} node={n} />
              ))}
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  )
}

const HEALTH_BG: Record<Health, string> = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  rose: 'bg-rose-500',
  gray: 'bg-slate-300',
}

function NodeBox({ node }: { node: Node }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border bg-white px-3 py-2 shadow-sm',
        node.focus ? 'border-sky-400 ring-2 ring-sky-200' : 'border-edge-default',
      )}
    >
      <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', HEALTH_BG[node.health])} aria-hidden />
      <div className="min-w-0">
        <div className="font-mono text-[10px] uppercase tracking-wide text-content-subtle">{node.kind}</div>
        <div className="max-w-[16rem] truncate text-sm font-medium text-content">{node.name}</div>
      </div>
    </div>
  )
}

function Connector() {
  return (
    <div className="flex justify-center text-edge-default">
      <svg width="2" height="20" aria-hidden>
        <line x1="1" y1="0" x2="1" y2="20" stroke="currentColor" strokeWidth="2" />
      </svg>
    </div>
  )
}
