import { useQueries, useQuery } from '@tanstack/react-query'
import { useLiveRefetch } from '@adhar-console/shell-ui'
import { k8s } from '@adhar-console/api-clients'
import { kube } from '@adhar-console/api-clients/k8s'
import {
  CHAOS_GROUP,
  CHAOS_KINDS,
  CHAOS_VERSION,
  gvrFor,
  type ChaosExperiment,
  type ChaosKindId,
} from './chaos-kinds.ts'

/**
 * Chaos Mesh — deliberate failure, on purpose, with a way back.
 *
 * Chaos Mesh models every fault as its own CRD (`PodChaos`, `NetworkChaos`,
 * `StressChaos`, …) rather than one polymorphic kind, which is right for the
 * operator and awkward for a console: "show me every experiment" is a dozen
 * list calls, not one. This module fans those out and merges the results, so
 * the view can treat chaos as a single list the way an operator thinks about
 * it.
 *
 * Kinds that are not registered on the cluster are dropped rather than
 * surfaced as errors. Chaos Mesh's installation is modular — a cluster can
 * easily have PodChaos and NetworkChaos but no JVMChaos — and a page of red
 * boxes for faults nobody installed is noise, not information.
 *
 * The important safety property is that an experiment is never deleted to stop
 * it. Chaos Mesh recovers the fault on the way out of a running experiment,
 * and deleting the object while it is injected can leave the fault applied
 * with nothing left to undo it. Stopping goes through the pause annotation,
 * which is the operator's own supported path back.
 */

const client = k8s.K8sClient.auto()

/** The annotation Chaos Mesh itself watches to halt an experiment. */
export const PAUSE_ANNOTATION = 'experiment.chaos-mesh.org/pause'

export function isNotFound(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 404
}

/** A 404 listing every chaos kind means Chaos Mesh is not installed at all. */
export const isCrdMissing = isNotFound

/* ─────────── reads ─────────── */

/**
 * Every chaos experiment on the cluster, across every kind.
 *
 * One query per kind so a kind that is missing fails alone, and React Query
 * caches them independently — switching a filter does not refetch the rest.
 */
export function useChaosExperiments(namespace?: string) {
  const results = useQueries({
    queries: CHAOS_KINDS.map((kind) => ({
      queryKey: ['chaos', kind.id, namespace ?? 'all'] as const,
      queryFn: async (): Promise<ChaosExperiment[]> => {
        const res = await kube.list<ChaosExperiment>(gvrFor(kind.id), {
          namespace,
          limit: 500,
        })
        return (res.items ?? []).map((item) => ({ ...item, kind: item.kind || kind.kind }))
      },
      retry: false,
      refetchInterval: 15_000,
    })),
  })

  const experiments = results.flatMap((r) => (r.isSuccess ? r.data : []))
  // Installed = the kind answered at all. A 404 is "not part of this install".
  const installedKinds = CHAOS_KINDS.filter((_, i) => !isNotFound(results[i].error))
  const anyInstalled = results.some((r) => r.isSuccess)
  const isLoading = results.some((r) => r.isLoading)
  // A real error — RBAC, network — as opposed to a kind simply not existing.
  const error = results.find((r) => r.error && !isNotFound(r.error))?.error

  return {
    experiments: experiments.sort(byNewest),
    installedKinds,
    anyInstalled,
    isLoading,
    error,
    refetch: () => results.forEach((r) => void r.refetch()),
  }
}

function byNewest(a: ChaosExperiment, b: ChaosExperiment): number {
  return (b.metadata.creationTimestamp ?? '').localeCompare(a.metadata.creationTimestamp ?? '')
}

export function useChaosExperiment(
  kindId: ChaosKindId | undefined,
  namespace: string | undefined,
  name: string | undefined,
) {
  const enabled = Boolean(kindId && namespace && name)
  const queryKey = ['chaos', 'one', kindId, namespace, name]
  return useQuery({
    queryKey,
    queryFn: async () => await kube.get<ChaosExperiment>(gvrFor(kindId!), namespace, name!),
    refetchInterval: useLiveRefetch(enabled ? gvrFor(kindId!) : null, [queryKey], 5_000, enabled),
    enabled,
    retry: false,
  })
}

