import { useQuery } from '@tanstack/react-query'
import type { Entity } from './catalog.ts'

/**
 * Where a catalog entity is reachable — the URLs the drawer offers to open.
 *
 * Backed by `GET /api/catalog/routes`, which reads HTTPRoutes and Ingresses with
 * the signed-in user's RBAC and matches them to the entity by BACKEND SERVICE
 * (name matching is only a fallback). See `~/server/entity-routes.ts` for why
 * that distinction matters.
 *
 * An entity may legitimately have no routes — a library, a database, a worker
 * with no HTTP surface — so an empty list is a normal answer and the UI shows no
 * button rather than an error.
 */

export interface EntityRoute {
  url: string
  host: string
  path: string
  kind: 'HTTPRoute' | 'Ingress'
  name: string
  namespace: string
  service?: string
  via: 'backend' | 'name'
  secure: boolean
}

export interface EntityRoutes {
  routes: EntityRoute[]
  /** The best URL to offer as the single primary action. */
  primary: EntityRoute | undefined
  isLoading: boolean
  isError: boolean
  /** Set when the apiserver refused the read, so the UI can say why it is blank. */
  error?: string
}

const REFRESH_MS = 60_000

/**
 * `namespace` narrows the query when the entity declares one; without it the
 * endpoint searches cluster-wide, which is correct but slower and can match a
 * same-named Service in another namespace.
 */
export function useEntityRoutes(entity: Entity, enabled = true): EntityRoutes {
  const name = entity.metadata.name
  const namespace = (entity.metadata.annotations?.['adhar.io/namespace'] ?? '').trim()

  const q = useQuery({
    queryKey: ['catalog', 'routes', name, namespace],
    queryFn: async () => {
      const params = new URLSearchParams({ name })
      if (namespace) params.set('namespace', namespace)
      const res = await fetch(`/api/catalog/routes?${params}`, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      if (!res.ok) throw new Error(`routes: ${res.status}`)
      return (await res.json()) as { routes?: EntityRoute[]; error?: string }
    },
    enabled: enabled && !!name,
    staleTime: REFRESH_MS,
    refetchInterval: enabled ? REFRESH_MS : false,
  })

  const routes = q.data?.routes ?? []
  return {
    routes,
    // The endpoint already ranks: backend match, then https, then the shortest
    // path. Re-sorting here would be a second, divergent opinion.
    primary: routes[0],
    isLoading: q.isLoading,
    isError: q.isError,
    ...(q.data?.error ? { error: q.data.error } : {}),
  }
}

/** `billing.adhar.io/api` — a URL short enough for a button. */
export function routeLabel(route: EntityRoute): string {
  const path = route.path && route.path !== '/' ? route.path : ''
  return `${route.host}${path}`
}
