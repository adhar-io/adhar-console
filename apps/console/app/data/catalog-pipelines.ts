import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { k8s } from '@adhar-console/api-clients'
import type { Entity } from './catalog.ts'

/**
 * Tekton PipelineRuns for one catalog entity — the Deployment tab's
 * "Pipeline runs" widget.
 *
 * A PipelineRun does not point at a catalog entity, so the match is made the
 * way a person would make it, most certain first:
 *   1. the entity names its pipeline (`adhar.io/ci-pipeline` / `adhar.io/ci`)
 *      and the run carries that pipeline's label;
 *   2. the run is labelled with the component (`adhar.io/component`,
 *      `app.kubernetes.io/name`);
 *   3. a run parameter names the entity's repository;
 *   4. the run's name starts with the entity name (`cart-run-abc12`).
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
  /** How many tasks finished out of how many, from the child references. */
  tasks?: { done: number; total: number }
}

interface RawRun {
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

export function matchRun(run: RawRun, entity: Entity, repoUrl?: string): boolean {
  const name = entity.metadata.name.toLowerCase()
  const ann = entity.metadata.annotations ?? {}
  const labels = run.metadata?.labels ?? {}
  const ci = (ann['adhar.io/ci-pipeline'] ?? ann['adhar.io/ci'] ?? '').trim()
  const pipeline = (labels['tekton.dev/pipeline'] ?? run.spec?.pipelineRef?.name ?? '').toLowerCase()
  if (ci && !/^https?:/.test(ci) && pipeline === ci.toLowerCase()) return true
  const comp = (labels['adhar.io/component'] ?? labels['app.kubernetes.io/name'] ?? labels['adhar.io/service'] ?? '').toLowerCase()
  if (comp && comp === name) return true
  const repo = repoKey(repoUrl)
  if (repo) {
    const p = paramValue(run, 'repo-url', 'git-url', 'repoUrl', 'gitUrl', 'url', 'repository')
    if (p && repoKey(p) === repo) return true
  }
  const rn = (run.metadata?.name ?? '').toLowerCase()
  return rn === name || rn.startsWith(`${name}-`)
}

export function summarise(run: RawRun): PipelineRunSummary {
  const { state, reason, message } = stateOf(run)
  const startedAt = run.status?.startTime ?? run.metadata?.creationTimestamp
  const completedAt = run.status?.completionTime
  const start = startedAt ? Date.parse(startedAt) : NaN
  const end = completedAt ? Date.parse(completedAt) : state === 'running' ? Date.now() : NaN
  const durationSecs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 1000)) : undefined
  const labels = run.metadata?.labels ?? {}
  const ann = run.metadata?.annotations ?? {}
  const total = run.status?.pipelineSpec?.tasks?.length
  const done = run.status?.childReferences?.length
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
    branch: paramValue(run, 'git-branch', 'branch', 'revision') ?? labels['tekton.dev/git-branch'] ?? ann['tekton.dev/git-branch'],
    commit: paramValue(run, 'git-revision', 'commit', 'sha') ?? labels['tekton.dev/git-revision'] ?? ann['tekton.dev/git-revision'],
    ...(typeof total === 'number' && typeof done === 'number' ? { tasks: { done: Math.min(done, total), total } } : {}),
  }
}

export function usePipelineRuns(entity: Entity, repoUrl: string | undefined, enabled = true): {
  runs: PipelineRunSummary[]
  isLoading: boolean
  isError: boolean
  /** The CRD is not installed (404 on the list). */
  notInstalled: boolean
} {
  const ns = (entity.metadata.annotations?.['adhar.io/namespace'] ?? '').trim() || undefined
  const q = useQuery({
    // One list per namespace serves every entity in it.
    queryKey: ['catalog', 'tekton', 'pipelineruns', ns ?? '*'],
    queryFn: () => client.listGeneric(undefined, PIPELINERUNS_GVR, ns),
    enabled,
    staleTime: REFRESH_MS,
    refetchInterval: enabled ? REFRESH_MS : false,
    retry: 1,
  })
  const runs = useMemo(() => {
    const all = (q.data ?? []) as unknown as RawRun[]
    return all
      .filter((r) => matchRun(r, entity, repoUrl))
      .map(summarise)
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
      .slice(0, 8)
  }, [q.data, entity, repoUrl])
  const status = (q.error as { status?: number } | null)?.status
  return { runs, isLoading: q.isLoading, isError: q.isError && status !== 404, notInstalled: status === 404 }
}
