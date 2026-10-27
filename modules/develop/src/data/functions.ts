import { useMemo } from 'react'
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { kargo } from '@adhar/api-clients'
import { kube } from '@adhar/api-clients/k8s'
import { canResource, type LiveWatchRef, useAccessReview, useWatchSignal } from '@adhar/shell-ui'
import { giteaClient } from './git.ts'
import { queryRange } from './perf-metrics.ts'
import {
  type ApplicationXR,
  APPLICATIONS_GVR,
  CONTROL_PLANE_NS,
  EVENTS_GVR,
  type EventLike,
  type FunctionMetricQuery,
  functionMetricQueries,
  FUNCTIONS_GVR,
  type FunctionXR,
  type KRevision,
  type KRoute,
  type KService,
  KSVC_GVR,
  LABEL,
  overlayDir,
  overridesBranch,
  overridesFileName,
  overridesPatchYaml,
  PIPELINERUNS_GVR,
  type PipelineRunLike,
  type PodAutoscaler,
  PODAUTOSCALERS_GVR,
  type PodLike,
  PODS_GVR,
  PROJECTS_GVR,
  type RepoRef,
  REVISIONS_GVR,
  ROUTES_GVR,
  type ScaleOverrides,
  withPatchReference,
} from './functions-model.ts'

/**
 * Develop → Functions, the reads and the few writes.
 *
 * Everything is read through the console's Kubernetes gateway AS THE
 * SIGNED-IN USER, so what the page shows is exactly what their RBAC lets
 * them see, and kept live by apiserver watches over the shared socket
 * (`useWatchSignal`) — a timer only runs while a watch is refused or the
 * socket is down.
 *
 * Writes are deliberately few, and none of them patches a live Function:
 *   • a Function is CREATED from a template (Catalog → Create New), never here;
 *   • a CHANGE to a GitOps-managed function is a pull request against the
 *     overlay that deploys it (Argo CD selfHeal would revert a live edit);
 *   • DELETE goes through the owning application (`/api/apps/delete`) unless
 *     the Function is not managed from Git at all;
 *   • INVOKE is a BFF call (`/api/functions/invoke`), never the browser
 *     calling the function itself.
 */

const kargoClient = kargo.KargoClient.auto({ tool: 'kargo' })

/** The HTTP status behind a gateway error (`K8sError.status`). */
export const statusOf = (e: unknown): number | undefined => (e as { status?: number } | null)?.status

type Gvr = { group: string; version: string; resource: string; namespaced?: boolean }

/** The apiserver watch behind a read — what `useWatchSignal` subscribes to. */
export function watchOf(gvr: Gvr, opts: { namespace?: string; labelSelector?: string; fieldSelector?: string } = {}): LiveWatchRef {
  return {
    group: gvr.group,
    version: gvr.version,
    resource: gvr.resource,
    ...(opts.namespace ? { namespace: opts.namespace } : {}),
    ...(opts.labelSelector ? { labelSelector: opts.labelSelector } : {}),
    ...(opts.fieldSelector ? { fieldSelector: opts.fieldSelector } : {}),
  }
}

/** Every knative-serving pod and revision carries this label; listing by its existence skips everything else. */
const KSVC_EXISTS = LABEL.ksvc
const SIGNAL = { fallbackMs: 60_000, throttleMs: 2_000 }

/* ─────────────────────────── control plane: projects & applications ─────────────────────────── */

export interface ProjectInfo {
  /** Namespace → environment, from every Project's `status.environments`. */
  envByNamespace: Map<string, string>
  /** Every environment namespace a project publishes. */
  envNamespaces: string[]
  /** Environments in promotion order (union across projects). */
  environments: string[]
  /** Project → its environments, in order. */
  byProject: Map<string, kargo.ProjectEnv[]>
}

