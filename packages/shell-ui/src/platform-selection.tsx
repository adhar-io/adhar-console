import { useEffect, useRef, useState } from 'react'
import { cn } from '@adhar-console/utils'
import { Select } from './form.tsx'
import { useOrganizations } from './use-organizations.ts'
import {
  LOCAL_CLUSTER,
  setActiveCluster,
  setActiveNamespace,
  setNamespaceScope,
  useActiveCluster,
  useActiveNamespace,
} from './selection-store.ts'

/**
 * Cluster + Namespace pickers rendered by the **host** into the top bar (via
 * `AppShell`'s `headerControls` slot). They live here — not in the platform
 * remote — so the host can mount them without importing the remote, and both
 * halves talk to the same cluster/namespace through the shared selection store.
 *
 * Lists are fetched with plain `fetch` against the per-user Kubernetes gateway
 * (`/api/k8s/*`); no fabricated data, honest loading / empty / error states,
 * and RBAC stays governed by the caller's Keycloak identity.
 *
 * Org scoping (Task 2): when a non-default organization is active, the
 * namespace set is restricted to namespaces labelled `adhar.io/org=<slug>`.
 */

/* ─────────── org → namespace scope ─────────── */

/**
 * The label selector restricting namespaces to the active org, or `''` for the
 * default / single-org / no-org case (show every namespace — current behaviour).
 * A brand-new user has a single seeded organization, so scoping only engages
 * once they create and switch into additional, non-`default` organizations.
 */
function orgScopeSelector(slug: string | undefined, orgCount: number): string {
  if (!slug || slug === 'default' || orgCount <= 1) return ''
  return `adhar.io/org=${slug}`
}

/* ─────────── gateway fetch helpers ─────────── */

function clusterQuery(name: string): string {
  return !name || name === LOCAL_CLUSTER || name === 'default'
    ? ''
    : `?cluster=${encodeURIComponent(name)}`
}

interface ClusterEntry {
  name: string
  isDefault: boolean
  healthy: boolean
  version: string
}

/** Configured clusters from the gateway meta endpoint, each health-probed. */
function useClusterList(): { clusters: ClusterEntry[]; loading: boolean } {
  const [clusters, setClusters] = useState<ClusterEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let configured: Array<{ name: string; default: boolean }> = []
      try {
        const res = await fetch('/api/k8s/-/clusters', {
          credentials: 'include',
          headers: { accept: 'application/json' },
        })
        if (res.ok) {
          const body = (await res.json()) as { clusters?: Array<{ name: string; default: boolean }> }
          configured = body.clusters ?? []
        }
      } catch {
        /* older gateway without /-/clusters — probe the default cluster only */
      }
      if (configured.length === 0) configured = [{ name: LOCAL_CLUSTER, default: true }]

      const probed = await Promise.all(
        configured.map(async (c): Promise<ClusterEntry> => {
          try {
            const res = await fetch(`/api/k8s/version${clusterQuery(c.default ? '' : c.name)}`, {
              credentials: 'include',
              headers: { accept: 'application/json' },
            })
            const body = res.ok ? ((await res.json()) as { gitVersion?: string }) : null
            return { name: c.name, isDefault: c.default, healthy: res.ok, version: body?.gitVersion ?? '' }
          } catch {
            return { name: c.name, isDefault: c.default, healthy: false, version: '' }
          }
        }),
      )
      if (!cancelled) {
        setClusters(probed)
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return { clusters, loading }
}

interface NsList {
  names: string[]
  loading: boolean
  error: string | null
}

/** Namespaces from the gateway, optionally filtered by an org label selector. */
function useNamespaceList(scope: string): NsList {
  const [state, setState] = useState<NsList>({ names: [], loading: true, error: null })

  useEffect(() => {
    let cancelled = false
    setState((s) => ({ ...s, loading: true, error: null }))
    const q = scope ? `?labelSelector=${encodeURIComponent(scope)}` : ''
    fetch(`/api/k8s/api/v1/namespaces${q}`, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        return (await res.json()) as { items?: Array<{ metadata?: { name?: string } }> }
      })
      .then((body) => {
        if (cancelled) return
        const names = (body.items ?? [])
          .map((n) => n.metadata?.name)
          .filter((n): n is string => Boolean(n))
          .sort()
        setState({ names, loading: false, error: null })
      })
      .catch((e) => {
        if (cancelled) return
        setState({ names: [], loading: false, error: e instanceof Error ? e.message : 'failed' })
      })
    return () => {
      cancelled = true
    }
  }, [scope])

  return state
}

/* ─────────── the control cluster ─────────── */