/** Chaos Mesh `Schedule` objects — chaos on a cron, the steady-state kind. */
export function useChaosSchedules(namespace?: string) {
  const queryKey = ['chaos', 'schedules', namespace ?? 'all']
  return useQuery({
    queryKey,
    queryFn: async () => {
      const res = await kube.list<ChaosExperiment>(
        { group: CHAOS_GROUP, version: CHAOS_VERSION, resource: 'schedules', namespaced: true },
        { namespace, limit: 200 },
      )
      return res.items ?? []
    },
    refetchInterval: 30_000,
    retry: false,
  })
}

/**
 * Namespaces a chaos experiment could target.
 *
 * Reused by the launch dialog: chaos is only safe when you can see exactly
 * what you are pointing it at, so the dialog picks from the real list rather
 * than taking a free-text namespace.
 */
export function useTargetNamespaces() {
  return useQuery({
    queryKey: ['chaos', 'target-namespaces'],
    queryFn: async () => (await client.listNamespaces()).map((n) => n.metadata.name).sort(),
    staleTime: 60_000,
    retry: false,
  })
}

/* ─────────── writes ─────────── */

/**
 * Stop or resume an experiment.
 *
 * Never a delete. Chaos Mesh recovers the injected fault when an experiment
 * is paused; deleting the object mid-injection can strand the fault with
 * nothing left to undo it. The annotation is the operator's own supported
 * path, and it is reversible — which is the entire point of a chaos tool.
 */
export function setChaosPaused(
  kindId: ChaosKindId,
  namespace: string,
  name: string,
  paused: boolean,
): Promise<unknown> {
  return kube.patch(
    gvrFor(kindId),
    namespace,
    name,
    // null removes the annotation in a merge patch, which is what "resume"
    // means — absent, not "false".
    { metadata: { annotations: { [PAUSE_ANNOTATION]: paused ? 'true' : null } } },
    'merge',
  )
}

/**
 * Delete an experiment.
 *
 * Offered only for experiments that are not currently injected — the view
 * gates on that, and the reason is in `setChaosPaused` above.
 */
export function deleteChaosExperiment(
  kindId: ChaosKindId,
  namespace: string,
  name: string,
): Promise<unknown> {
  return kube.delete(gvrFor(kindId), namespace, name)
}

export interface NewChaosExperiment {
  kindId: ChaosKindId
  name: string
  /** Namespace the experiment object lives in. */
  namespace: string
  action: string
  /** Namespaces whose pods are targeted. */
  targetNamespaces: string[]
  labelSelectors?: Record<string, string>
  mode: 'one' | 'all' | 'fixed' | 'fixed-percent' | 'random-max-percent'
  /** Required by fixed / fixed-percent / random-max-percent. */
  value?: string
  /** Go duration — `30s`, `5m`. Absent means "until stopped", deliberately. */
  duration?: string
  /** Action-specific fields merged into spec (delay, stressors…). */
  extra?: Record<string, unknown>
}

export function createChaosExperiment(input: NewChaosExperiment): Promise<ChaosExperiment> {
  const kind = CHAOS_KINDS.find((k) => k.id === input.kindId)
  if (!kind) throw new Error(`unknown chaos kind: ${input.kindId}`)

  return kube.apply<ChaosExperiment>({
    apiVersion: `${CHAOS_GROUP}/${CHAOS_VERSION}`,
    kind: kind.kind,
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: { 'app.kubernetes.io/managed-by': 'adhar-console' },
    },
    spec: {
      action: input.action,
      mode: input.mode,
      ...(input.value ? { value: input.value } : {}),
      ...(input.duration ? { duration: input.duration } : {}),
      selector: {
        namespaces: input.targetNamespaces,
        ...(input.labelSelectors && Object.keys(input.labelSelectors).length
          ? { labelSelectors: input.labelSelectors }
          : {}),
      },
      ...(input.extra ?? {}),
    },
  })
}