/** Project XRs → where each environment lives. `[]` when unreadable or not installed. */
export function useProjects() {
  const queryKey = ['functions', 'projects']
  const q = useQuery({
    queryKey,
    queryFn: async (): Promise<kargo.ProjectLike[]> => {
      try {
        return (await kube.list<kargo.ProjectLike>(PROJECTS_GVR, { namespace: CONTROL_PLANE_NS })).items
      } catch (e) {
        if (statusOf(e) === 403 || statusOf(e) === 404) return []
        throw e
      }
    },
    refetchInterval: useWatchSignal(watchOf(PROJECTS_GVR, { namespace: CONTROL_PLANE_NS }), [queryKey], SIGNAL),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: 1,
  })
  const info = useMemo((): ProjectInfo => {
    const envByNamespace = new Map<string, string>()
    const byProject = new Map<string, kargo.ProjectEnv[]>()
    const order: string[] = []
    for (const p of q.data ?? []) {
      const envs = kargo.projectEnvironments(p)
      byProject.set(p.metadata.name, envs)
      for (const e of envs) {
        envByNamespace.set(e.namespace, e.name)
        if (!order.includes(e.name)) order.push(e.name)
      }
    }
    order.sort((a, b) => kargo.envOrder(a) - kargo.envOrder(b))
    return { envByNamespace, envNamespaces: [...envByNamespace.keys()], environments: order, byProject }
  }, [q.data])
  return { ...info, isLoading: q.isLoading }
}

/** Application XRs (adhar-system) — function apps not yet deployed, and every app's source repository. */
export function useApplications() {
  const queryKey = ['functions', 'applications']
  return useQuery({
    queryKey,
    queryFn: async (): Promise<ApplicationXR[]> => {
      try {
        return (await kube.list<ApplicationXR>(APPLICATIONS_GVR, { namespace: CONTROL_PLANE_NS })).items
      } catch (e) {
        if (statusOf(e) === 403 || statusOf(e) === 404) return []
        throw e
      }
    },
    refetchInterval: useWatchSignal(watchOf(APPLICATIONS_GVR, { namespace: CONTROL_PLANE_NS }), [queryKey], SIGNAL),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: 1,
  })
}

/* ─────────────────────────── the list ─────────────────────────── */

export interface FunctionList {
  items: FunctionXR[]
  /** `cluster`: one cluster-wide list; `namespaces`: the caller may only list some namespaces. */
  scope: 'cluster' | 'namespaces'
  /** Namespaces read (the candidates in `namespaces` scope; where functions were found in `cluster`). */
  namespaces: string[]
  /** Namespaces the caller may not list functions in. */
  denied: string[]
  /** False when the Function API is not served (an install without the control plane's functions). */
  installed: boolean
}

/** The list's query-key prefix — the namespace watches invalidate it. */
export const FUNCTIONS_KEY = ['functions', 'list'] as const

/**
 * Every Function the caller can see. A cluster-wide list first — one request,
 * one watch — and, when RBAC refuses that, each candidate namespace (the
 * projects' environment namespaces plus the shell's namespace selection), so
 * a developer with access to three environments still sees all three.
 */
