import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { argocd, gitea } from '@adhar/api-clients'
import type { Entity } from './catalog.ts'
import { applicationXRsQuery } from './catalog-app-delete.ts'
import { promInstant } from './prom-instant.ts'
import {
  type DeploySource,
  deploySourcesFor,
  findWorkload,
  KUSTOMIZATION_FILES,
  kustomizationResources,
  type ManifestBase,
  type PendingFix,
  type RepoFile,
  resolveRel,
} from './scorecard-fix.ts'

/**
 * Browser-side I/O for scorecard fixes: reading descriptors and deploy
 * manifests from Gitea (through the console's `/api/svc/gitea` proxy, as every
 * other Gitea read does), committing through `POST /api/scorecards/fix`, and
 * remembering which fixes are still pending.
 */

const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' })
const argocdClient = argocd.ArgoCDClient.auto({ tool: 'argocd' })

function unb64(s: string): string {
  const bin = atob(s.replace(/\s/g, ''))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

function status(e: unknown): number | undefined {
  return (e as { status?: number } | null)?.status
}

async function readRepoFile(org: string, repo: string, ref: string, path: string): Promise<RepoFile | null> {
  try {
    const f = await giteaClient.getFile(org, repo, ref, path)
    return { path, text: f.encoding === 'base64' ? unb64(f.content) : f.content, sha: f.sha }
  } catch (e) {
    if (status(e) === 404) return null
    throw e
  }
}

/* ─────────── catalog-info.yaml (descriptor) ─────────── */

// Descriptor reads moved into the catalog data layer so the catalog and the
// Scorecards share one fetch per repository (catalog-descriptor-io.ts).
export {
  type Descriptor,
  descriptorKey,
  descriptorTarget,
  type DescriptorTarget,
  useDescriptor,
} from './catalog-descriptor-io.ts'

/* ─────────── deploy manifests ─────────── */

/** Argo CD applications (shared cache with the catalog) + the Application XRs. */
export function useDeploySources(entity: Entity | undefined, enabled: boolean): { sources: DeploySource[]; isLoading: boolean; argoNamespace?: string } {
  const apps = useQuery({
    queryKey: ['catalog', 'argocd', 'apps'],
    queryFn: () => argocdClient.listApplications(),
    enabled,
    staleTime: 60_000,
    retry: false,
  })
  const xrs = useQuery({ ...applicationXRsQuery, enabled, staleTime: 60_000, retry: false })
  return useMemo(() => {
    if (!entity) return { sources: [], isLoading: false }
    const name = entity.metadata.name
    const xr = (xrs.data ?? []).find((a) => a.metadata?.name?.toLowerCase() === name.toLowerCase()) as
      | { spec?: { parameters?: Record<string, unknown> } }
      | undefined
    const argoName = entity.metadata.annotations?.['argocd/app-name']
    const list = apps.data ?? []
    const sources = deploySourcesFor(name, list, xr, argoName)
    const prod = list.find((a) => (a.metadata.labels?.['adhar.io/application'] ?? a.metadata.name).toLowerCase() === name.toLowerCase() &&
      ['prod', 'production', 'live'].includes((a.metadata.labels?.['adhar.io/environment'] ?? '').toLowerCase()))
    const any = list.find((a) => (a.metadata.labels?.['adhar.io/application'] ?? a.metadata.name).toLowerCase() === name.toLowerCase())
    return {
      sources,
      isLoading: apps.isLoading || xrs.isLoading,
      argoNamespace: (prod ?? any)?.spec.destination.namespace || undefined,
    }
  }, [entity, apps.data, apps.isLoading, xrs.data, xrs.isLoading])
}

export interface LocatedBase extends ManifestBase {
  org: string
  repo: string
  /** Branch the files were read from (the repository default unless the app pins one). */
  ref: string
  /** The path Argo CD renders (often an overlay that points at `dir`). */
  renderedPath: string
}

const YAML = /\.ya?ml$/i

/**
 * Walk from the path Argo CD renders to the directory that holds the
 * workload: follow `resources`/`bases` directories of each kustomization
 * (overlay → base), at most a few levels deep, and stop at the first directory
 * whose manifests declare the Deployment/StatefulSet. Fixes land there, so
 * every environment that builds on the base picks them up.
 */
export async function locateManifestBase(source: DeploySource, workloadName: string): Promise<LocatedBase | null> {
  const repo = await giteaClient.getRepo(source.org, source.repo)
  const ref = source.ref || repo.default_branch || 'main'
  const queue: Array<{ dir: string; depth: number }> = [{ dir: source.path, depth: 0 }]
  const seen = new Set<string>()
  while (queue.length) {
    const { dir, depth } = queue.shift()!
    if (seen.has(dir) || depth > 4) continue
    seen.add(dir)
    let entries: Array<{ path: string; type: string; name?: string }>
    try {
      entries = (await giteaClient.listTree(source.org, source.repo, ref, dir)) as Array<{ path: string; type: string; name?: string }>
    } catch (e) {
      if (status(e) === 404) continue
      throw e
    }
    const base = (p: string) => p.split('/').pop() ?? p
    const kEntry = entries.find((e) => e.type !== 'tree' && KUSTOMIZATION_FILES.includes(base(e.path)))
    const kustomization = kEntry ? await readRepoFile(source.org, source.repo, ref, kEntry.path) : null
    const listed = kustomization ? kustomizationResources(kustomization.text) : null
    const fileNames = listed
      ? listed.filter((r) => YAML.test(r)).map((r) => resolveRel(dir, r)).filter((p): p is string => !!p)
      : entries.filter((e) => e.type !== 'tree' && YAML.test(e.path) && !KUSTOMIZATION_FILES.includes(base(e.path))).map((e) => e.path)
    const files = (await Promise.all(fileNames.slice(0, 25).map((p) => readRepoFile(source.org, source.repo, ref, p))))
      .filter((f): f is RepoFile => !!f)
    for (const f of files) {
      const w = findWorkload(f.text, workloadName)
      if (w && (w.name.toLowerCase() === workloadName.toLowerCase() || files.filter((x) => findWorkload(x.text, workloadName)).length === 1)) {
        return {
          org: source.org,
          repo: source.repo,
          ref,
          renderedPath: source.path,
          dir,
          ...(kustomization ? { kustomization } : {}),
          workloadFile: f,
          workload: w,
          others: files.filter((x) => x.path !== f.path),
        }
      }
    }
    for (const r of listed ?? []) {
      if (YAML.test(r)) continue
      const next = resolveRel(dir, r)
      if (next !== null) queue.push({ dir: next, depth: depth + 1 })
    }
  }
  return null
}

/* ─────────── observed usage (Prometheus, best effort) ─────────── */

/**
 * Peak per-container CPU (cores, 1 h rate) and working-set memory over the last
 * day for the workload's pods. Null when Prometheus is absent or has nothing —
 * the dialog then proposes conservative defaults and says so.
 */
export async function observedUsage(namespace: string, workload: string): Promise<{ cpuCores: number | null; memoryBytes: number | null } | null> {
  // Both are DNS names; only `.` needs escaping (twice: PromQL string, then regex).
  if (!/^[a-z0-9.-]+$/.test(namespace) || !/^[a-z0-9.-]+$/.test(workload)) return null
  // Anchored: `<name>-<rs hash>-<pod hash>` (Deployment) or `<name>-<ordinal>` (StatefulSet),
  // so `cart` never picks up `cart-db-0`.
  const pod = `^${workload.replace(/\./g, '\\\\.')}-([a-z0-9]{6,10}-[a-z0-9]{5}|[0-9]+)$`
  const sel = `namespace="${namespace}",pod=~"${pod}",container!="",container!="POD"`
  try {
    const [cpu, mem] = await Promise.all([
      promInstant(`max(max_over_time(rate(container_cpu_usage_seconds_total{${sel}}[5m])[1d:5m]))`),
      promInstant(`max(max_over_time(container_memory_working_set_bytes{${sel}}[1d]))`),
    ])
    const c = cpu[0]?.value
    const m = mem[0]?.value
    if (!(c > 0) && !(m > 0)) return null
    return { cpuCores: c > 0 ? c : null, memoryBytes: m > 0 ? m : null }
  } catch {
    return null
  }
}

/* ─────────── committing ─────────── */

export interface FixFilePayload {
  path: string
  content: string
  baseSha: string | null
}

export interface ApplyFixInput {
  entityRef: string
  owner?: string
  org: string
  repo: string
  branch?: string
  mode: 'pr' | 'commit'
  newBranch?: string
  title: string
  description?: string
  descriptorPath?: string
  files: FixFilePayload[]
}

export type ApplyFixResult =
  | { ok: true; mode: 'pr' | 'commit'; base: string; branch: string; commit?: string; pr?: { number: number; url?: string } }
  | { ok: false; error: string; detail: string; status: number }

export async function applyFix(input: ApplyFixInput): Promise<ApplyFixResult> {
  try {
    const res = await fetch('/api/scorecards/fix', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input),
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.ok && body.ok === true) return body as unknown as ApplyFixResult
    return {
      ok: false,
      status: res.status,
      error: String(body.error ?? 'failed'),
      detail: String(body.detail ?? `The console answered ${res.status}.`),
    }
  } catch (e) {
    return { ok: false, status: 0, error: 'network', detail: e instanceof Error ? e.message : String(e) }
  }
}

