import { useQuery } from '@tanstack/react-query'
import { useLiveRefetch } from '@adhar-console/shell-ui'
import { k8s } from '@adhar-console/api-clients'

/**
 * Argo Workflows — the non-CI half of the platform's execution story.
 *
 * Tekton owns CI (build, test, publish on a commit) and lives under
 * Platform → CI / CD. Everything else that is a DAG of containers — data
 * backfills, ML jobs, scheduled housekeeping, fan-out/fan-in batch work — runs
 * on Argo Workflows, and this is the data behind that workbench.
 *
 * Everything here is read-only. `K8sClient` exposes generic list/get but no
 * generic delete or patch, so retry / stop / resubmit are not offered rather
 * than offered and broken; the Argo UI deep link covers them.
 */

// Stub fixtures in dev, authenticated `/api/k8s` gateway in prod.
const client = k8s.K8sClient.auto()

export const WORKFLOWS_GVR: k8s.GVR = {
  group: 'argoproj.io',
  version: 'v1alpha1',
  resource: 'workflows',
  namespaced: true,
}

export const WORKFLOW_TEMPLATES_GVR: k8s.GVR = {
  group: 'argoproj.io',
  version: 'v1alpha1',
  resource: 'workflowtemplates',
  namespaced: true,
}

export const CRON_WORKFLOWS_GVR: k8s.GVR = {
  group: 'argoproj.io',
  version: 'v1alpha1',
  resource: 'cronworkflows',
  namespaced: true,
}

/* ─────────── types ─────────── */

export interface ObjMeta {
  name: string
  namespace?: string
  uid?: string
  creationTimestamp?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
}

export type WorkflowPhase = 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Error' | string

/**
 * One entry of `status.nodes`. Argo keys the map by node id and repeats the id
 * inside the value, so the map can be flattened to an array without losing the
 * key.
 */
export interface WorkflowNode {
  id: string
  name: string
  displayName?: string
  /** Pod, DAG, Steps, StepGroup, Skipped, Retry, Suspend, TaskGroup… */
  type?: string
  phase?: WorkflowPhase
  message?: string
  startedAt?: string
  finishedAt?: string
  progress?: string
  templateName?: string
  templateRef?: { name?: string; template?: string; clusterScope?: boolean }
  /** Ids of the nodes this one fans out to — the only edge source Argo gives. */
  children?: string[]
  outboundNodes?: string[]
  boundaryID?: string
  hostNodeName?: string
  /**
   * Only some Argo versions persist the pod name on the node. When it is absent
   * the pod name cannot be derived reliably (v1 names it after the node id, v2
   * after `<workflow>-<template>-<hash>`), so nothing should guess it.
   */
  podName?: string
}

export interface Workflow {
  metadata: ObjMeta
  spec?: {
    entrypoint?: string
    serviceAccountName?: string
    suspend?: boolean
    workflowTemplateRef?: { name?: string; clusterScope?: boolean }
  }
  status?: {
    phase?: WorkflowPhase
    message?: string
    startedAt?: string
    finishedAt?: string
    progress?: string
    estimatedDuration?: number
    nodes?: Record<string, WorkflowNode>
    /**
     * Set instead of `nodes` when the controller gzips a large node map. The
     * console cannot inflate it, and says so rather than drawing a blank graph.
     */
    compressedNodes?: string
  }
}

export interface WorkflowTemplate {
  metadata: ObjMeta
  spec?: {
    entrypoint?: string
    templates?: Array<{ name?: string; [k: string]: unknown }>
  }
}

export interface CronWorkflow {
  metadata: ObjMeta
  spec?: {
    schedule?: string
    /** Argo ≥ 3.6 replaces `schedule` with a list. */
    schedules?: string[]
    timezone?: string
    suspend?: boolean
    concurrencyPolicy?: string
    workflowSpec?: { entrypoint?: string }
  }
  status?: {
    lastScheduledTime?: string
    active?: Array<{ name?: string; namespace?: string }>
  }
}

/* ─────────── queries ─────────── */

/** `true` when the apiserver answered 404. */
export function isNotFound(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 404
}

/**
 * A 404 on a *list* of a CRD path means the type isn't registered — the
 * operator isn't installed. (On a single object it means the object is gone,
 * which is why the two readings have separate names.)
 */
export const isCrdMissing = isNotFound