export function useFunctionList(candidates: readonly string[]) {
  const sorted = useMemo(() => [...new Set(candidates.filter(Boolean))].sort(), [candidates])
  const queryKey = [...FUNCTIONS_KEY, sorted.join(',')]
  const signal = useWatchSignal(watchOf(FUNCTIONS_GVR), [[...FUNCTIONS_KEY]], SIGNAL)
  return useQuery({
    queryKey,
    queryFn: async (): Promise<FunctionList> => {
      try {
        const items = (await kube.list<FunctionXR>(FUNCTIONS_GVR)).items
        return { items, scope: 'cluster', namespaces: [...new Set(items.map((f) => f.metadata.namespace ?? ''))].filter(Boolean), denied: [], installed: true }
      } catch (e) {
        if (statusOf(e) === 404) return { items: [], scope: 'cluster', namespaces: [], denied: [], installed: false }
        if (statusOf(e) !== 403) throw e
      }
      const settled = await Promise.allSettled(sorted.map((namespace) => kube.list<FunctionXR>(FUNCTIONS_GVR, { namespace })))
      const items: FunctionXR[] = []
      const denied: string[] = []
      let installed = true
      let firstError: unknown
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') items.push(...r.value.items)
        else if (statusOf(r.reason) === 403) denied.push(sorted[i])
        else if (statusOf(r.reason) === 404) installed = false
        else firstError ??= r.reason
      })
      if (firstError && !items.length && denied.length + (installed ? 0 : 1) < sorted.length) throw firstError
      return { items, scope: 'namespaces', namespaces: sorted, denied, installed }
    },
    // The cluster-wide watch is refused for a caller who cannot list
    // cluster-wide; the per-namespace watches (FunctionsLive in the view) then
    // carry the change signal and this falls back to a slow timer.
    refetchInterval: signal,
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

/**
 * List one Knative kind across the functions' namespaces: cluster-wide when
 * the functions were, falling back to each namespace when that is refused.
 * Namespaces the caller cannot read are skipped, not fatal — a column with no
 * scale is better than a page with no list.
 */
async function listAcross<T>(gvr: Gvr, scope: 'cluster' | 'namespaces', namespaces: readonly string[], labelSelector: string): Promise<T[]> {
  if (scope === 'cluster') {
    try {
      return (await kube.list<T>(gvr, { labelSelector })).items
    } catch (e) {
      if (statusOf(e) !== 403) throw e
    }
  }
  const settled = await Promise.allSettled(namespaces.map((namespace) => kube.list<T>(gvr, { namespace, labelSelector })))
  return settled.flatMap((r) => (r.status === 'fulfilled' ? r.value.items : []))
}

/** Pods and revisions of every function, for the list's scale and last-deploy columns. */
export function useKnativeIndex(list: FunctionList | undefined) {
  const scope = list?.scope ?? 'cluster'
  const namespaces = list?.namespaces ?? []
  const enabled = Boolean(list?.installed && list.items.length)
  const nsKey = namespaces.join(',')
  const podsKey = ['functions', 'index', 'pods', scope, nsKey]
  const revsKey = ['functions', 'index', 'revisions', scope, nsKey]
  const podsSignal = useWatchSignal(scope === 'cluster' ? watchOf(PODS_GVR, { labelSelector: KSVC_EXISTS }) : null, [podsKey], { ...SIGNAL, enabled })
  const revsSignal = useWatchSignal(scope === 'cluster' ? watchOf(REVISIONS_GVR, { labelSelector: KSVC_EXISTS }) : null, [revsKey], { ...SIGNAL, enabled })
  const pods = useQuery({
    queryKey: podsKey,
    queryFn: () => listAcross<PodLike>(PODS_GVR, scope, namespaces, KSVC_EXISTS),
    enabled,
    refetchInterval: scope === 'cluster' ? podsSignal : 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  })
  const revisions = useQuery({
    queryKey: revsKey,
    queryFn: () => listAcross<KRevision>(REVISIONS_GVR, scope, namespaces, KSVC_EXISTS),
    enabled,
    refetchInterval: scope === 'cluster' ? revsSignal : 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  })
  return {
    pods: pods.data,
    revisions: revisions.data,
    /** The pods read failed — scale is shown as unknown, not as zero. */
    podsUnknown: pods.isError,
  }
}

/* ─────────────────────────── one function ─────────────────────────── */

/** The Function itself, live. `null` once it no longer exists. */
export function useFunction(namespace: string | undefined, name: string | undefined) {
  const on = Boolean(namespace && name)
  const queryKey = ['functions', 'one', namespace, name]
  return useQuery({
    queryKey,
    queryFn: async (): Promise<FunctionXR | null> => {
      try {
        return await kube.get<FunctionXR>(FUNCTIONS_GVR, namespace!, name!)
      } catch (e) {
        if (statusOf(e) === 404) return null
        throw e
      }
    },
    enabled: on,
    refetchInterval: useWatchSignal(on ? watchOf(FUNCTIONS_GVR, { namespace, fieldSelector: `metadata.name=${name}` }) : null, [queryKey], { ...SIGNAL, enabled: on }),
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

/** One named Knative object (`services` / `routes`), live; `null` when it does not exist. */
function useNamed<T>(gvr: Gvr, kind: string, namespace: string | undefined, name: string | undefined) {
  const on = Boolean(namespace && name)
  const queryKey = ['functions', kind, namespace, name]
  return useQuery({
    queryKey,
    queryFn: async (): Promise<T | null> => {
      try {
        return await kube.get<T>(gvr, namespace!, name!)
      } catch (e) {
        if (statusOf(e) === 404) return null
        throw e
      }
    },
    enabled: on,
    refetchInterval: useWatchSignal(on ? watchOf(gvr, { namespace, fieldSelector: `metadata.name=${name}` }) : null, [queryKey], { ...SIGNAL, enabled: on }),
    placeholderData: keepPreviousData,
    retry: false,
  })
}

export const useKnativeService = (namespace?: string, name?: string) => useNamed<KService>(KSVC_GVR, 'ksvc', namespace, name)
export const useKnativeRoute = (namespace?: string, name?: string) => useNamed<KRoute>(ROUTES_GVR, 'route', namespace, name)

/** Objects of one kind labelled for this function's Knative Service, live. 403 is reported, not thrown. */
function useLabelled<T>(gvr: Gvr, kind: string, namespace: string | undefined, name: string | undefined) {
  const on = Boolean(namespace && name)
  const labelSelector = `${LABEL.ksvc}=${name}`
  const queryKey = ['functions', kind, namespace, name]
  return useQuery({
    queryKey,
    queryFn: async (): Promise<{ items: T[]; forbidden: boolean }> => {
      try {
        return { items: (await kube.list<T>(gvr, { namespace, labelSelector })).items, forbidden: false }
      } catch (e) {
        if (statusOf(e) === 403) return { items: [], forbidden: true }
        if (statusOf(e) === 404) return { items: [], forbidden: false }
        throw e
      }
    },
    enabled: on,
    refetchInterval: useWatchSignal(on ? watchOf(gvr, { namespace, labelSelector }) : null, [queryKey], { ...SIGNAL, throttleMs: 1_500, enabled: on }),
    placeholderData: keepPreviousData,
    retry: false,
  })
}

export const useRevisions = (namespace?: string, name?: string) => useLabelled<KRevision>(REVISIONS_GVR, 'revisions', namespace, name)
export const useAutoscalers = (namespace?: string, name?: string) => useLabelled<PodAutoscaler>(PODAUTOSCALERS_GVR, 'autoscalers', namespace, name)
export const useFunctionPods = (namespace?: string, name?: string) => useLabelled<PodLike>(PODS_GVR, 'pods', namespace, name)

/** Events in the function's namespace (the view keeps the ones about it). */
export function useNamespaceEvents(namespace: string | undefined, enabled = true) {
  const on = enabled && Boolean(namespace)
  const queryKey = ['functions', 'events', namespace]
  return useQuery({
    queryKey,
    queryFn: async (): Promise<{ items: EventLike[]; forbidden: boolean }> => {
      try {
        return { items: (await kube.list<EventLike>(EVENTS_GVR, { namespace })).items, forbidden: false }
      } catch (e) {
        if (statusOf(e) === 403) return { items: [], forbidden: true }
        throw e
      }
    },
    enabled: on,
    refetchInterval: useWatchSignal(on ? watchOf(EVENTS_GVR, { namespace }) : null, [queryKey], { fallbackMs: 60_000, throttleMs: 5_000, enabled: on }),
    placeholderData: keepPreviousData,
    retry: false,
  })
}

/**
 * The application's CI runs (app-ci). They live wherever the pipeline runs
 * (`adhar-system` on this platform): cluster-wide by label first, the
 * control-plane namespace when that is refused, and — for runs from before
 * the label — app-ci runs matched by their `repo-name` parameter.
 */
export function useAppBuilds(app: string | undefined, enabled = true) {
  const on = enabled && Boolean(app)
  const queryKey = ['functions', 'builds', app]
  return useQuery({
    queryKey,
    queryFn: async (): Promise<{ items: PipelineRunLike[]; forbidden: boolean }> => {
      const list = async (labelSelector: string) => {
        try {
          return (await kube.list<PipelineRunLike>(PIPELINERUNS_GVR, { labelSelector })).items
        } catch (e) {
          if (statusOf(e) !== 403) throw e
          return (await kube.list<PipelineRunLike>(PIPELINERUNS_GVR, { namespace: CONTROL_PLANE_NS, labelSelector })).items
        }
      }
      try {
        const byLabel = await list(`${LABEL.ciApp}=${app}`)
        if (byLabel.length) return { items: byLabel, forbidden: false }
        return { items: await list('tekton.dev/pipeline=app-ci'), forbidden: false }
      } catch (e) {
        if (statusOf(e) === 403) return { items: [], forbidden: true }
        if (statusOf(e) === 404) return { items: [], forbidden: false }
        throw e
      }
    },
    enabled: on,
    refetchInterval: useWatchSignal(on ? watchOf(PIPELINERUNS_GVR, { labelSelector: `${LABEL.ciApp}=${app}` }) : null, [queryKey], { ...SIGNAL, enabled: on }),
    placeholderData: keepPreviousData,
    retry: false,
  })
}

/** Kargo stages and freight of the project, plus whether the caller may read stages at all. */
export function useDelivery(project: string | undefined, enabled = true) {
  const on = enabled && Boolean(project)
  const access = useAccessReview(
    project ? canResource({ group: 'kargo.akuity.io', resource: 'stages', namespaced: true }, 'list', { namespace: project }) : null,
    { enabled: on },
  )
  const stagesKey = ['functions', 'kargo', 'stages', project]
  const freightKey = ['functions', 'kargo', 'freight', project]
  const kargoWatch = (resource: string) => (on ? { group: 'kargo.akuity.io', version: 'v1alpha1', resource, namespace: project } : null)
  const stages = useQuery({
    queryKey: stagesKey,
    queryFn: () => kargoClient.listStages(project!),
    enabled: on,
    refetchInterval: useWatchSignal(kargoWatch('stages'), [stagesKey], { ...SIGNAL, throttleMs: 3_000, enabled: on }),
    placeholderData: keepPreviousData,
    retry: false,
  })
  const freight = useQuery({
    queryKey: freightKey,
    queryFn: () => kargoClient.listFreight(project!),
    enabled: on,
    refetchInterval: useWatchSignal(kargoWatch('freights'), [freightKey], { ...SIGNAL, throttleMs: 3_000, enabled: on }),
    placeholderData: keepPreviousData,
    retry: false,
  })
  return {
    stages: stages.data,
    freight: freight.data,
    isLoading: stages.isLoading || freight.isLoading,
    error: (stages.error ?? freight.error) as Error | null,
    /** A definite "no": the caller may not list Kargo stages in the project. */
    forbidden: on && !access.loading && !access.unknown && access.results[0] === false,
  }
}

/* ─────────────────────────── metrics ─────────────────────────── */

export interface MetricPanel {
  spec: FunctionMetricQuery
  points: Array<[number, number]>
  loading: boolean
  error?: string
}

/** The function's request, error, latency, CPU and memory series over the last `windowMs`. */
export function useFunctionMetrics(namespace: string | undefined, name: string | undefined, windowMs: number, enabled = true) {
  const specs = useMemo(() => (namespace && name ? functionMetricQueries(namespace, name) : []), [namespace, name])
  // Quantised to the minute, so re-renders do not mint a new query every second.
  const end = Math.floor(Date.now() / 60_000) * 60_000
  const start = end - windowMs
  const results = useQueries({
    queries: specs.map((spec) => ({
      queryKey: ['functions', 'metrics', namespace, name, spec.id, start, end],
      queryFn: () => queryRange(spec.query, start, end, 120),
      enabled: enabled && specs.length > 0,
      staleTime: 60_000,
      refetchInterval: 60_000,
      placeholderData: keepPreviousData,
      retry: false,
    })),
  })
  return specs.map((spec, i): MetricPanel => {
    const r = results[i]
    const pts = (r?.data?.series ?? []).flatMap((s) => s.points.map((p): [number, number] => [p.t, p.v]))
    return { spec, points: pts, loading: Boolean(r?.isLoading), error: r?.error instanceof Error ? r.error.message : undefined }
  })
}

/* ─────────────────────────── writes ─────────────────────────── */

export interface InvokeInput {
  namespace: string
  name: string
  method: string
  path: string
  headers: Record<string, string>
  body?: string
  timeoutMs?: number
}

export interface InvokeResult {
  ok: true
  url: string
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  binary: boolean
  size: number
  truncated: boolean
  durationMs: number
  attempts: Array<{ url: string; error?: string }>
}

/** Call the function through the BFF (`POST /api/functions/invoke`) — never from the browser. */
export function useInvokeFunction() {
  return useMutation({
    mutationFn: async (input: InvokeInput): Promise<InvokeResult> => {
      const res = await fetch('/api/functions/invoke', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(input),
      })
      const body = (await res.json().catch(() => ({}))) as Partial<InvokeResult> & { error?: string; detail?: string }
      if (!res.ok || body.ok !== true) throw new Error(body.detail ?? body.error ?? `Invoke failed (HTTP ${res.status})`)
      return body as InvokeResult
    },
  })
}

/** Delete an UNMANAGED Function (no Git owner), foreground, so its composed objects go with it. */
export function useDeleteFunction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ namespace, name }: { namespace: string; name: string }) => {
      await kube.delete(FUNCTIONS_GVR, namespace, name, { propagationPolicy: 'Foreground' })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['functions'] }),
  })
}

