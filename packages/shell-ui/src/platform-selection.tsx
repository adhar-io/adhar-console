import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@adhar-console/utils'
import { useOrganizations } from './use-organizations.ts'
import {
  LOCAL_CLUSTER,
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
 * Both are consistent, styled dropdowns (never a bare native <select> or a
 * static chip — a single cluster still renders as a one-item dropdown). Lists
 * are fetched with plain `fetch` against the per-user Kubernetes gateway
 * (`/api/k8s/*`); no fabricated data, honest loading / empty / error states,
 * and RBAC stays governed by the caller's Keycloak identity.
 *
 * Org scoping: when a non-default organization is active, the namespace set is
 * restricted to namespaces labelled `adhar.io/org=<slug>`.
 */

/* ─────────── org → namespace scope ─────────── */

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

  return (
    <div className="flex min-w-0 items-center gap-2">
      <ClusterDropdown />
      <NamespaceDropdown scope={scope} />
    </div>
  )
}

/* ─────────── cluster dropdown ─────────── */

function isActiveEntry(entry: ClusterEntry, cluster: string): boolean {
  return entry.name === cluster || (clusterQuery(cluster) === '' && entry.isDefault)
}

function ClusterDropdown() {
  const { cluster, setCluster } = useActiveCluster()
  const { clusters, loading } = useClusterList()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useOutsideClose(rootRef, open, setOpen)

  // If the persisted cluster is one the gateway no longer knows, fall back to
  // the default cluster instead of leaving every view stuck on 404s.
  useEffect(() => {
    if (loading || clusters.length === 0) return
    if (clusterQuery(cluster) === '') return
    if (!clusters.some((c) => c.name === cluster)) setCluster(LOCAL_CLUSTER)
  }, [loading, clusters, cluster, setCluster])

  const active = clusters.find((c) => isActiveEntry(c, cluster)) ?? clusters[0]

  return (
    <div ref={rootRef} className="relative">
      <Trigger
        open={open}
        onClick={() => setOpen((o) => !o)}
        icon={<IconCluster />}
        label={loading ? 'Cluster' : (active?.name ?? 'Cluster')}
        trailing={!loading && active ? <HealthDot healthy={active.healthy} /> : <Spinner />}
        title={active ? `Cluster: ${active.name}${active.version ? ` · ${active.version}` : ''}` : 'Cluster'}
        disabled={loading}
      />
      {open && !loading ? (
        <Popover label="Clusters" title="Cluster">
          <ul className="max-h-80 overflow-y-auto p-1">
            {clusters.map((c) => {
              const selected = isActiveEntry(c, cluster)
              return (
                <li key={c.name}>
                  <OptionRow
                    selected={selected}
                    onClick={() => {
                      setCluster(c.isDefault ? LOCAL_CLUSTER : c.name)
                      setOpen(false)
                    }}
                    leading={<HealthDot healthy={c.healthy} />}
                    title={
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-semibold text-content">{c.name}</span>
                        {c.isDefault ? <DefaultBadge /> : null}
                      </span>
                    }
                    subtitle={c.healthy ? c.version || 'version unknown' : 'unreachable'}
                  />
                </li>
              )
            })}
          </ul>
        </Popover>
      ) : null}
    </div>
  )
}

/* ─────────── namespace dropdown ─────────── */

