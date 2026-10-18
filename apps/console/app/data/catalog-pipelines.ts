import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { k8s } from '@adhar/api-clients'
import type { Entity } from './catalog.ts'
import { taskProgress, type TaskProgress } from './pipeline-progress.ts'

/**
 * Tekton PipelineRuns for one catalog entity — the Deployment tab's
 * "Pipeline runs" widget.
 *
 * A PipelineRun does not point at a catalog entity, so the match is made the
 * way a person would make it, most certain first:
 *   1. the run is labelled with the app (`adhar.io/app` — what the platform's
 *      `app-ci` trigger sets to the repository name — or `adhar.io/component`,
 *      `app.kubernetes.io/name`, `adhar.io/service`);
 *   2. the entity names its pipeline (`adhar.io/ci-pipeline` / `adhar.io/ci`)
 *      and the run carries that pipeline's label — unless the run is labelled
 *      for a DIFFERENT app, because `app-ci` is one pipeline shared by every
 *      service and would otherwise hand each of them everyone's runs;
 *   3. a run parameter names the entity's repository (`repo-url` as a URL, or
 *      `repo-name` as the bare name the app-ci trigger passes);
 *   4. the run's name starts with the entity or repository name
 *      (`cart-abc12`, or the trigger's `app-ci-cart-abc12`).
 *
 * The app-ci EventListener creates its runs in the platform namespace, not
 * the namespace the service deploys to, so both are read.
 * Nothing matched is an honest empty state, never another service's runs.
 */

const PIPELINERUNS_GVR: k8s.GVR = { group: 'tekton.dev', version: 'v1', resource: 'pipelineruns', namespaced: true }
const client = k8s.K8sClient.auto()
const REFRESH_MS = 30_000

export type RunState = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'pending'

export interface PipelineRunSummary {
  name: string
  namespace: string
  pipeline?: string
  state: RunState
  reason?: string
  message?: string
  startedAt?: string
  completedAt?: string
  /** Seconds, when both timestamps exist (or from start until now while running). */
  durationSecs?: number
  /** Git details the triggers put on the run, when present. */
  branch?: string
  commit?: string
  /**
   * What started the run: a push to the default branch (`app-push`), a pull
   * request labelled `preview` (`pr-preview-build`), or a person / another
   * controller creating it directly.
   */
  trigger: 'push' | 'pull-request' | 'manual'
  /** The repository the run built (the trigger's `repo-name`). */
  repo?: string
  /** Terminal tasks out of the whole graph, with failures and skips beside it (see pipeline-progress.ts). */
  tasks?: TaskProgress
}

export interface RawRun {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string>; creationTimestamp?: string }
  spec?: { pipelineRef?: { name?: string }; params?: Array<{ name?: string; value?: unknown }> }
  status?: {
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>
    startTime?: string
    completionTime?: string
    childReferences?: Array<{ name?: string }>
    pipelineSpec?: { tasks?: unknown[] }
  }
}

function stateOf(run: RawRun): { state: RunState; reason?: string; message?: string } {
  const c = (run.status?.conditions ?? []).find((x) => x.type === 'Succeeded')
  if (!c) return { state: run.status?.startTime ? 'running' : 'pending' }
  const reason = c.reason
  if (c.status === 'True') return { state: 'succeeded', reason, message: c.message }
  if (c.status === 'False') return { state: /cancel/i.test(reason ?? '') ? 'cancelled' : 'failed', reason, message: c.message }
  return { state: 'running', reason, message: c.message }
}

function paramValue(run: RawRun, ...names: string[]): string | undefined {
  for (const p of run.spec?.params ?? []) {
    if (p.name && names.includes(p.name) && typeof p.value === 'string') return p.value
  }
  return undefined
}

/** `https://gitea.x/org/repo.git` and `https://gitea.x/org/repo` are the same repository. */
function repoKey(url: string | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    return u.pathname.replace(/\.git$/, '').replace(/\/$/, '').toLowerCase()
  } catch {
    return url.replace(/\.git$/, '').toLowerCase()
  }
}

/** The repository's own name — the last path segment of its URL. */
function repoName(url: string | undefined): string {
  return repoKey(url).split('/').filter(Boolean).pop() ?? ''
}

/** Prefixes the platform's Tekton triggers put before the repository name. */
const RUN_PREFIXES = ['', 'app-ci-', 'app-pr-ci-']

export function matchRun(run: RawRun, entity: Entity, repoUrl?: string): boolean {
  const ann = entity.metadata.annotations ?? {}
  // The names this entity answers to: itself, and its repository.
  const names = new Set([entity.metadata.name.toLowerCase(), repoName(repoUrl)].filter(Boolean))
  const labels = run.metadata?.labels ?? {}

  const app = (labels['adhar.io/app'] ?? labels['adhar.io/component'] ?? labels['app.kubernetes.io/name'] ?? labels['adhar.io/service'] ?? '').toLowerCase()
  if (app) return names.has(app)

  const ci = (ann['adhar.io/ci-pipeline'] ?? ann['adhar.io/ci'] ?? '').trim()
  const pipeline = (labels['tekton.dev/pipeline'] ?? run.spec?.pipelineRef?.name ?? '').toLowerCase()
  if (ci && !/^https?:/.test(ci) && pipeline === ci.toLowerCase()) return true

  const repo = repoKey(repoUrl)
  if (repo) {
    const p = paramValue(run, 'repo-url', 'git-url', 'repoUrl', 'gitUrl', 'url', 'repository')
    if (p && repoKey(p) === repo) return true
  }
  const bare = paramValue(run, 'repo-name', 'repoName', 'app-name', 'app')
  if (bare && names.has(bare.toLowerCase())) return true

  const rn = (run.metadata?.name ?? '').toLowerCase()
  for (const n of names) {
    for (const prefix of RUN_PREFIXES) {
      const stem = `${prefix}${n}`
      if (rn === stem || rn.startsWith(`${stem}-`)) return true
    }
  }
  return false
}