export function PlatformSelectionControls() {
  const org = useOrganizations()
  const activeSlug = org.ready ? org.orgs.find((o) => o.id === org.activeId)?.slug : undefined
  const scope = orgScopeSelector(activeSlug, org.orgs.length)

  // Publish the org scope into the shared store so the platform data layer
  // restricts its own namespace listings to the same set.
  useEffect(() => {
    setNamespaceScope(scope)
  }, [scope])

  const { namespace, setNamespace } = useActiveNamespace()
  const ns = useNamespaceList(scope)
  const scoped = scope !== ''

  // Keep the active namespace valid for the current scope: if the selection is
  // no longer one of the org's namespaces, fall back to "All namespaces".
  useEffect(() => {
    if (ns.loading || ns.error) return
    if (namespace && !ns.names.includes(namespace)) setActiveNamespace(undefined)
  }, [ns.loading, ns.error, ns.names, namespace])

  return (
    <div className="flex min-w-0 items-center gap-2">
      <ClusterChip />
      <label className="flex items-center gap-1.5 text-xs text-content-muted">
        <span className="hidden sm:inline">Namespace</span>
        {scoped && !ns.loading && !ns.error && ns.names.length === 0 ? (
          <span
            className="inline-flex items-center rounded-lg border border-dashed border-edge-strong bg-surface-sunken/50 px-2.5 py-1.5 text-xs text-content-muted"
            title={`No namespaces are assigned to this organization — label a namespace with ${scope}`}
          >
            No namespaces in this org
          </span>
        ) : (
          <Select
            value={namespace ?? ''}
            onChange={(e) => setNamespace(e.target.value || undefined)}
            disabled={ns.loading}
            className="min-w-40"
            title={
              scoped
                ? `Namespaces labelled ${scope}`
                : ns.error
                  ? `Couldn't list namespaces: ${ns.error}`
                  : undefined
            }
          >
            <option value="">All namespaces</option>
            {ns.names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        )}
      </label>
    </div>
  )
}

/* ─────────── cluster chip / switcher ─────────── */

function isActiveEntry(entry: ClusterEntry, cluster: string): boolean {
  return entry.name === cluster || (clusterQuery(cluster) === '' && entry.isDefault)
}

function ClusterChip() {
  const { cluster, setCluster } = useActiveCluster()
  const { clusters, loading } = useClusterList()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // If the persisted cluster is one the gateway no longer knows, fall back to
  // the default cluster instead of leaving every view stuck on 404s.
  useEffect(() => {
    if (loading || clusters.length === 0) return
    if (clusterQuery(cluster) === '') return
    if (!clusters.some((c) => c.name === cluster)) setCluster(LOCAL_CLUSTER)
  }, [loading, clusters, cluster, setCluster])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (loading || clusters.length === 0) return null

  const active = clusters.find((c) => isActiveEntry(c, cluster)) ?? clusters[0]

  // Single cluster → static chip, nothing to switch.
  if (clusters.length === 1) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-lg border border-edge-default bg-surface-raised px-2.5 py-1.5 text-xs font-medium text-content"
        title={active.version ? `${active.name} · ${active.version}` : active.name}
      >
        <IconCluster />
        <span className="max-w-28 truncate">{active.name}</span>
        <HealthDot healthy={active.healthy} />
      </span>
    )
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg border border-edge-default bg-surface-raised px-2.5 py-1.5 text-xs font-medium text-content shadow-sm transition-colors',
          'hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500',
        )}
        title={`Active cluster: ${active.name}`}
      >
        <IconCluster />
        <span className="max-w-32 truncate">{active.name}</span>
        <HealthDot healthy={active.healthy} />
        <IconChevron open={open} />
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label="Clusters"
          className="absolute left-0 z-50 mt-1.5 w-72 overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-lg"
        >
          <div className="border-b border-edge-subtle px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
            Switch cluster
          </div>
          <ul className="max-h-80 overflow-y-auto p-1">
            {clusters.map((c) => {
              const selected = isActiveEntry(c, cluster)
              return (
                <li key={c.name}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      setCluster(c.isDefault ? LOCAL_CLUSTER : c.name)
                      setOpen(false)
                    }}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                      selected ? 'bg-brand-50/70 dark:bg-brand-500/10' : 'hover:bg-surface-sunken',
                    )}
                  >
                    <span className="mt-0.5">
                      <HealthDot healthy={c.healthy} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-semibold text-content">{c.name}</span>
                        {c.isDefault ? (
                          <span className="rounded-full border border-edge-subtle bg-surface-sunken px-1.5 py-px text-[9px] font-medium text-content-subtle">
                            default
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[10px] text-content-subtle">
                        {c.healthy ? c.version || 'version unknown' : 'unreachable'}
                      </span>
                    </span>
                    {selected ? (
                      <span className="mt-0.5 text-brand-700 dark:text-brand-300">
                        <IconCheck />
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

/* ─────────── atoms ─────────── */

function HealthDot({ healthy }: { healthy: boolean }) {
  return (
    <span
      className={cn('h-1.5 w-1.5 shrink-0 rounded-full', healthy ? 'bg-emerald-500' : 'bg-rose-500')}
      title={healthy ? 'reachable' : 'unreachable'}
    />
  )
}

function IconCluster() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2 4 6v12l8 4 8-4V6z" />
      <path d="M12 2v20" />
      <path d="m4 6 16 12" />
      <path d="m20 6-16 12" />
    </svg>
  )
}

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={cn('transition-transform', open && 'rotate-180')}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function IconCheck() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