function NamespaceDropdown({ scope }: { scope: string }) {
  const { namespace, setNamespace } = useActiveNamespace()
  const ns = useNamespaceList(scope)
  const scoped = scope !== ''
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  useOutsideClose(rootRef, open, setOpen)

  // Keep the active namespace valid for the current scope: if the selection is
  // no longer one of the org's namespaces, fall back to "All namespaces".
  useEffect(() => {
    if (ns.loading || ns.error) return
    if (namespace && !ns.names.includes(namespace)) setActiveNamespace(undefined)
  }, [ns.loading, ns.error, ns.names, namespace])

  // Focus the filter when the menu opens (only shown when there are many).
  useEffect(() => {
    if (open) searchRef.current?.focus()
    else setQuery('')
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? ns.names.filter((n) => n.toLowerCase().includes(q)) : ns.names
  }, [ns.names, query])

  const emptyScoped = scoped && !ns.loading && !ns.error && ns.names.length === 0
  const label = namespace ?? 'All namespaces'

  return (
    <div ref={rootRef} className="relative">
      <Trigger
        open={open}
        onClick={() => setOpen((o) => !o)}
        icon={<IconNamespace />}
        label={ns.loading ? 'Namespace' : label}
        trailing={ns.loading ? <Spinner /> : undefined}
        title={
          emptyScoped
            ? `No namespaces are assigned to this organization — label a namespace with ${scope}`
            : scoped
              ? `Namespaces labelled ${scope}`
              : ns.error
                ? `Couldn't list namespaces: ${ns.error}`
                : `Namespace: ${label}`
        }
        disabled={ns.loading}
        tone={ns.error ? 'warn' : undefined}
      />
      {open && !ns.loading ? (
        <Popover label="Namespaces" title="Namespace">
          {emptyScoped ? (
            <div className="px-3 py-3 text-xs leading-relaxed text-content-muted">
              No namespaces are assigned to this organization. Label a namespace with{' '}
              <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[11px]">{scope}</code>{' '}
              to make it visible here.
            </div>
          ) : ns.error ? (
            <div className="px-3 py-3 text-xs leading-relaxed text-rose-600 dark:text-rose-400">
              Couldn't list namespaces: {ns.error}
            </div>
          ) : (
            <>
              {ns.names.length > 7 ? (
                <div className="border-b border-edge-subtle p-1.5">
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter namespaces…"
                    className="h-8 w-full rounded-md border border-edge-default bg-surface-sunken/40 px-2.5 text-xs text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                  />
                </div>
              ) : null}
              <ul className="max-h-72 overflow-y-auto p-1">
                <li>
                  <OptionRow
                    selected={!namespace}
                    onClick={() => {
                      setNamespace(undefined)
                      setOpen(false)
                    }}
                    title={<span className="text-xs font-medium text-content">All namespaces</span>}
                  />
                </li>
                {filtered.map((n) => (
                  <li key={n}>
                    <OptionRow
                      selected={namespace === n}
                      onClick={() => {
                        setNamespace(n)
                        setOpen(false)
                      }}
                      title={<span className="truncate font-mono text-xs text-content">{n}</span>}
                    />
                  </li>
                ))}
                {filtered.length === 0 ? (
                  <li className="px-2.5 py-2 text-xs text-content-subtle">No namespaces match “{query}”.</li>
                ) : null}
              </ul>
            </>
          )}
        </Popover>
      ) : null}
    </div>
  )
}

/* ─────────── shared dropdown primitives ─────────── */

function useOutsideClose(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (v: boolean) => void,
) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
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
  }, [open, ref, setOpen])
}

function Trigger({
  open,
  onClick,
  icon,
  label,
  trailing,
  title,
  disabled,
  tone,
}: {
  open: boolean
  onClick(): void
  icon: React.ReactNode
  label: string
  trailing?: React.ReactNode
  title?: string
  disabled?: boolean
  tone?: 'warn'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-haspopup="listbox"
      aria-expanded={open}
      title={title}
      className={cn(
        'inline-flex h-9 max-w-[11rem] items-center gap-1.5 rounded-lg border bg-surface-raised px-2.5 text-xs font-medium text-content shadow-sm transition-colors',
        'hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/25 disabled:opacity-60',
        tone === 'warn' ? 'border-amber-300 dark:border-amber-500/40' : 'border-edge-default',
        open && 'ring-2 ring-brand-500/25',
      )}
    >
      <span className="shrink-0 text-content-subtle">{icon}</span>
      <span className="truncate">{label}</span>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
      <IconChevron open={open} />
    </button>
  )
}

function Popover({
  label,
  title,
  children,
}: {
  label: string
  title: string
  children: React.ReactNode
}) {
  return (
    <div
      role="listbox"
      aria-label={label}
      className="absolute right-0 z-50 mt-1.5 w-64 overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-lg"
    >
      <div className="border-b border-edge-subtle px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
        {title}
      </div>
      {children}
    </div>
  )
}

function OptionRow({
  selected,
  onClick,
  leading,
  title,
  subtitle,
}: {
  selected: boolean
  onClick(): void
  leading?: React.ReactNode
  title: React.ReactNode
  subtitle?: string
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
        selected ? 'bg-brand-50/70 dark:bg-brand-500/10' : 'hover:bg-surface-sunken',
      )}
    >
      {leading ? <span className="mt-0.5">{leading}</span> : null}
      <span className="min-w-0 flex-1">
        {title}
        {subtitle ? (
          <span className="mt-0.5 block truncate font-mono text-[10px] text-content-subtle">{subtitle}</span>
        ) : null}
      </span>
      {selected ? (
        <span className="mt-0.5 text-brand-700 dark:text-brand-300">
          <IconCheck />
        </span>
      ) : null}
    </button>
  )
}

/* ─────────── atoms ─────────── */

function DefaultBadge() {
  return (
    <span className="rounded-full border border-edge-subtle bg-surface-sunken px-1.5 py-px text-[9px] font-medium text-content-subtle">
      default
    </span>
  )
}

function HealthDot({ healthy }: { healthy: boolean }) {
  return (
    <span
      className={cn('h-1.5 w-1.5 shrink-0 rounded-full', healthy ? 'bg-emerald-500' : 'bg-rose-500')}
      title={healthy ? 'reachable' : 'unreachable'}
    />
  )
}

function Spinner() {
  return (
    <svg className="h-3 w-3 shrink-0 animate-spin text-content-subtle" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
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

function IconNamespace() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m12 2 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </svg>
  )
}

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={cn('shrink-0 text-content-subtle transition-transform', open && 'rotate-180')}>
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
