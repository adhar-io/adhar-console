import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { argocd, k8s } from '@adhar/api-clients'
import { useGiteaOrg, useTeamScope } from '@adhar/shell-ui'
import { giteaClient, unb64, useGiteaRepos } from './gitea.ts'
import {
  type AppXR,
  type ArgoAppLite,
  entitiesFromApplications,
  entityFromRepo,
  isPlatformRepo,
  mergeEntities,
  parseCatalogInfo,
  type PEntity,
  type PlatformSnapshot,
  tenancyApps,
} from './platform-model.ts'
import { defaultScope, type ScopeLens, type ScopeProject, type Scoped } from './scope.ts'
import { isAdrFile, type RemoteAdrFile } from './adr-sync.ts'

/**
 * Live platform data for the Design module — every read goes through the
 * console's authenticated BFF:
 *
 *   /api/workspace/{projects,teams,members,me}  tenancy (Keycloak-backed members)
 *   /api/k8s  (K8sClient.auto)                  Application XRs in adhar-system
 *   /api/svc/gitea                              repos + catalog-info.yaml
 *   /api/svc/argocd                             Argo CD Applications
 *   /api/notifications                          the organisation feed
 *
 * Each source is its own query so one being down never blanks the others;
 * callers render per-source errors instead of inventing data. Refreshes are
 * silent (`keepPreviousData`), never a spinner over data already on screen.
 */

const kube = k8s.K8sClient.auto()
const argo = argocd.ArgoCDClient.auto({ tool: 'argocd' })

const STALE = 30_000
const LIVE = { staleTime: STALE, refetchInterval: 60_000, placeholderData: keepPreviousData, retry: false } as const

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!res.ok) {
    let msg = `${url} → ${res.status}`
    try {
      const b = (await res.json()) as { error?: string; message?: string }
      if (b.message || b.error) msg = `${b.message ?? b.error} (${res.status})`
    } catch { /* keep status */ }
    throw new Error(msg)
  }
  return (await res.json()) as T
}

/* ───────────────────────── tenancy ───────────────────────── */

export interface WsProject extends ScopeProject {
  id: string
  argoProject?: string
  giteaOrg?: string
}
export interface WsTeam {
  id: string
  slug: string
  name: string
  description?: string
}
export interface WsMember {
  userId: string
  email: string
  name?: string
  role?: string
  teams: string[]
}
export interface WsMe {
  userId: string
  email: string
  name?: string
  teams?: string[]
  org?: { slug?: string; name?: string }
}

export function useWorkspaceProjects() {
  return useQuery({ queryKey: ['design', 'ws', 'projects'], queryFn: async () => (await getJson<{ items?: WsProject[] }>('/api/workspace/projects')).items ?? [], ...LIVE })
}
export function useWorkspaceTeams() {
  return useQuery({ queryKey: ['design', 'ws', 'teams'], queryFn: async () => (await getJson<{ items?: WsTeam[] }>('/api/workspace/teams')).items ?? [], ...LIVE })
}
export function useWorkspaceMembers(enabled = true) {
  return useQuery({ queryKey: ['design', 'ws', 'members'], queryFn: async () => (await getJson<{ items?: WsMember[] }>('/api/workspace/members')).items ?? [], enabled, ...LIVE })
}
export function useWorkspaceMe() {
  return useQuery({ queryKey: ['design', 'ws', 'me'], queryFn: () => getJson<WsMe>('/api/workspace/me'), staleTime: 5 * 60_000, retry: false })
}

export interface DesignScope {
  lens: ScopeLens
  projects: WsProject[]
  teams: WsTeam[]
  /** Scope for a new artifact. */
  initial: Scoped
  teamName(slug?: string): string | undefined
  projectName(slug?: string): string | undefined
}

/** The console's active team as a lens over design artifacts, plus the org's projects/teams. */
export function useDesignScope(): DesignScope {
  const { team, filtering } = useTeamScope()
  const projects = useWorkspaceProjects()
  const teams = useWorkspaceTeams()
  return useMemo(() => {
    const p = projects.data ?? []
    const t = teams.data ?? []
    const lens: ScopeLens = { filtering, team, projects: p }
    return {
      lens,
      projects: p,
      teams: t,
      initial: defaultScope(lens),
      teamName: (slug) => (slug ? t.find((x) => x.slug === slug)?.name ?? slug : undefined),
      projectName: (slug) => (slug ? p.find((x) => x.slug === slug)?.name ?? slug : undefined),
    }
  }, [projects.data, teams.data, team, filtering])
}

/* ───────────────────────── catalog ───────────────────────── */

const APPLICATION_GVR = { group: 'platform.adhar.io', version: 'v1alpha1', resource: 'applications', namespaced: true }

