import { useQuery } from '@tanstack/react-query'
import { coder, gitea, type k8s } from '@adhar-console/api-clients'
import { useGiteaOrg } from '@adhar-console/shell-ui'
import { useCRD } from './k8s.ts'

/**
 * Data layer for the **Delivery flow** value-stream view.
 *
 * The flow stitches together every tool that touches a change on its way from
 * a commit to production, so this module reaches several backends:
 *
 *  - Gitea (Code + Pull Request) via the BFF tool proxy
 *    (`/api/svc/gitea/api/v1/…`) through the shared `gitea` client.
 *  - Coder (Dev loop) via the `coder` tool proxy.
 *  - Tekton PipelineRuns / kpack Builds (Build) as k8s CRDs read through the
 *    authenticated k8s gateway (`/api/k8s/…`) via the module's `useCRD`.
 *
 * ArgoCD (GitOps sync + preview envs), Kargo (Promotion) and Argo Rollouts
 * (Rollout) reuse the existing hooks in `./delivery.ts` — this file only adds
 * the sources those hooks don't already cover. Every hook errors honestly
 * (no fake fallbacks); the view turns errors/empties into muted, truthful
 * "not connected" / "no data" / "not configured" stage nodes.
 */

export const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' })
export const coderClient = coder.CoderClient.auto({ tool: 'coder' })

/**
 * Gitea org — a per-install identifier served by the BFF at `/api/config` and
 * read through `useGiteaOrg()` (real default `adhar`). Mirrors the Develop
 * module; each Gitea hook resolves it locally and threads it through its
 * `queryKey` + `queryFn` (never the old hardcoded `acme`).
 */

const REFRESH_MS = 15_000
const SLOW_MS = 30_000

/* ─────────── extra CRDs (Build stage) ─────────── */

/**
 * GVRs the flow reads that the shared clients don't model. Both are optional
 * on any given cluster — a 404 from the apiserver renders an honest
 * "not configured" Build node rather than a fabricated success.
 */
export const FLOW_GVRS = {
  /** Tekton PipelineRuns — the primary CI signal. */
  tektonPipelineRuns: {
    group: 'tekton.dev',
    version: 'v1',
    resource: 'pipelineruns',
    namespaced: true,
  },
  /** kpack Builds — the buildpacks-based alternative. */
  kpackBuilds: {
    group: 'kpack.io',
    version: 'v1alpha2',
    resource: 'builds',
    namespaced: true,
  },
} as const

/* ─────────── Gitea: Code + Pull Request ─────────── */

export function useGiteaRepos() {
  const org = useGiteaOrg()
  return useQuery({
    queryKey: ['flow', 'gitea', 'repos', org],
    queryFn: () => giteaClient.listRepos(org),
    staleTime: SLOW_MS,
    retry: false,
  })
}

export function useGiteaCommits(repo?: string, ref?: string, limit = 5) {
  const org = useGiteaOrg()
  return useQuery({
    queryKey: ['flow', 'gitea', 'commits', org, repo, ref, limit],
    queryFn: () => giteaClient.listCommits(org, repo!, ref, limit),
    enabled: !!repo,
    refetchInterval: REFRESH_MS,
    retry: false,
  })
}

export function useGiteaPulls(repo?: string, state: 'open' | 'closed' | 'all' = 'all') {
  const org = useGiteaOrg()
  return useQuery({
    queryKey: ['flow', 'gitea', 'pulls', org, repo, state],
    queryFn: () => giteaClient.listPullRequests(org, repo!, state),
    enabled: !!repo,
    refetchInterval: REFRESH_MS,
    retry: false,
  })
}

/* ─────────── Coder: Dev loop ─────────── */

export function useCoderWorkspaces() {
  return useQuery({
    queryKey: ['flow', 'coder', 'workspaces'],
    queryFn: () => coderClient.listWorkspaces(),
    refetchInterval: REFRESH_MS,
    retry: false,
  })
}

/* ─────────── Build: Tekton / kpack CRDs ─────────── */

/** Tekton PipelineRuns in a namespace (disabled until a namespace is known). */
export function useTektonRuns(namespace?: string) {
  return useCRD(FLOW_GVRS.tektonPipelineRuns, namespace, !!namespace)
}

/** kpack Builds in a namespace (disabled until a namespace is known). */
export function useKpackBuilds(namespace?: string) {
  return useCRD(FLOW_GVRS.kpackBuilds, namespace, !!namespace)
}

/* ─────────── shared helpers ─────────── */

export type CRDObject = k8s.Generic

/** Newest-first by creationTimestamp. */
export function newestFirst(a: CRDObject, b: CRDObject): number {
  return (
    new Date(b.metadata?.creationTimestamp ?? 0).getTime() -
    new Date(a.metadata?.creationTimestamp ?? 0).getTime()
  )
}

/** Whether a react-query error is an apiserver 404 (CRD not installed). */
export function isNotInstalled(err: unknown): boolean {
  return (err as { status?: number })?.status === 404
}

/** Human duration between two ISO timestamps; open-ended runs tick to now. */
export function duration(start?: string, end?: string): string {
  if (!start) return '—'
  const startMs = new Date(start).getTime()
  if (!Number.isFinite(startMs)) return '—'
  const endMs = end ? new Date(end).getTime() : Date.now()
  let s = Math.max(0, Math.floor((endMs - startMs) / 1000))
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}
