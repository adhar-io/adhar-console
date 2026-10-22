import { useEffect, useMemo, useState } from 'react'
import { Button, EmptyState, Input, Select, Spinner, type StatusKind, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { IconBtn, Segmented, ToggleChip } from '~/components/code-viewer.tsx'
import { GraphView, LEVEL_KIND, StatusPill, SyncMark, TreeTable } from '~/components/resource-graph.tsx'
import { cardExtra, ResourceDetail } from '~/components/resource-detail.tsx'
import { COMPOSITION_REFRESH_MS, type CompositionRoots, useCompositionGraph } from '~/data/catalog-composition.ts'
import {
  age,
  deriveStatus,
  type HealthLevel,
  intersectVisible,
  kindsOf,
  subtreeScope,
  summarize,
  visibleNodes,
  worse,
} from '~/data/catalog-composition-model.ts'

export { LEVEL_KIND }

/**
 * The Composition view of the drawer's Resources tab: everything the entity
 * is made of, live.
 *
 * Roots are the entity's platform composite and its Argo CD apps (resolved in
 * `catalog-composition.ts`); under them, each composed resource, nested
 * composites, and Argo's managed resources down to Pods. Tree (a layered
 * graph) or list, filterable, refreshed every 12 s unless paused. Clicking a
 * node opens its conditions, events and live YAML.
 */

type View = 'tree' | 'list'

/** Tab badge: the worst status among the roots, and how many there are. */
export function compositionBadge(roots: CompositionRoots): { kind: StatusKind; value: number } | undefined {
  if (!roots.roots.length) return undefined
  let worst: HealthLevel = 'none'
  for (const r of roots.roots) worst = worse(worst, r.object ? deriveStatus(r.object).level : 'unknown')
  return { kind: LEVEL_KIND[worst], value: roots.roots.length }
}

export function CompositionView({ roots, scope }: {
  roots: CompositionRoots
  /** Show only this node's branch (an environment's Argo CD app), when it is in the graph. */
  scope?: string | null
}) {
  const [view, setView] = useState<View>(() =>
    typeof globalThis.matchMedia === 'function' && !globalThis.matchMedia('(min-width: 640px)').matches ? 'list' : 'tree'
  )
  const [paused, setPaused] = useState(false)
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState('')
  const [unhealthyOnly, setUnhealthyOnly] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const graph = useCompositionGraph(roots, { paused })
  const toast = useToast()

  const g = graph.data
  const kinds = useMemo(() => (g ? kindsOf(g) : []), [g])
  const scoped = useMemo(() => (g && scope && g.nodes[scope] ? subtreeScope(g, scope) : undefined), [g, scope])
  const filtered = useMemo(() => (g ? visibleNodes(g, { search, kind, unhealthyOnly }) : undefined), [g, search, kind, unhealthyOnly])
  // Counts follow the environment scope, so they describe what is shown.
  const summary = useMemo(
    () => (g ? summarize(scoped ? { ...g, nodes: Object.fromEntries(Object.entries(g.nodes).filter(([id]) => scoped.has(id))) } : g) : undefined),
    [g, scoped],
  )
  const visible = useMemo(() => intersectVisible(scoped, filtered), [scoped, filtered])
  const filtering = Boolean(filtered)

  // A tick so "updated 5s ago" and ages move between refreshes.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(t)
  }, [])

  if (roots.isLoading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-content-muted">
        <Spinner /> Resolving the platform resources behind this entity…
      </div>
    )
  }
  if (roots.error && roots.roots.length === 0) {
    const forbidden = roots.error.status === 403
    return (
      <EmptyState
        compact
        title={forbidden ? 'No permission to discover cluster APIs' : 'Could not reach the Kubernetes API'}
        description={forbidden
          ? 'Your Kubernetes role does not allow API discovery, so the composite and its resources cannot be looked up. Ask a platform admin for read access.'
          : roots.error.message}
      />
    )
  }
  if (roots.roots.length === 0) {
    return (
      <EmptyState
        compact
        title="Nothing composed for this entity"
        description={roots.notes[0] ?? 'No platform composite, claim or Argo CD application was found for it. Annotate the entity with adhar.io/xr: <Kind>[.<group>]/<namespace>/<name> to link one.'}
      />
    )
  }

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const collapseAll = () => g && setCollapsed(new Set(Object.values(g.nodes).filter((n) => n.children.length && !g.roots.includes(n.id)).map((n) => n.id)))
  const updatedAt = graph.dataUpdatedAt

  const fitKey = `${search}|${kind}|${unhealthyOnly}|${view}|${scope ?? ''}`
  const shownCollapsed = filtering ? NO_COLLAPSE : collapsed

  return (
    <div className="space-y-3">
      {/*
        Toolbar, pinned under the drawer's tab bar while the tab scrolls:
        summary left, view + refresh right; filters on the second row.
      */}
      <div className="sticky top-[3.25rem] z-20 -mx-1 space-y-2 rounded-b-lg bg-surface-canvas/90 px-1 pb-2 pt-1 backdrop-blur supports-[backdrop-filter]:bg-surface-canvas/75">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-xs">
            {summary ? (
              <>
                <span className="mr-0.5 font-semibold text-content">{summary.total} resources</span>
                {(['degraded', 'missing', 'progressing', 'suspended'] as HealthLevel[]).map((l) =>
                  summary.byLevel[l] ? <StatusPill key={l} level={l} label={`${summary.byLevel[l]} ${l}`} /> : null
                )}
                {summary.byLevel.healthy ? <StatusPill level="healthy" label={`${summary.byLevel.healthy} healthy`} /> : null}
                {summary.outOfSync ? <span className="text-[11px]"><SyncMark sync="OutOfSync" /> <span className="text-amber-700 dark:text-amber-300">×{summary.outOfSync}</span></span> : null}
              </>
            ) : graph.isLoading ? (
              <span className="inline-flex items-center gap-2 text-content-muted">
                <Spinner size={14} /> Reading {roots.roots.length} root{roots.roots.length === 1 ? '' : 's'}…
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <Segmented<View>
              value={view}
              onChange={setView}
              ariaLabel="View"
              options={[
                { value: 'tree', label: 'Graph' },
                { value: 'list', label: 'Table' },
              ]}
            />
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setPaused((p) => !p)}
              aria-pressed={!paused}
              title={paused ? 'Resume auto-refresh' : `Auto-refreshing every ${COMPOSITION_REFRESH_MS / 1000}s — pause`}
            >
              <span className={cn('mr-1.5 inline-block h-2 w-2 rounded-full', paused ? 'bg-content-subtle' : 'bg-emerald-500')} aria-hidden />
              {paused ? 'Paused' : 'Live'}
            </Button>
            <IconBtn
              label="Refresh now"
              onClick={() => {
                graph.refetch().then((r) => {
                  if (r.error) toast.error('Refresh failed', { description: r.error instanceof Error ? r.error.message : String(r.error) })
                })
              }}
            >
              <path d="M12 4a8 8 0 0 1 7.4 5H17v2h6V5h-2v2.3A10 10 0 1 0 22 12h-2a8 8 0 1 1-8-8z" />
            </IconBtn>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, kind, status…"
            aria-label="Search resources"
            className="h-8 min-w-40 flex-1 basis-48 py-0 text-sm"
          />
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            aria-label="Filter by kind"
            className="h-8 py-0 text-sm"
            wrapperClassName="min-w-0"
            options={[{ value: '', label: 'All kinds' }, ...kinds.map((k) => ({ value: k, label: k }))]}
          />
          <ToggleChip on={unhealthyOnly} onClick={() => setUnhealthyOnly((v) => !v)} title="Only resources that are not healthy or not in sync">
            Unhealthy only
          </ToggleChip>
          <div className="ml-auto flex items-center gap-0.5">
            <Button size="xs" variant="ghost" onClick={() => setCollapsed(new Set())} disabled={filtering} title="Expand every subtree">Expand all</Button>
            <Button size="xs" variant="ghost" onClick={collapseAll} disabled={filtering} title="Collapse everything below the roots">Collapse all</Button>
          </div>
        </div>
      </div>

      {roots.notes.length ? (
        <ul className="space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-inset ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-400/25">
          {roots.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      ) : null}

      {graph.error && !g ? (
        <EmptyState compact title="Could not read the resources" description={graph.error instanceof Error ? graph.error.message : String(graph.error)} />
      ) : !g ? (
        <div className="h-80 animate-pulse rounded-xl border border-edge-default bg-surface-sunken" aria-hidden />
      ) : filtering && visible!.size === 0 ? (
        <EmptyState compact title="No resources match" description="Clear the search or filters to see every resource." action={<Button size="sm" variant="secondary" onClick={() => { setSearch(''); setKind(''); setUnhealthyOnly(false) }}>Clear filters</Button>} />
      ) : view === 'tree' ? (
        <GraphView ariaLabel="Composition graph" graph={g} visible={visible} collapsed={shownCollapsed} onToggle={toggle} selected={selected} onSelect={setSelected} now={now} fitKey={fitKey} cardExtra={cardExtra} onExpandAll={filtering ? undefined : () => setCollapsed(new Set())} onCollapseAll={filtering ? undefined : collapseAll} />
      ) : (
        <TreeTable ariaLabel="Resources" graph={g} visible={visible} collapsed={shownCollapsed} onToggle={toggle} selected={selected} onSelect={setSelected} now={now} onExpandAll={filtering ? undefined : () => setCollapsed(new Set())} onCollapseAll={filtering ? undefined : collapseAll} />
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-content-subtle">
        <span>
          Resolved from {[...new Set(roots.roots.map((r) => r.via))].join(' · ')}
          {g?.truncated ? ' · the walk stopped at its size limit; some resources are not shown' : ''}
        </span>
        {updatedAt ? <span>Updated {age(new Date(updatedAt).toISOString(), now)} ago{graph.error ? ' · last refresh failed' : ''}</span> : null}
      </div>

      {selected && g?.nodes[selected] ? (
        <ResourceDetail graph={g} node={g.nodes[selected]} onClose={() => setSelected(null)} onSelect={setSelected} now={now} />
      ) : null}
    </div>
  )
}

const NO_COLLAPSE: ReadonlySet<string> = new Set()

