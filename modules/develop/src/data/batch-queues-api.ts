import { kube } from '@adhar/api-clients/k8s'
import { type BatchJobList, CONFIGMAPS_GVR, PODGROUPS_GVR, QUEUES_GVR } from './batch-model.ts'
import { descriptorOf, type PodGroup, podGroupOfRun, SCHEDULER_DESCRIPTOR, type SchedulerDescriptor, type VolcanoQueue } from './batch-queues-model.ts'
import { statusOf } from './batch-api.ts'

/**
 * Develop → Batch → Queues, the requests. Like the rest of the Batch area they
 * go through the console's Kubernetes gateway AS THE SIGNED-IN USER (§7.3): a
 * platform admin lists every queue, a team member `get`s its own three leaves
 * by name (the Team composition grants exactly that, §10.2), and nobody is
 * shown a queue the apiserver would not hand them. No console permission and no
 * ServiceAccount read is involved. Tested against a fake gateway
 * (`batch-queues-api_test.ts`).
 */

/** Which of Volcano's scheduling APIs this cluster serves. */
export interface VolcanoApis {
  queues: boolean
  podgroups: boolean
}

/**
 * Discovery, not a probe list: whether Volcano is INSTALLED does not depend on
 * who is asking, and the gateway caches discovery. When discovery itself fails
 * the answer falls back to one list — 404 means not served, anything the
 * apiserver could only say about a served API (200, 403) means it is.
 */
export async function volcanoServed(): Promise<VolcanoApis> {
  try {
    const { resources } = await kube.discovery()
    const has = (resource: string) => resources.some((r) => r.group === QUEUES_GVR.group && r.name === resource && !r.subresource)
    return { queues: has(QUEUES_GVR.resource), podgroups: has(PODGROUPS_GVR.resource) }
  } catch {
    try {
      await kube.list(QUEUES_GVR, { limit: 1 })
      return { queues: true, podgroups: true }
    } catch (e) {
      const s = statusOf(e)
      if (s === 403) return { queues: true, podgroups: true }
      if (s === 404) return { queues: false, podgroups: false }
      throw e
    }
  }
}

export interface QueueList {
  items: VolcanoQueue[]
  /** `cluster`: one list of every queue; `names`: the caller may only `get` some by name. */
  scope: 'cluster' | 'names'
  /** Names the apiserver refused to show the caller. */
  denied: string[]
  /** Names that do not exist (yet): a team whose leaves have not been composed. */
  missing: string[]
}

/**
 * Every queue the caller may list, else each candidate leaf by name. The root is
 * asked for by name too: a team member usually may not read it, and the page
 * then simply does not show the ceiling.
 */
export async function readQueues(candidates: readonly string[], root: string): Promise<QueueList> {
  try {
    return { items: (await kube.list<VolcanoQueue>(QUEUES_GVR)).items, scope: 'cluster', denied: [], missing: [] }
  } catch (e) {
    if (statusOf(e) !== 403) throw e
  }
  const names = [...new Set([root, ...candidates].filter(Boolean))]
  const settled = await Promise.allSettled(names.map((n) => kube.get<VolcanoQueue>(QUEUES_GVR, undefined, n)))
  const items: VolcanoQueue[] = []
  const denied: string[] = []
  const missing: string[] = []
  let failure: unknown
  settled.forEach((r, i) => {
    const name = names[i]
    if (r.status === 'fulfilled') items.push(r.value)
    else if (name === root) return // the ceiling is a nicety, never a reason to fail
    else if (statusOf(r.reason) === 403) denied.push(name)
    else if (statusOf(r.reason) === 404) missing.push(name)
    else failure ??= r.reason
  })
  if (failure && !items.length) throw failure
  return { items, scope: 'names', denied, missing }
}

export interface PodGroupList {
  items: PodGroup[]
  /** Some namespace refused the list: gangs there are not shown, which is not the same as none. */
  partial: boolean
}

/** PodGroups across the Batch page's scope: cluster-wide, else each namespace it could read BatchJobs in. */
export async function readPodGroups(scope: BatchJobList['scope'], namespaces: readonly string[]): Promise<PodGroupList> {
  if (scope === 'cluster') {
    try {
      return { items: (await kube.list<PodGroup>(PODGROUPS_GVR)).items, partial: false }
    } catch (e) {
      if (statusOf(e) !== 403) throw e
    }
  }
  const settled = await Promise.allSettled(namespaces.map((namespace) => kube.list<PodGroup>(PODGROUPS_GVR, { namespace })))
  const failed = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  const hard = failed.find((r) => statusOf(r.reason) !== 403 && statusOf(r.reason) !== 404)
  if (hard && failed.length === settled.length) throw hard.reason
  return {
    items: settled.flatMap((r) => (r.status === 'fulfilled' ? r.value.items : [])),
    partial: failed.some((r) => statusOf(r.reason) === 403),
  }
}

/** The PodGroup a run's gang is, found by its owner (`podGroupOfRun`): Volcano names it `<run>-<uid>` (vcjob) or `podgroup-<uid>` (native). */
export async function readRunGang(namespace: string, run: string, uid?: string): Promise<PodGroup | null> {
  try {
    const { items } = await kube.list<PodGroup>(PODGROUPS_GVR, { namespace })
    return podGroupOfRun({ name: run, uid }, items)
  } catch (e) {
    if (statusOf(e) === 404) return null
    throw e
  }
}

/** One namespace's PodGroups, for a job drawer's gangs. A refusal is said, not read as "no gangs". */
export async function readNamespaceGangs(namespace: string): Promise<{ items: PodGroup[]; forbidden: boolean }> {
  try {
    return { items: (await kube.list<PodGroup>(PODGROUPS_GVR, { namespace })).items, forbidden: false }
  } catch (e) {
    const s = statusOf(e)
    if (s === 403) return { items: [], forbidden: true }
    if (s === 404) return { items: [], forbidden: false }
    throw e
  }
}

/** One queue, by name: a team member may `get` its own leaves and nothing else (§10.2). */
export interface QueueRead {
  state: 'present' | 'missing' | 'denied'
  leaf?: VolcanoQueue
}

export async function readQueue(name: string): Promise<QueueRead> {
  try {
    return { state: 'present', leaf: await kube.get<VolcanoQueue>(QUEUES_GVR, undefined, name) }
  } catch (e) {
    const s = statusOf(e)
    if (s === 404) return { state: 'missing' }
    if (s === 403 || s === 401) return { state: 'denied' }
    throw e
  }
}

/** `ConfigMap adhar-batch-scheduler` (D7), read and never written: Phase 1's seed renders it. */
export async function readSchedulerDescriptor(): Promise<SchedulerDescriptor> {
  try {
    return descriptorOf(await kube.get<{ data?: Record<string, string> }>(CONFIGMAPS_GVR, SCHEDULER_DESCRIPTOR.namespace, SCHEDULER_DESCRIPTOR.name))
  } catch (e) {
    const s = statusOf(e)
    if (s === 404) return descriptorOf(null)
    if (s === 403 || s === 401) return descriptorOf(null, true)
    throw e
  }
}
