import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Entity } from './catalog.ts'
import type { EntityDeployment } from './catalog-deployment.ts'

/**
 * Deleting a catalog entity — what it would remove, and the call that
 * removes it.
 *
 * The plan is computed on the client from what the catalog already knows
 * (matched Argo CD Applications, the source repository, the workload
 * namespace) so the dialog can show a person exactly what is about to go
 * before they type the name. The server (`/api/catalog/teardown`) then does
 * the work as that user and reports each step.
 */

export interface TeardownPlan {
  name: string
  /** Argo CD Applications matched to the entity, with the namespace they live in. */
  apps: Array<{ name: string; namespace: string; destination: string; health?: string }>
  /** Source repository URL, and whether it looks like this platform's Gitea. */
  repo?: { url: string; onGitea: boolean; label: string }
  /** Workload namespace, when every matched app deploys to the same one. */
  namespace?: string
  /** True when the namespace looks dedicated to this entity (same name). */
  namespaceDedicated: boolean
  /** Where PipelineRuns would be looked for. */
  pipelinesNamespace?: string
  /** Deployable kinds have a build and a workload; the rest are records. */
  deployable: boolean
}

export interface TeardownStep {
  id: string
  label: string
  ok: boolean
  skipped?: boolean
  detail?: string
}

export interface TeardownResult {
  ok: boolean
  name: string
  steps: TeardownStep[]
}

export interface TeardownOptions {
  deleteRepo: boolean
  deleteNamespace: boolean
}

function repoLabel(url: string): string {
  try {
    const u = new URL(url)
    const parts = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : u.host
  } catch {
    return url
  }
}

function looksLikeGitea(url: string, giteaHost: string | undefined): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (giteaHost && host === giteaHost.toLowerCase()) return true
    return /(^|\.)gitea\./.test(host) || host.startsWith('gitea')
  } catch {
    return false
  }
}

/** Best-known source repository URL for an entity (repo link, else annotations). */
export function entityRepoUrl(e: Entity): string | undefined {
  const fromLink = (e.metadata.links ?? []).find((l) => l.icon === 'repo')?.url
  const a = e.metadata.annotations ?? {}
  const raw = (fromLink ?? a['adhar.io/source-repo'] ?? a['adhar.io/git-repo'] ?? a['backstage.io/source-location'] ?? '')
    .trim()
    .replace(/^url:\s*/, '')
  return raw && /^https?:/.test(raw) ? raw : undefined
}

export function planTeardown(entity: Entity, deployment: EntityDeployment | undefined, repoUrl: string | undefined, giteaHost?: string): TeardownPlan {
  const name = entity.metadata.name
  const ann = entity.metadata.annotations ?? {}
  const apps = (deployment?.apps ?? []).map((a) => ({
    name: a.metadata.name,
    namespace: a.metadata.namespace,
    destination: a.spec.destination.namespace,
    health: a.status.health.status,
  }))
  const destinations = new Set(apps.map((a) => a.destination).filter(Boolean))
  const annotated = (ann['adhar.io/namespace'] ?? '').trim()
  const namespace = destinations.size === 1 ? [...destinations][0] : annotated || undefined
  const deployable = entity.kind === 'Component' || entity.kind === 'Resource'
  return {
    name,
    apps,
    repo: repoUrl ? { url: repoUrl, onGitea: looksLikeGitea(repoUrl, giteaHost), label: repoLabel(repoUrl) } : undefined,
    namespace,
    namespaceDedicated: Boolean(namespace) && namespace === name,
    pipelinesNamespace: annotated || namespace,
    deployable,
  }
}

export function useTeardown() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ plan, options }: { plan: TeardownPlan; options: TeardownOptions }): Promise<TeardownResult> => {
      const res = await fetch('/api/catalog/teardown', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          name: plan.name,
          apps: plan.apps.map((a) => ({ name: a.name, namespace: a.namespace })),
          repo: options.deleteRepo && plan.repo?.onGitea ? plan.repo.url : undefined,
          namespace: options.deleteNamespace ? plan.namespace : undefined,
          pipelinesNamespace: plan.pipelinesNamespace,
        }),
      })
      const body = (await res.json().catch(() => ({}))) as Partial<TeardownResult> & { error?: string }
      if (!res.ok) throw new Error(body.error === 'invalid_name' ? 'That name cannot be deleted from here.' : body.error ?? `Teardown failed (${res.status})`)
      return { ok: Boolean(body.ok), name: body.name ?? plan.name, steps: body.steps ?? [] }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['catalog'] })
    },
  })
}