export function useWorkflows(enabled = true) {
  const queryKey = ['argo-workflows', 'workflows', 'all']
  return useQuery({
    queryKey,
    queryFn: async () => (await client.listGeneric(undefined, WORKFLOWS_GVR)) as unknown as Workflow[],
    // Workflows are CRDs, so node transitions arrive on the apiserver watch —
    // a running workflow advances as it happens rather than every 10 seconds.
    refetchInterval: useLiveRefetch(WORKFLOWS_GVR, [queryKey], 10_000, enabled),
    enabled,
    retry: false,
  })
}

export function useWorkflowTemplates(enabled = true) {
  const queryKey = ['argo-workflows', 'workflowtemplates', 'all']
  return useQuery({
    queryKey,
    queryFn: async () =>
      (await client.listGeneric(undefined, WORKFLOW_TEMPLATES_GVR)) as unknown as WorkflowTemplate[],
    refetchInterval: useLiveRefetch(WORKFLOW_TEMPLATES_GVR, [queryKey], 30_000, enabled),
    enabled,
    retry: false,
  })
}

export function useCronWorkflows(enabled = true) {
  const queryKey = ['argo-workflows', 'cronworkflows', 'all']
  return useQuery({
    queryKey,
    queryFn: async () =>
      (await client.listGeneric(undefined, CRON_WORKFLOWS_GVR)) as unknown as CronWorkflow[],
    refetchInterval: useLiveRefetch(CRON_WORKFLOWS_GVR, [queryKey], 30_000, enabled),
    enabled,
    retry: false,
  })
}

/**
 * The full object for one workflow.
 *
 * A list response carries `status.nodes` today, but the controller is free to
 * trim or compress it, and the graph is only worth drawing from the authoritative
 * object. Refetches on the same watch as the list.
 */
export function useWorkflow(namespace: string | undefined, name: string | undefined) {
  const enabled = !!namespace && !!name
  const queryKey = ['argo-workflows', 'workflow', namespace ?? '', name ?? '']
  return useQuery({
    queryKey,
    queryFn: async () =>
      (await client.getGeneric(undefined, WORKFLOWS_GVR, namespace, name!)) as unknown as Workflow,
    refetchInterval: useLiveRefetch(WORKFLOWS_GVR, [queryKey], 10_000, enabled),
    enabled,
    retry: false,
  })
}

/** Container logs for a node's pod. Only ever called with a server-given pod name. */
export function fetchNodeLogs(namespace: string, podName: string): Promise<string> {
  return client.podLogs(undefined, namespace, podName, { container: 'main', tailLines: 500 })
}

/* ─────────── derivations ─────────── */

/** Flatten `status.nodes` into an array, tolerating a missing/compressed map. */
export function nodeList(wf: Workflow | undefined): WorkflowNode[] {
  const map = wf?.status?.nodes
  if (!map) return []
  return Object.entries(map).map(([id, n]) => ({ ...n, id: n.id || id }))
}

/**
 * Longest-path levelling: a node sits one column right of its deepest parent.
 *
 * Argo only records `children`, so parents are derived by inversion. The
 * iteration is bounded by the node count, which both terminates on the DAG and
 * refuses to hang on a malformed graph that contains a cycle.
 */
export function levelNodes(nodes: WorkflowNode[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const parents = new Map<string, string[]>()
  for (const n of nodes) {
    for (const c of n.children ?? []) {
      if (!byId.has(c)) continue
      parents.set(c, [...(parents.get(c) ?? []), n.id])
    }
  }
  const level = new Map<string, number>(nodes.map((n) => [n.id, 0]))
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false
    for (const n of nodes) {
      const ps = parents.get(n.id)
      if (!ps?.length) continue
      const want = 1 + Math.max(...ps.map((p) => level.get(p) ?? 0))
      if (want > (level.get(n.id) ?? 0)) {
        level.set(n.id, want)
        changed = true
      }
    }
    if (!changed) break
  }
  return level
}

/** Seconds between two timestamps, running to now while unfinished. */
export function durationSecs(startedAt?: string, finishedAt?: string): number | undefined {
  if (!startedAt) return undefined
  const start = new Date(startedAt).getTime()
  if (Number.isNaN(start)) return undefined
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now()
  return Math.max(0, Math.floor((end - start) / 1000))
}

export function fmtDuration(secs: number | undefined): string {
  if (secs === undefined) return '—'
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}