/** Same key and fetch as the host catalog, so the two share one cache entry. */
export function useApplicationXRs() {
  return useQuery({
    queryKey: ['catalog', 'live', 'applications'],
    queryFn: () => kube.listGeneric(undefined, APPLICATION_GVR, 'adhar-system'),
    ...LIVE,
  })
}

async function pool<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  }))
  return out
}

const MAX_DESCRIPTOR_REPOS = 60

export type SourceState = 'loading' | 'ok' | 'empty' | 'error'
export interface CatalogSource {
  id: 'applications' | 'gitea' | 'descriptors'
  label: string
  state: SourceState
  count: number
  error?: string
}

export interface PlatformCatalog {
  entities: PEntity[]
  sources: CatalogSource[]
  isLoading: boolean
  isFetching: boolean
  /** Every source has answered (ok, empty or error) — absence now means absent. */
  settled: boolean
  refetch(): void
}

function stateOf(q: { isLoading: boolean; isError: boolean }, count: number): SourceState {
  return q.isLoading ? 'loading' : q.isError ? 'error' : count ? 'ok' : 'empty'
}

/**
 * The service catalog as the host composes it — Application XRs and the
 * org's repositories — enriched with every repository's `catalog-info.yaml`
 * (Systems, APIs, Resources and relations).
 */
export function usePlatformCatalog(enabled = true): PlatformCatalog {
  const org = useGiteaOrg()
  const apps = useApplicationXRs()
  const repos = useGiteaRepos(enabled)
  const teamRepos = useMemo(() => (repos.data ?? []).filter((r) => !isPlatformRepo(r)).slice(0, MAX_DESCRIPTOR_REPOS), [repos.data])
  const descriptors = useQuery({
    queryKey: ['design', 'catalog-info', org, teamRepos.map((r) => `${r.name}@${r.default_branch}:${r.updated_at}`).join(',')],
    enabled: enabled && teamRepos.length > 0,
    queryFn: async () => {
      const lists = await pool(teamRepos, 6, async (r) => {
        for (const path of ['catalog-info.yaml', 'catalog-info.yml']) {
          try {
            const f = await giteaClient.getFile(org, r.name, r.default_branch, path)
            const text = f.encoding === 'base64' ? unb64(f.content) : f.content
            return parseCatalogInfo(text, { repo: r.name, branch: r.default_branch, path })
          } catch { /* not there — try the next name */ }
        }
        return [] as PEntity[]
      })
      return lists.flat()
    },
    ...LIVE,
    staleTime: 5 * 60_000,
  })
  return useMemo(() => {
    const fromApps = entitiesFromApplications((apps.data ?? []) as AppXR[])
    const fromRepos = teamRepos.map(entityFromRepo)
    const fromDesc = descriptors.data ?? []
    const entities = mergeEntities(fromDesc, fromApps, fromRepos)
    const sources: CatalogSource[] = [
      { id: 'applications', label: 'Applications (control plane)', state: stateOf(apps, fromApps.length), count: fromApps.length, error: apps.error?.message },
      { id: 'gitea', label: 'Gitea repositories', state: stateOf(repos, fromRepos.length), count: fromRepos.length, error: repos.error?.message },
      {
        id: 'descriptors',
        label: 'catalog-info.yaml',
        state: teamRepos.length ? stateOf(descriptors, fromDesc.length) : repos.isLoading ? 'loading' : 'empty',
        count: fromDesc.length,
        error: descriptors.error?.message,
      },
    ]
    return {
      entities,
      sources,
      settled: sources.every((s) => s.state !== 'loading') && !descriptors.isFetching,
      isLoading: apps.isLoading && repos.isLoading,
      isFetching: apps.isFetching || repos.isFetching || descriptors.isFetching,
      refetch: () => {
        void apps.refetch()
        void repos.refetch()
        void descriptors.refetch()
      },
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apps.data, apps.isLoading, apps.isError, apps.isFetching, repos.data, repos.isLoading, repos.isError, repos.isFetching, descriptors.data, descriptors.isLoading, descriptors.isError, descriptors.isFetching, teamRepos])
}

/* ───────────────────────── Argo CD ───────────────────────── */

export function useArgoApps(enabled = true) {
  return useQuery({
    queryKey: ['design', 'argocd', 'apps'],
    enabled,
    queryFn: async (): Promise<ArgoAppLite[]> =>
      (await argo.listApplications()).map((a) => ({
        name: a.metadata.name,
        project: a.spec.project,
        labels: a.metadata.labels,
        namespace: a.spec.destination.namespace,
        sync: a.status.sync.status,
        health: a.status.health.status,
      })),
    ...LIVE,
  })
}

/* ───────────────────────── Gitea: ADR folder + PRs ───────────────────────── */

/** Read every ADR file in a repo folder (with blob shas). */
export function useAdrFolder(repo: string | undefined, ref: string | undefined, folder: string, enabled = true) {
  const org = useGiteaOrg()
  return useQuery({
    queryKey: ['design', 'adr-folder', org, repo, ref, folder],
    enabled: enabled && !!repo && !!ref,
    retry: false,
    staleTime: 15_000,
    queryFn: async (): Promise<RemoteAdrFile[]> => {
      const tree = await giteaClient.listTree(org, repo!, ref!, folder.replace(/^\/+|\/+$/g, ''))
      const files = tree.filter((e) => e.type === 'blob' && isAdrFile(e.path)).slice(0, 300)
      return pool(files, 6, async (e) => {
        const f = await giteaClient.getFile(org, repo!, ref!, e.path)
        return { path: e.path, sha: f.sha ?? e.sha, text: f.encoding === 'base64' ? unb64(f.content) : f.content }
      })
    },
  })
}

/** Read one file at a ref; `null` when it does not exist. */
export async function readRepoFile(org: string, repo: string, ref: string, path: string): Promise<{ text: string; sha: string } | null> {
  try {
    const f = await giteaClient.getFile(org, repo, ref, path)
    return { text: f.encoding === 'base64' ? unb64(f.content) : f.content, sha: f.sha }
  } catch (e) {
    if (/404|not.?found/i.test(String((e as Error).message))) return null
    throw e
  }
}

export function useRepoFile(repo: string | undefined, ref: string | undefined, path: string | undefined, enabled = true) {
  const org = useGiteaOrg()
  return useQuery({
    queryKey: ['design', 'repo-file', org, repo, ref, path],
    enabled: enabled && !!repo && !!ref && !!path,
    retry: false,
    staleTime: 15_000,
    queryFn: () => readRepoFile(org, repo!, ref!, path!),
  })
}

export function useRepoInfo(repo: string | undefined) {
  const org = useGiteaOrg()
  return useQuery({ queryKey: ['design', 'repo', org, repo], enabled: !!repo, retry: false, staleTime: 5 * 60_000, queryFn: () => giteaClient.getRepo(org, repo!) })
}

/** Console deep link to a pull request (Develop → Pull requests). */
export function prHref(repo: string, number: number): string {
  return `/develop?section=prs&pr=${encodeURIComponent(`${repo}/${number}`)}`
}

/* ───────────────────────── Plane ───────────────────────── */

// Work items live in data/plane.ts (one implementation for the module).

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/* ───────────────────────── notifications ───────────────────────── */

/**
 * Post to the organisation's notification feed (`/api/notifications`,
 * `broadcast: true` — the API cannot address individual users). Resolves
 * false when the store is unavailable rather than throwing.
 */
export async function notifyOrg(n: { title: string; description?: string; href?: string; key?: string; kind?: 'info' | 'success' | 'warning' }): Promise<boolean> {
  try {
    const res = await fetch('/api/notifications', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ ...n, kind: n.kind ?? 'info', source: 'workspace', broadcast: true }),
    })
    return res.ok
  } catch {
    return false
  }
}

