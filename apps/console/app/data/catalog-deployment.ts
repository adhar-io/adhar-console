import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { argocd } from '@adhar-console/api-clients'
import type { Entity } from './catalog.ts'

/**
 * Live deployment / GitOps signals for the Service Catalog entity drawer.
 *
 * The drawer's "Deployment" tab shows real ArgoCD Application state for the
 * entity being viewed — sync status, health, revision, source path, and the
 * environments it rolls out to. We reuse the same BFF `argocd` proxy the rest
 * of the console uses (no MF hop) and match Applications to the entity by name
 * so the panel never shows another service's rollout.
 *
 * Matching is deliberately conservative: an Application counts as "this
 * entity's" when its name is exactly the entity name, the entity name with a
 * common environment suffix (`-prod`, `-staging`, …), or when the entity
 * declares the app explicitly via the `adhar.io/argocd-app` annotation. That
 * keeps false positives out — an unmatched entity gets an honest empty state
 * and a deep link into the GitOps view rather than a guessed rollout.
 */

const argocdClient = argocd.ArgoCDClient.auto({ tool: 'argocd' })

const REFRESH_MS = 30_000

/** Environment suffixes we recognise on ArgoCD app names (`billing-prod`). */
const ENV_SUFFIXES = [
  'prod',
  'production',
  'staging',
  'stage',
  'stg',
  'dev',
  'development',
  'qa',
  'test',
  'uat',
  'preview',
  'canary',
  'sandbox',
] as const

/** Pretty label for a derived environment key. */
export function envLabel(key: string): string {
  const k = key.toLowerCase()
  if (k === 'prod' || k === 'production') return 'Production'
  if (k === 'staging' || k === 'stage' || k === 'stg') return 'Staging'
  if (k === 'dev' || k === 'development') return 'Development'
  if (k === 'qa') return 'QA'
  if (k === 'uat') return 'UAT'
  if (k === 'test') return 'Test'
  if (k === 'preview') return 'Preview'
  if (k === 'canary') return 'Canary'
  if (k === 'sandbox') return 'Sandbox'
  return key.charAt(0).toUpperCase() + key.slice(1)
}

/** Rank environments so Production sorts first, Dev last. */
function envRank(key: string): number {
  const k = key.toLowerCase()
  if (k.startsWith('prod')) return 0
  if (k.startsWith('stag') || k === 'stg') return 1
  if (k === 'uat') return 2
  if (k === 'qa' || k === 'test') return 3
  if (k === 'preview' || k === 'canary') return 4
  if (k.startsWith('dev')) return 5
  return 6
}

export interface EntityEnvironment {
  /** Environment key derived from the app-name suffix or destination namespace. */
  key: string
  label: string
  app: argocd.Application
}

export interface EntityDeployment {
  /** Every ArgoCD Application confidently matched to this entity. */
  apps: argocd.Application[]
  /** Apps grouped into ordered environments (prod → dev). */
  environments: EntityEnvironment[]
  /** The primary app (prod if present, else the first match). */
  primary: argocd.Application | undefined
  isLoading: boolean
  isError: boolean
  /** True when the query resolved but nothing matched this entity. */
  unmatched: boolean
}

function matchName(appName: string, entityName: string): { hit: boolean; env: string | undefined } {
  const a = appName.toLowerCase()
  const n = entityName.toLowerCase()
  if (a === n) return { hit: true, env: undefined }
  for (const suf of ENV_SUFFIXES) {
    if (a === `${n}-${suf}`) return { hit: true, env: suf }
  }
  return { hit: false, env: undefined }
}

/**
 * All ArgoCD Applications that belong to `entity`, plus derived environments.
 * Read-only: the drawer surfaces status and deep-links to the GitOps view for
 * actions (the catalog runs under a view-only service account).
 */
export function useEntityDeployment(entity: Entity, enabled = true): EntityDeployment {
  const q = useQuery({
    queryKey: ['catalog', 'argocd', 'apps'],
    queryFn: () => argocdClient.listApplications(),
    refetchInterval: enabled ? REFRESH_MS : false,
    staleTime: REFRESH_MS,
    enabled,
  })

  const name = entity.metadata.name
  const explicit = (entity.metadata.annotations?.['adhar.io/argocd-app'] ?? '').trim().toLowerCase()

  return useMemo(() => {
    const all = q.data ?? []
    const seen = new Set<string>()
    const matched: Array<{ app: argocd.Application; env: string | undefined }> = []
    for (const app of all) {
      const an = app.metadata.name.toLowerCase()
      const { hit, env } = matchName(app.metadata.name, name)
      const isExplicit = explicit && an === explicit
      if ((hit || isExplicit) && !seen.has(an)) {
        seen.add(an)
        matched.push({ app, env })
      }
    }

    // Derive an environment key per app: name suffix first, else destination
    // namespace suffix, else "default".
    const environments: EntityEnvironment[] = matched
      .map(({ app, env }) => {
        let key = env
        if (!key) {
          const ns = app.spec.destination.namespace.toLowerCase()
          key =
            ENV_SUFFIXES.find((s) => ns === s || ns.endsWith(`-${s}`) || ns.startsWith(`${s}-`)) ??
            (matched.length > 1 ? app.metadata.name : 'default')
        }
        return { key, label: envLabel(key), app }
      })
      .sort((a, b) => envRank(a.key) - envRank(b.key) || a.label.localeCompare(b.label))

    const apps = matched.map((m) => m.app)
    const primary =
      environments.find((e) => e.key.toLowerCase().startsWith('prod'))?.app ?? apps[0]

    return {
      apps,
      environments,
      primary,
      isLoading: q.isLoading,
      isError: q.isError,
      unmatched: !q.isLoading && !q.isError && apps.length === 0,
    }
  }, [q.data, q.isLoading, q.isError, name, explicit])
}