/** `POST /api/scorecards/rerun` with the service it is for (the scorer still grades everything). */
export async function rerunFor(service: string): Promise<{ started: boolean; error?: string; detail?: string }> {
  try {
    const res = await fetch('/api/scorecards/rerun', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ service }),
    })
    const body = (await res.json().catch(() => ({}))) as { started?: boolean; error?: string; detail?: string }
    return { started: body.started === true, ...(body.error ? { error: body.error } : {}), ...(body.detail ? { detail: body.detail } : {}) }
  } catch (e) {
    return { started: false, error: 'network', detail: e instanceof Error ? e.message : String(e) }
  }
}

/* ─────────── pull-request state ─────────── */

export interface PrState {
  state: 'open' | 'merged' | 'closed'
  url?: string
}

export function prStateQuery(p: Pick<PendingFix, 'org' | 'repo' | 'pr'>, poll: number | false) {
  return {
    queryKey: ['scorecard-fix', 'pr', p.org, p.repo, p.pr?.number ?? 0] as const,
    queryFn: async (): Promise<PrState> => {
      const pr = await giteaClient.getPullRequest(p.org, p.repo, p.pr!.number)
      return { state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open', url: pr.html_url }
    },
    enabled: !!p.pr,
    refetchInterval: poll,
    staleTime: 10_000,
    retry: false,
  }
}

/* ─────────── pending fixes (per browser) ─────────── */

const PENDING_KEY = 'adhar.scorecards.pending-fixes.v1'
const listeners = new Set<() => void>()
let cache: PendingFix[] | null = null

function read(): PendingFix[] {
  if (cache) return cache
  try {
    const raw = globalThis.localStorage?.getItem(PENDING_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    cache = Array.isArray(parsed) ? (parsed as PendingFix[]) : []
  } catch {
    cache = []
  }
  return cache
}

function write(next: PendingFix[]) {
  cache = next
  try {
    globalThis.localStorage?.setItem(PENDING_KEY, JSON.stringify(next))
  } catch {
    // Quota / private mode: pending state lives for this page only.
  }
  for (const l of listeners) l()
}

const EMPTY: PendingFix[] = []

export const pendingStore = {
  list: read,
  add(p: PendingFix) {
    write([...read().filter((x) => x.id !== p.id), p])
  },
  update(id: string, patch: Partial<PendingFix>) {
    write(read().map((x) => (x.id === id ? { ...x, ...patch } : x)))
  },
  remove(id: string) {
    write(read().filter((x) => x.id !== id))
  },
  replace(next: PendingFix[]) {
    if (next.length !== read().length || next.some((x, i) => x !== read()[i])) write(next)
  },
}

export function usePendingFixes(): PendingFix[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    read,
    () => EMPTY,
  )
}

/* ─────────── owner choices ─────────── */

/** Teams the active organisation has (`GET /api/teams`) ∪ catalog Groups. */
export function useOwnerOptions(catalogGroups: readonly string[]): string[] {
  const [teams, setTeams] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    fetch('/api/teams', { credentials: 'include', headers: { accept: 'application/json' } })
      .then(async (res) => {
        const ct = res.headers.get('content-type') ?? ''
        if (!res.ok || !ct.includes('application/json')) return
        const body = (await res.json()) as { teams?: Array<{ name?: string }> }
        if (alive && Array.isArray(body.teams)) setTeams(body.teams.map((t) => t.name ?? '').filter(Boolean))
      })
      .catch(() => {
        /* no teams — the picker says so */
      })
    return () => {
      alive = false
    }
  }, [])
  return useMemo(() => [...new Set([...catalogGroups, ...teams])].sort((a, b) => a.localeCompare(b)), [catalogGroups, teams])
}