/* ───────────────────────── snapshot for generators ───────────────────────── */

export interface SnapshotState {
  data: PlatformSnapshot
  catalog: PlatformCatalog
  argoError?: string
  tenancyError?: string
  argoLoading: boolean
  ready: boolean
  refetch(): void
}

/** Everything the diagram generators read, from live sources. */
export function usePlatformSnapshot(enabled = true): SnapshotState {
  const catalog = usePlatformCatalog(enabled)
  const argoApps = useArgoApps(enabled)
  const projects = useWorkspaceProjects()
  const teams = useWorkspaceTeams()
  const me = useWorkspaceMe()
  const org = useGiteaOrg()
  return useMemo(() => {
    const apps = argoApps.data ?? []
    const data: PlatformSnapshot = {
      entities: catalog.entities,
      argoApps: apps,
      tenancy: {
        org: { slug: me.data?.org?.slug ?? org, name: me.data?.org?.name },
        teams: (teams.data ?? []).map((t) => ({ slug: t.slug, name: t.name })),
        projects: (projects.data ?? []).map((p) => ({ slug: p.slug, name: p.name, teams: p.teams })),
        apps: tenancyApps(catalog.entities, apps),
      },
    }
    return {
      data,
      catalog,
      argoError: argoApps.error?.message,
      tenancyError: projects.error?.message ?? teams.error?.message,
      argoLoading: argoApps.isLoading,
      ready: !catalog.isLoading && !argoApps.isLoading && !projects.isLoading && !teams.isLoading,
      refetch: () => {
        catalog.refetch()
        void argoApps.refetch()
        void projects.refetch()
        void teams.refetch()
      },
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, argoApps.data, argoApps.error, argoApps.isLoading, projects.data, projects.error, projects.isLoading, teams.data, teams.error, teams.isLoading, me.data, org])
}