const SHA = /^[0-9a-f]{7,40}$/i

export function summarise(run: RawRun): PipelineRunSummary {
  const { state, reason, message } = stateOf(run)
  const startedAt = run.status?.startTime ?? run.metadata?.creationTimestamp
  const completedAt = run.status?.completionTime
  const start = startedAt ? Date.parse(startedAt) : NaN
  const end = completedAt ? Date.parse(completedAt) : state === 'running' ? Date.now() : NaN
  const durationSecs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 1000)) : undefined
  const labels = run.metadata?.labels ?? {}
  const ann = run.metadata?.annotations ?? {}
  // The platform's app-ci trigger passes the pushed commit as `revision` and,
  // for a pull request, its head branch as `git-ref`. `revision` is a SHA —
  // it used to be read as the BRANCH, so every run showed a hash in the
  // branch chip and no commit at all.
  const rev = paramValue(run, 'git-revision', 'commit', 'sha', 'revision') ?? labels['tekton.dev/git-revision'] ?? ann['tekton.dev/git-revision']
  const commit = rev && SHA.test(rev) ? rev : undefined
  const namedRef = paramValue(run, 'git-ref', 'git-branch', 'branch') ?? labels['tekton.dev/git-branch'] ?? ann['tekton.dev/git-branch'] ?? (rev && !SHA.test(rev) ? rev : undefined)
  const branch = namedRef?.replace(/^refs\/heads\//, '')
  const trig = labels['triggers.tekton.dev/trigger'] ?? ''
  const trigger: PipelineRunSummary['trigger'] =
    labels['adhar.io/preview'] === 'true' || trig === 'pr-preview-build' || paramValue(run, 'git-ref') !== undefined
      ? 'pull-request'
      : trig || labels['triggers.tekton.dev/eventlistener'] || /^app-ci-/.test(run.metadata?.name ?? '')
        ? 'push'
        : 'manual'
  const tasks = taskProgress(message, run.status?.pipelineSpec?.tasks?.length, run.status?.childReferences?.length)
  return {
    name: run.metadata?.name ?? '',
    namespace: run.metadata?.namespace ?? '',
    pipeline: labels['tekton.dev/pipeline'] ?? run.spec?.pipelineRef?.name,
    state,
    reason,
    message,
    startedAt,
    completedAt,
    durationSecs,
    branch: branch ?? (trigger === 'push' ? 'main' : undefined),
    commit,
    trigger,
    repo: paramValue(run, 'repo-name', 'repoName') ?? labels['adhar.io/app'],
    ...(tasks ? { tasks } : {}),
  }
}

/** Where the platform's Tekton EventListeners create PipelineRuns. */
export const CI_NAMESPACE = 'adhar-system'

export function usePipelineRuns(entity: Entity, repoUrl: string | undefined, enabled = true, runsIn?: string): {
  runs: PipelineRunSummary[]
  isLoading: boolean
  isError: boolean
  /** The CRD is not installed (404 on the list). */
  notInstalled: boolean
} {
  const ns = (runsIn ?? '').trim() || (entity.metadata.annotations?.['adhar.io/namespace'] ?? '').trim() || undefined
  // The service's own namespace (runs a team creates itself) plus the CI
  // namespace (runs the platform's triggers create). No annotation: the whole
  // cluster, which covers both.
  const namespaces = ns ? [...new Set([ns, CI_NAMESPACE])] : [undefined]
  const q = useQuery({
    // One list per namespace set serves every entity that shares it.
    queryKey: ['catalog', 'tekton', 'pipelineruns', namespaces.map((n) => n ?? '*').join(',')],
    queryFn: async () => {
      const results = await Promise.allSettled(namespaces.map((n) => client.listGeneric(undefined, PIPELINERUNS_GVR, n)))
      const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof client.listGeneric>>> => r.status === 'fulfilled')
      // One readable namespace is enough; only fail when none answered.
      if (!ok.length) throw (results[0] as PromiseRejectedResult).reason
      return ok.flatMap((r) => r.value)
    },
    enabled,
    staleTime: REFRESH_MS,
    refetchInterval: enabled ? REFRESH_MS : false,
    // The namespace set settles once Argo CD answers; keep the previous list
    // on screen meanwhile rather than flashing back to a loading state.
    placeholderData: keepPreviousData,
    retry: 1,
  })
  const runs = useMemo(() => {
    const all = (q.data ?? []) as unknown as RawRun[]
    const seen = new Set<string>()
    return all
      .filter((r) => {
        const key = `${r.metadata?.namespace}/${r.metadata?.name}`
        if (seen.has(key)) return false
        seen.add(key)
        return matchRun(r, entity, repoUrl)
      })
      .map(summarise)
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
      .slice(0, 8)
  }, [q.data, entity, repoUrl])
  const status = (q.error as { status?: number } | null)?.status
  return { runs, isLoading: q.isLoading, isError: q.isError && !q.data && status !== 404, notInstalled: status === 404 && !q.data }
}