/**
 * Delete the application that owns a GitOps-managed function — the existing
 * application delete flow (`/api/apps/delete`, app-delete.ts): the
 * Application XR as the caller (Crossplane removes every environment's
 * deployment), and optionally its repository.
 */
export function useDeleteOwningApplication() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ name, deleteRepo }: { name: string; deleteRepo: boolean }) => {
      const res = await fetch('/api/apps/delete', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ name, deleteRepo, confirm: name }),
      })
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; deleting?: boolean; error?: string; detail?: string }
      if (!res.ok) throw new Error(body.detail ?? body.error ?? `Delete failed (HTTP ${res.status})`)
      return { ok: Boolean(body.ok), deleting: Boolean(body.deleting) }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['functions'] })
      qc.invalidateQueries({ queryKey: ['catalog'] })
    },
  })
}

/** Gitea file bodies arrive base64 unless asked otherwise. */
function decodeContent(f: { content: string; encoding: string }): string {
  if (f.encoding !== 'base64') return f.content
  const bin = atob(f.content.replace(/\s/g, ''))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

function encodeContent(s: string): string {
  let bin = ''
  for (const byte of new TextEncoder().encode(s)) bin += String.fromCharCode(byte)
  return btoa(bin)
}

export interface OverridesPr {
  number: number
  url?: string
  branch: string
}

/**
 * Change scale, timeout or environment the GitOps way: write the console's
 * patch file into the environment's overlay, list it in the overlay's
 * kustomization, commit both on a new branch and open a pull request. The
 * Function changes when the PR merges and Argo CD syncs — never before, and
 * never by patching the live object (selfHeal would put it back).
 */
export function useOpenOverridesPr() {
  return useMutation({
    mutationFn: async (
      { repo, branch = 'main', env, name, overrides, manifestPath = 'deploy' }: {
        repo: RepoRef
        branch?: string
        env: string
        name: string
        overrides: ScaleOverrides
        manifestPath?: string
      },
    ): Promise<OverridesPr> => {
      const dir = overlayDir(env, manifestPath)
      const kustomizationPath = `${dir}/kustomization.yaml`
      const patchPath = `${dir}/${overridesFileName(name)}`
      let kustomization: { content: string; sha: string }
      try {
        const f = await giteaClient.getFile(repo.org, repo.repo, branch, kustomizationPath)
        kustomization = { content: decodeContent(f), sha: f.sha }
      } catch (e) {
        if (statusOf(e) === 404) {
          throw new Error(`${kustomizationPath} does not exist in ${repo.org}/${repo.repo} — this repository has no overlay for ${env} to change.`)
        }
        throw e
      }
      const patched = withPatchReference(kustomization.content, overridesFileName(name))
      if (patched === null) {
        throw new Error(`${kustomizationPath} lists its patches in a form the console does not rewrite — edit it in Git.`)
      }
      const existing = await giteaClient.getFile(repo.org, repo.repo, branch, patchPath).catch(() => null)
      const files: Array<{ operation: 'create' | 'update'; path: string; content: string; sha?: string }> = [
        existing
          ? { operation: 'update', path: patchPath, content: encodeContent(overridesPatchYaml(name, overrides)), sha: existing.sha }
          : { operation: 'create', path: patchPath, content: encodeContent(overridesPatchYaml(name, overrides)) },
      ]
      if (patched !== kustomization.content) {
        files.push({ operation: 'update', path: kustomizationPath, content: encodeContent(patched), sha: kustomization.sha })
      }
      const head = overridesBranch(name, env)
      const summary = `scale ${overrides.minScale}–${overrides.maxScale}, timeout ${overrides.timeoutSeconds}s, target ${overrides.targetConcurrency}`
      await giteaClient.changeFiles(repo.org, repo.repo, branch, {
        message: `chore(${name}): ${summary} in ${env}`,
        files,
        new_branch: head,
      })
      const pr = await giteaClient.createPullRequest(repo.org, repo.repo, {
        head,
        base: branch,
        title: `${name}: ${summary} in ${env}`,
        body: [
          `Opened from Develop → Functions in the Adhar console.`,
          '',
          `Changes \`${patchPath}\`, a merge patch over the \`${name}\` Function in the \`${env}\` overlay:`,
          '',
          '```yaml',
          overridesPatchYaml(name, overrides).trimEnd(),
          '```',
          '',
          'The Function changes when this merges and Argo CD syncs the environment.',
        ].join('\n'),
      })
      return { number: pr.number, url: pr.html_url, branch: head }
    },
  })
}
