import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@adhar-console/utils'
import {
  clusterParam,
  LOCAL_CLUSTER,
  setActiveCluster,
  useActiveCluster,
  type GatewayCluster,
} from '../data/client.ts'
import { useClusters } from '../data/hooks.ts'

/**
 * Multi-cluster switcher. The active selection lives in a module-level store
 * (`data/client.ts`) that every data hook reads, so picking a cluster here
 * re-scopes every platform view — live watches tear down and relist, polled
 * queries refetch because the cluster is part of their query key.
 *
 * With a single configured cluster the picker collapses to a static chip;
 * while the cluster list is still loading it renders nothing.
 */

export { useActiveCluster } from '../data/client.ts'

/**
 * Module-root wrapper (mounted by home.tsx). The store itself is external, so
 * this mainly guards the persisted selection: if localStorage points at a
 * cluster the gateway no longer knows, fall back to the default cluster
 * instead of leaving every view stuck on 404s.
 */
export function ClusterProvider({ children }: { children: ReactNode }) {
  const clusters = useClusters()
  const { cluster } = useActiveCluster()
  useEffect(() => {
    const list = clusters.data ?? []
    if (list.length === 0) return
    if (clusterParam(cluster) === undefined) return // default cluster is always valid
    if (!list.some((c) => c.name === cluster)) setActiveCluster(LOCAL_CLUSTER)
  }, [clusters.data, cluster])
  return <>{children}</>
}

function isActiveEntry(entry: GatewayCluster, cluster: string): boolean {
  return entry.name === cluster || (clusterParam(cluster) === undefined && entry.isDefault)
}

export function ClusterPicker() {
  const { cluster, setCluster } = useActiveCluster()
  const clusters = useClusters()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

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

  const list = (clusters.data ?? []) as GatewayCluster[]
  if (clusters.isLoading || list.length === 0) return null

  const active = list.find((c) => isActiveEntry(c, cluster)) ?? list[0]

  // Single cluster configured → static chip, nothing to switch.
  if (list.length === 1) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-lg border border-edge-default bg-surface-raised px-2.5 py-1.5 text-xs font-medium text-content"
        title={active.version ? `${active.name} · ${active.version}` : active.name}
      >
        <IconCluster />
        <span className="max-w-32 truncate">{active.name}</span>
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
        <span className="max-w-36 truncate">{active.name}</span>
        <HealthDot healthy={active.healthy} />
        <IconChevron open={open} />
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label="Clusters"
          className="absolute right-0 z-50 mt-1.5 w-72 overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-lg"
        >
          <div className="border-b border-edge-subtle px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
            Switch cluster
          </div>
          <ul className="max-h-80 overflow-y-auto p-1">
            {list.map((c) => {
              const selected = isActiveEntry(c, cluster)
              return (
                <li key={c.name}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      // The gateway treats `local`/`default`/unset as its
                      // default cluster — picking the default entry keeps the
                      // stable LOCAL_CLUSTER key so requests stay identical to
                      // single-cluster operation.
                      setCluster(c.isDefault ? LOCAL_CLUSTER : c.name)
                      setOpen(false)
                    }}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                      selected
                        ? 'bg-brand-50/70 dark:bg-brand-500/10'
                        : 'hover:bg-surface-sunken',
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
                        {c.healthy
                          ? `${c.version || 'version unknown'} · ${c.nodeCount} node${c.nodeCount === 1 ? '' : 's'}`
                          : 'unreachable'}
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
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn('transition-transform', open && 'rotate-180')}
    >
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