/* ─────────────────────────── game days ─────────────────────────── */

/**
 * A game day is a Chaos Mesh `Workflow`: a whole sequence of experiments as
 * one object, with recovery pauses and a steady-state probe that aborts the
 * run if the system genuinely stops serving.
 *
 * Nodes are tracked separately (`WorkflowNode`), one per template instance,
 * and they carry the real progress — the Workflow's own status only says when
 * it started, when it ended, and which node is the entry.
 */
const WORKFLOWS_GVR = { group: CHAOS_GROUP, version: CHAOS_VERSION, resource: 'workflows', namespaced: true }
const WORKFLOW_NODES_GVR = { group: CHAOS_GROUP, version: CHAOS_VERSION, resource: 'workflownodes', namespaced: true }

export interface WorkflowCondition {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
  startTime?: string
}

export interface ChaosWorkflow {
  apiVersion?: string
  kind?: string
  metadata: {
    name: string
    namespace?: string
    uid?: string
    creationTimestamp?: string
    labels?: Record<string, string>
  }
  spec?: { entry?: string; templates?: Array<Record<string, unknown>> }
  status?: {
    startTime?: string
    endTime?: string
    entryNode?: string
    conditions?: WorkflowCondition[]
  }
}

export interface ChaosWorkflowNode {
  metadata: { name: string; namespace?: string; creationTimestamp?: string }
  spec?: { templateType?: string; deadline?: string; name?: string; children?: string[] }
  status?: {
    conditions?: WorkflowCondition[]
    activeChildren?: Array<{ name?: string }>
    finishedChildren?: Array<{ name?: string }>
    chaosResource?: { name?: string; namespace?: string; kind?: string }
  }
}

export function useChaosWorkflows(namespace?: string) {
  const queryKey = ['chaos', 'workflows', namespace ?? 'all']
  return useQuery({
    queryKey,
    queryFn: async () => {
      const res = await kube.list<ChaosWorkflow>(WORKFLOWS_GVR, { namespace, limit: 200 })
      return (res.items ?? []).sort((a, b) =>
        (b.metadata.creationTimestamp ?? '').localeCompare(a.metadata.creationTimestamp ?? '')
      )
    },
    refetchInterval: 10_000,
    retry: false,
  })
}

export function useChaosWorkflow(namespace: string | undefined, name: string | null) {
  const enabled = Boolean(namespace && name)
  return useQuery({
    queryKey: ['chaos', 'workflow', namespace, name],
    queryFn: () => kube.get<ChaosWorkflow>(WORKFLOWS_GVR, namespace, name!),
    // A game day is minutes long and people watch it; poll faster than the list.
    refetchInterval: enabled ? 5_000 : false,
    enabled,
    retry: false,
  })
}

/**
 * The nodes belonging to one workflow.
 *
 * Chaos Mesh labels each node with its owning workflow, which is the only
 * reliable link — node names carry a generated suffix, so matching on the
 * name prefix would also catch a second run of the same game day.
 */
export function useChaosWorkflowNodes(namespace: string | undefined, workflow: string | null) {
  const enabled = Boolean(namespace && workflow)
  return useQuery({
    queryKey: ['chaos', 'workflow-nodes', namespace, workflow],
    queryFn: async () => {
      const res = await kube.list<ChaosWorkflowNode>(WORKFLOW_NODES_GVR, {
        namespace,
        labelSelector: `chaos-mesh.org/workflow=${workflow}`,
        limit: 500,
      })
      return res.items ?? []
    },
    refetchInterval: enabled ? 5_000 : false,
    enabled,
    retry: false,
  })
}

export function createGameDay(manifest: Record<string, unknown>): Promise<ChaosWorkflow> {
  return kube.apply<ChaosWorkflow>(manifest)
}

export function deleteGameDay(namespace: string, name: string): Promise<unknown> {
  return kube.delete(WORKFLOWS_GVR, namespace, name)
}

export { WORKFLOWS_GVR as CHAOS_WORKFLOWS_GVR }
