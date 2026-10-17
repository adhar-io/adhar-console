import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, EmptyState, Input, Select, Spinner, StatusBadge, type StatusKind, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { CodeViewer, IconBtn, Segmented, ToggleChip } from '~/components/code-viewer.tsx'
import {
  COMPOSITION_REFRESH_MS,
  type CompositionRoots,
  useCompositionGraph,
  useLiveObject,
  useObjectEvents,
} from '~/data/catalog-composition.ts'
import {
  age,
  apiVersionOf,
  type CompNode,
  type CompositionGraph,
  deriveStatus,
  flatten,
  type HealthLevel,
  isUnhealthy,
  kindAbbr,
  kindFamily,
  type KindFamily,
  kindsOf,
  layoutTree,
  rollup,
  summarize,
  visibleNodes,
  worse,
} from '~/data/catalog-composition-model.ts'

/**
 * The Composition tab: everything the entity is made of, live — the way Argo
 * CD's application view shows an app's resources.
 *
 * Roots are the entity's platform composite and its Argo CD apps (resolved in
 * `catalog-composition.ts`); under them, each composed resource, nested
 * composites, and Argo's managed resources down to Pods. Tree (a layered
 * graph) or list, filterable, refreshed every 12 s unless paused. Clicking a
 * node opens its conditions, events and live YAML.
 */

export const LEVEL_KIND: Record<HealthLevel, StatusKind> = {
  healthy: 'healthy',
  progressing: 'progressing',
  degraded: 'degraded',
  suspended: 'info',
  missing: 'paused',
  unknown: 'unknown',
  none: 'unknown',
}

const LEVEL_DOT: Record<HealthLevel, string> = {
  healthy: 'bg-emerald-500',
  progressing: 'bg-indigo-500',
  degraded: 'bg-rose-500',
  suspended: 'bg-sky-500',
  missing: 'bg-amber-500',
  unknown: 'bg-slate-400',
  none: 'bg-slate-300 dark:bg-slate-600',
}

const FAMILY_TONE: Record<KindFamily, string> = {
  gitops: 'bg-orange-50 text-orange-700 ring-orange-200 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-400/25',
  composite: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-400/25',
  workload: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/25',
  network: 'bg-teal-50 text-teal-700 ring-teal-200 dark:bg-teal-500/10 dark:text-teal-300 dark:ring-teal-400/25',
  config: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/25',
  storage: 'bg-lime-50 text-lime-800 ring-lime-200 dark:bg-lime-500/10 dark:text-lime-300 dark:ring-lime-400/25',
  // The slate ramp is re-mapped in dark mode; the semantic tokens read right in both.
  rbac: 'bg-surface-sunken text-content-muted ring-edge-default',
  other: 'bg-surface-sunken text-content-muted ring-edge-default',
}

type View = 'tree' | 'list'

/** Tab badge: the worst status among the roots, and how many there are. */
export function compositionBadge(roots: CompositionRoots): { kind: StatusKind; value: number } | undefined {
  if (!roots.roots.length) return undefined
  let worst: HealthLevel = 'none'
  for (const r of roots.roots) worst = worse(worst, r.object ? deriveStatus(r.object).level : 'unknown')
  return { kind: LEVEL_KIND[worst], value: roots.roots.length }
}

export function CompositionTab({ roots }: { roots: CompositionRoots }) {
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
  const summary = useMemo(() => (g ? summarize(g) : undefined), [g])
  const kinds = useMemo(() => (g ? kindsOf(g) : []), [g])
  const visible = useMemo(() => (g ? visibleNodes(g, { search, kind, unhealthyOnly }) : undefined), [g, search, kind, unhealthyOnly])
  const filtering = Boolean(visible)

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

  return (
    <div className="space-y-3">
      {/* Summary left, actions right. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-xs">
          {summary ? (
            <>
              <span className="font-medium text-content">{summary.total} resources</span>
              {(['degraded', 'missing', 'progressing', 'suspended'] as HealthLevel[]).map((l) =>
                summary.byLevel[l] ? (
                  <StatusBadge key={l} kind={LEVEL_KIND[l]} pulse={false}>
                    {summary.byLevel[l]} {l}
                  </StatusBadge>
                ) : null
              )}
              {summary.byLevel.healthy ? <StatusBadge kind="healthy">{summary.byLevel.healthy} healthy</StatusBadge> : null}
              {summary.outOfSync ? <StatusBadge kind="paused" dot={false}>{summary.outOfSync} out of sync</StatusBadge> : null}
            </>
          ) : graph.isLoading ? (
            <span className="inline-flex items-center gap-2 text-content-muted">
              <Spinner size={14} /> Reading {roots.roots.length} root{roots.roots.length === 1 ? '' : 's'}…
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <Segmented<View>
            value={view}
            onChange={setView}
            ariaLabel="View"
            options={[
              { value: 'tree', label: 'Tree' },
              { value: 'list', label: 'List' },
            ]}
          />
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={!paused}
            title={paused ? 'Resume auto-refresh' : `Auto-refreshing every ${COMPOSITION_REFRESH_MS / 1000}s — pause`}
          >
            <span className={cn('mr-1.5 inline-block h-2 w-2 rounded-full', paused ? 'bg-slate-400' : 'animate-pulse bg-emerald-500')} aria-hidden />
            {paused ? 'Paused' : 'Live'}
          </Button>
          <IconBtn
            label={graph.isFetching ? 'Refreshing…' : 'Refresh now'}
            onClick={() => {
              graph.refetch().then((r) => {
                if (r.error) toast.error('Refresh failed', { description: r.error instanceof Error ? r.error.message : String(r.error) })
              })
            }}
            disabled={graph.isFetching}
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
          className="h-8 min-w-40 flex-1 basis-40 py-0 text-sm"
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
        <div className="flex items-center gap-1">
          <Button size="xs" variant="ghost" onClick={() => setCollapsed(new Set())}>Expand all</Button>
          <Button size="xs" variant="ghost" onClick={collapseAll}>Collapse</Button>
        </div>
      </div>

      {roots.notes.length ? (
        <ul className="space-y-1 text-xs text-amber-800 dark:text-amber-300">
          {roots.notes.map((n) => <li key={n}>• {n}</li>)}
        </ul>
      ) : null}

      {graph.error && !g ? (
        <EmptyState compact title="Could not read the composition" description={graph.error instanceof Error ? graph.error.message : String(graph.error)} />
      ) : !g ? (
        <div className="h-64 animate-pulse rounded-lg bg-surface-sunken" aria-hidden />
      ) : filtering && visible!.size === 0 ? (
        <EmptyState compact title="No resources match" description="Clear the search or filters to see the whole composition." action={<Button size="sm" onClick={() => { setSearch(''); setKind(''); setUnhealthyOnly(false) }}>Clear filters</Button>} />
      ) : view === 'tree' ? (
        <TreeView graph={g} visible={visible} collapsed={filtering ? new Set() : collapsed} onToggle={toggle} selected={selected} onSelect={setSelected} now={now} />
      ) : (
        <ListView graph={g} visible={visible} collapsed={filtering ? new Set() : collapsed} onToggle={toggle} selected={selected} onSelect={setSelected} now={now} />
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-content-subtle">
        <span>
          Resolved from {[...new Set(roots.roots.map((r) => r.via))].join(' · ')}
          {g?.truncated ? ' · the walk stopped at its size limit; some resources are not shown' : ''}
        </span>
        {updatedAt ? <span>Updated {age(new Date(updatedAt).toISOString(), now)} ago{graph.error ? ' · last refresh failed' : ''}</span> : null}
      </div>

      {selected && g?.nodes[selected] ? (
        <NodeDetail graph={g} node={g.nodes[selected]} roots={roots} onClose={() => setSelected(null)} onSelect={setSelected} now={now} />
      ) : null}
    </div>
  )
}

/* ───────────────────────── tree (graph) view ───────────────────────── */

const W = 236
const H = 64
const COL_GAP = 44
const ROW_GAP = 12

interface ViewProps {
  graph: CompositionGraph
  visible?: Set<string>
  collapsed: ReadonlySet<string>
  onToggle(id: string): void
  selected: string | null
  onSelect(id: string): void
  now: number
}

function TreeView({ graph, visible, collapsed, onToggle, selected, onSelect, now }: ViewProps) {
  const layout = useMemo(() => layoutTree(graph, visible, collapsed), [graph, visible, collapsed])
  const pos = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout])
  const width = layout.cols * (W + COL_GAP) - COL_GAP + 16
  const height = Math.max(1, layout.rows) * (H + ROW_GAP) - ROW_GAP + 16
  const xy = (id: string) => {
    const p = pos.get(id)!
    return { x: 8 + p.col * (W + COL_GAP), y: 8 + p.row * (H + ROW_GAP) }
  }
  return (
    <div className="max-h-[70vh] overflow-auto rounded-lg border border-edge-default bg-surface-sunken/50" role="tree" aria-label="Composition tree">
      <div className="relative" style={{ width, height }}>
        <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden>
          {layout.edges.map((e) => {
            const a = xy(e.from)
            const b = xy(e.to)
            const x1 = a.x + W
            const y1 = a.y + H / 2
            const x2 = b.x
            const y2 = b.y + H / 2
            const mx = (x1 + x2) / 2
            return (
              <path
                key={`${e.from}>${e.to}`}
                d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                className={cn('fill-none', e.extra ? 'stroke-slate-300 dark:stroke-slate-600' : 'stroke-slate-300 dark:stroke-slate-600')}
                strokeWidth={1.25}
                strokeDasharray={e.extra ? '4 3' : undefined}
              />
            )
          })}
        </svg>
        {layout.nodes.map((ln) => {
          const n = graph.nodes[ln.id]
          const { x, y } = xy(ln.id)
          const kids = n.children.filter((c) => !visible || visible.has(c))
          const isCollapsed = collapsed.has(n.id) && kids.length > 0
          return (
            <div key={n.id} className="absolute" style={{ left: x, top: y, width: W, height: H }} role="treeitem" aria-selected={selected === n.id} aria-expanded={kids.length ? !isCollapsed : undefined}>
              <NodeCard node={n} selected={selected === n.id} onClick={() => onSelect(n.id)} now={now} rolled={isCollapsed ? rollup(graph, n.id) : undefined} />
              {kids.length ? (
                <button
                  type="button"
                  onClick={() => onToggle(n.id)}
                  title={isCollapsed ? `Show ${kids.length} children` : 'Collapse'}
                  aria-label={isCollapsed ? `Expand ${n.name}` : `Collapse ${n.name}`}
                  className="absolute -right-3 top-1/2 z-10 flex h-6 min-w-6 -translate-y-1/2 items-center justify-center rounded-full border border-edge-default bg-surface-raised px-1 text-[10px] font-semibold text-content-muted shadow-sm hover:text-content"
                >
                  {isCollapsed ? `+${kids.length}` : '–'}
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function KindIcon({ node, className }: { node: Pick<CompNode, 'group' | 'kind' | 'source'>; className?: string }) {
  return (
    <span
      className={cn('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold uppercase tracking-tight ring-1 ring-inset', FAMILY_TONE[kindFamily(node)], className)}
      aria-hidden
    >
      {kindAbbr(node.kind)}
    </span>
  )
}

function SyncMark({ sync }: { sync?: string }) {
  if (!sync) return null
  if (sync === 'Synced') return <span className="text-emerald-600 dark:text-emerald-400" title="Synced">✓ synced</span>
  if (sync === 'OutOfSync') return <span className="font-medium text-amber-700 dark:text-amber-300" title="Out of sync">↻ out of sync</span>
  return <span title={sync}>{sync}</span>
}

function NodeCard({ node, selected, onClick, now, rolled }: { node: CompNode; selected: boolean; onClick(): void; now: number; rolled?: HealthLevel }) {
  const bad = isUnhealthy(node.status.level) && node.status.level !== 'progressing'
  return (
    <button
      type="button"
      onClick={onClick}
      title={[node.status.reason, node.status.message].filter(Boolean).join(': ') || undefined}
      className={cn(
        'flex h-full w-full items-center gap-2 rounded-lg border bg-surface-raised px-2 text-left shadow-sm transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        selected ? 'border-brand-500 ring-2 ring-brand-500/30' : bad ? 'border-rose-300 dark:border-rose-500/40' : 'border-edge-default',
      )}
    >
      <KindIcon node={node} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[12px] font-medium text-content">{node.name}</span>
        <span className="block truncate text-[11px] text-content-subtle">
          {node.kind}
          {node.namespace ? ` · ${node.namespace}` : ''}
        </span>
        <span className="flex items-center gap-1.5 truncate text-[11px] text-content-muted">
          <span className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full', LEVEL_DOT[node.status.level])} aria-hidden />
          <span className="truncate">{node.status.label}</span>
          <SyncMark sync={node.status.sync} />
          {rolled && rolled !== node.status.level && isUnhealthy(rolled) ? (
            <span className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full ring-2 ring-surface-raised', LEVEL_DOT[rolled])} title={`Something below is ${rolled}`} />
          ) : null}
          <span className="ml-auto shrink-0 text-content-subtle">{age(node.createdAt, now)}</span>
        </span>
      </span>
    </button>
  )
}

/* ───────────────────────── list view ───────────────────────── */

function ListView({ graph, visible, collapsed, onToggle, selected, onSelect, now }: ViewProps) {
  const rows = useMemo(() => flatten(graph, visible, collapsed), [graph, visible, collapsed])
  return (
    <div className="overflow-x-auto rounded-lg border border-edge-default">
      <table className="w-full min-w-[520px] text-left text-xs">
        <thead className="bg-surface-sunken text-[11px] uppercase tracking-wide text-content-subtle">
          <tr>
            <th className="px-3 py-2 font-medium">Resource</th>
            <th className="hidden px-3 py-2 font-medium md:table-cell">Namespace</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="hidden px-3 py-2 font-medium sm:table-cell">Detail</th>
            <th className="px-3 py-2 text-right font-medium">Age</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-edge-default bg-surface-raised">
          {rows.map(({ node: n, depth, hasChildren }) => {
            const isCollapsed = collapsed.has(n.id)
            return (
              <tr
                key={n.id}
                onClick={() => onSelect(n.id)}
                className={cn('cursor-pointer hover:bg-surface-sunken/60', selected === n.id && 'bg-brand-50/60 dark:bg-brand-500/10')}
              >
                <td className="px-3 py-1.5">
                  <div className="flex items-center gap-2" style={{ paddingLeft: depth * 16 }}>
                    {hasChildren ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onToggle(n.id)
                        }}
                        aria-label={isCollapsed ? `Expand ${n.name}` : `Collapse ${n.name}`}
                        className="flex h-4 w-4 items-center justify-center rounded text-content-subtle hover:bg-surface-sunken hover:text-content"
                      >
                        <svg viewBox="0 0 24 24" className={cn('h-3 w-3 fill-current transition-transform', !isCollapsed && 'rotate-90')} aria-hidden>
                          <path d="M9 6l6 6-6 6z" />
                        </svg>
                      </button>
                    ) : (
                      <span className="w-4" />
                    )}
                    <KindIcon node={n} className="h-6 w-6 text-[9px]" />
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[12px] text-content">{n.name}</span>
                      <span className="block truncate text-[11px] text-content-subtle">{n.kind}</span>
                    </span>
                  </div>
                </td>
                <td className="hidden whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-content-muted md:table-cell">{n.namespace ?? '—'}</td>
                <td className="px-3 py-1.5">
                  <div className="flex flex-col items-start gap-0.5">
                    <StatusBadge kind={LEVEL_KIND[n.status.level]} pulse={false}>{n.status.label}</StatusBadge>
                    {n.status.sync ? <span className="text-[11px]"><SyncMark sync={n.status.sync} /></span> : null}
                  </div>
                </td>
                <td className="hidden max-w-[22rem] px-3 py-1.5 text-[11px] text-content-muted sm:table-cell">
                  <span className="line-clamp-2">{[n.status.reason, n.status.message].filter(Boolean).join(': ') || '—'}</span>
                </td>
                <td className="px-3 py-1.5 text-right text-content-subtle">{age(n.createdAt, now)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ───────────────────────── node detail ───────────────────────── */

type DetailTab = 'summary' | 'events' | 'yaml'

function NodeDetail({ graph, node, roots, onClose, onSelect, now }: {
  graph: CompositionGraph
  node: CompNode
  roots: CompositionRoots
  onClose(): void
  onSelect(id: string): void
  now: number
}) {
  const [tab, setTab] = useState<DetailTab>('summary')
  const toast = useToast()
  const ref = { group: node.group, version: node.version, kind: node.kind, name: node.name, namespace: node.namespace }
  // Argo-tree nodes were never read from the apiserver; read on demand.
  const live = useLiveObject(roots.discovery, ref, tab === 'yaml' && !node.object && !node.error)
  const events = useObjectEvents(ref, tab === 'events')
  const object = node.object ?? live.data

  // Escape closes this panel, not the drawer under it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      e.preventDefault()
      onClose()
    }
    globalThis.addEventListener('keydown', onKey, true)
    return () => globalThis.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const copy = (v: string, what: string) =>
    navigator.clipboard.writeText(v).then(() => toast.success(`Copied ${what}`, { description: v })).catch(() => toast.error('Could not copy'))

  const fields: Array<[string, ReactNode]> = [
    ['API version', apiVersionOf(node) ?? (node.group || 'v1')],
    ['Namespace', node.namespace ?? '— (cluster-scoped)'],
    ['Created', node.createdAt ? `${new Date(node.createdAt).toLocaleString()} (${age(node.createdAt, now)} ago)` : '—'],
    ['UID', node.uid ?? '—'],
  ]
  if (node.composition) fields.push(['Composition', node.composition])
  if (node.compositionRevision) fields.push(['Composition revision', node.compositionRevision])
  if (node.argoApp) fields.push(['Argo CD app', node.argoApp.name])
  if (node.status.sync) fields.push(['Sync', node.status.sync])
  if (node.status.health) fields.push(['Health', node.status.health])

  const panel = (
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label={`${node.kind} ${node.name}`}>
      <button type="button" className="absolute inset-0 bg-slate-900/20 dark:bg-black/40" aria-label="Close details" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-[600px] flex-col border-l border-edge-default bg-surface-canvas shadow-2xl">
        <div className="flex items-start gap-3 border-b border-edge-default px-4 py-3">
          <KindIcon node={node} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate font-mono text-sm font-semibold text-content">{node.name}</h3>
              <button type="button" className="text-[11px] text-content-subtle hover:text-content" onClick={() => copy(node.name, 'name')} title="Copy name">
                copy
              </button>
            </div>
            <div className="truncate text-xs text-content-subtle">
              {node.kind}
              {node.namespace ? ` · ${node.namespace}` : ''}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <StatusBadge kind={LEVEL_KIND[node.status.level]}>{node.status.label}</StatusBadge>
              {node.status.sync ? <span className="text-[11px]"><SyncMark sync={node.status.sync} /></span> : null}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Segmented<DetailTab>
              value={tab}
              onChange={setTab}
              ariaLabel="Detail section"
              options={[
                { value: 'summary', label: 'Summary' },
                { value: 'events', label: 'Events' },
                { value: 'yaml', label: 'YAML' },
              ]}
            />
            <IconBtn label="Close" onClick={onClose}>
              <path d="M6.4 5L5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z" />
            </IconBtn>
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {tab === 'summary' ? (
            <>
              {node.status.reason || node.status.message ? (
                <div className={cn('rounded-md px-3 py-2 text-xs ring-1 ring-inset', node.status.level === 'degraded' ? 'bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-200 dark:ring-rose-400/25' : 'bg-surface-sunken text-content ring-edge-default')}>
                  {node.status.reason ? <span className="font-semibold">{node.status.reason}</span> : null}
                  {node.status.reason && node.status.message ? ': ' : null}
                  {node.status.message ? <span className="whitespace-pre-wrap break-words">{node.status.message}</span> : null}
                </div>
              ) : null}
              {node.error ? (
                <p className="text-xs text-content-muted">
                  {node.error.status === 403
                    ? 'Your Kubernetes role cannot read this object, so its status is unknown.'
                    : node.error.status === 404
                      ? 'This resource is referenced but does not exist (or its CRD is not installed).'
                      : `Could not read it: ${node.error.message}`}
                </p>
              ) : null}
              <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-[9rem_1fr]">
                {fields.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-content-subtle">{k}</dt>
                    <dd className="break-all font-mono text-content">{v}</dd>
                  </div>
                ))}
              </dl>

              {node.conditions.length ? (
                <section>
                  <h4 className="mb-1.5 text-xs font-semibold text-content">Conditions</h4>
                  <div className="overflow-x-auto rounded-md border border-edge-default">
                    <table className="w-full min-w-[460px] text-left text-xs">
                      <thead className="bg-surface-sunken text-[11px] text-content-subtle">
                        <tr>
                          <th className="px-2 py-1.5 font-medium">Type</th>
                          <th className="px-2 py-1.5 font-medium">Status</th>
                          <th className="px-2 py-1.5 font-medium">Reason / message</th>
                          <th className="px-2 py-1.5 text-right font-medium">Since</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-edge-default">
                        {node.conditions.map((c) => (
                          <tr key={c.type} className="align-top">
                            <td className="px-2 py-1.5 font-medium text-content">{c.type}</td>
                            <td className="px-2 py-1.5">
                              <StatusBadge kind={c.status === 'True' ? 'healthy' : c.status === 'False' ? 'degraded' : 'unknown'} pulse={false}>{c.status}</StatusBadge>
                            </td>
                            <td className="px-2 py-1.5 text-content-muted">
                              {c.reason ? <span className="font-medium text-content">{c.reason}</span> : null}
                              {c.message ? <div className="whitespace-pre-wrap break-words">{c.message}</div> : null}
                            </td>
                            <td className="px-2 py-1.5 text-right text-content-subtle">{age(c.lastTransitionTime, now)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ) : null}

              {node.info?.length ? (
                <section>
                  <h4 className="mb-1.5 text-xs font-semibold text-content">Info</h4>
                  <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-1 text-xs">
                    {node.info.map((i) => (
                      <div key={i.name} className="contents">
                        <dt className="text-content-subtle">{i.name}</dt>
                        <dd className="break-all text-content">{i.value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ) : null}

              <RelatedList title="Parents" ids={node.parents} graph={graph} onSelect={onSelect} />
              <RelatedList title="Children" ids={node.children} graph={graph} onSelect={onSelect} />
            </>
          ) : null}

          {tab === 'events' ? (
            events.isLoading ? (
              <div className="flex items-center gap-2 text-xs text-content-muted"><Spinner size={14} /> Loading events…</div>
            ) : events.error ? (
              <p className="text-xs text-content-muted">
                {(events.error as { status?: number }).status === 403 ? 'Your role cannot list events in this namespace.' : `Could not load events: ${events.error instanceof Error ? events.error.message : String(events.error)}`}
              </p>
            ) : !events.data?.length ? (
              <p className="text-xs text-content-muted">No recent events for this object. Kubernetes keeps events for about an hour.</p>
            ) : (
              <ul className="space-y-2">
                {events.data.map((e, i) => (
                  <li key={i} className="rounded-md border border-edge-default bg-surface-raised px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge kind={e.type === 'Warning' ? 'degraded' : 'info'} pulse={false}>{e.type}</StatusBadge>
                      <span className="font-medium text-content">{e.reason}</span>
                      {e.count > 1 ? <span className="text-content-subtle">×{e.count}</span> : null}
                      <span className="ml-auto text-content-subtle">{age(e.at, now)} ago</span>
                    </div>
                    <div className="mt-1 whitespace-pre-wrap break-words text-content-muted">{e.message}</div>
                    {e.source ? <div className="mt-0.5 text-[11px] text-content-subtle">{e.source}</div> : null}
                  </li>
                ))}
              </ul>
            )
          ) : null}

          {tab === 'yaml' ? (
            object ? (
              <CodeViewer value={object} filename={`${node.kind.toLowerCase()}-${node.name}`} ariaLabel={`${node.kind} ${node.name} YAML`} height="calc(100vh - 220px)" />
            ) : live.isLoading ? (
              <div className="flex items-center gap-2 text-xs text-content-muted"><Spinner size={14} /> Reading the live object…</div>
            ) : (
              <p className="text-xs text-content-muted">
                {node.error
                  ? node.error.status === 403 ? 'Your role cannot read this object.' : node.error.message
                  : live.error
                    ? `Could not read it: ${live.error instanceof Error ? live.error.message : String(live.error)}`
                    : 'No live object.'}
              </p>
            )
          ) : null}
        </div>
      </div>
    </div>
  )
  return typeof document === 'undefined' ? null : createPortal(panel, document.body)
}

function RelatedList({ title, ids, graph, onSelect }: { title: string; ids: string[]; graph: CompositionGraph; onSelect(id: string): void }) {
  if (!ids.length) return null
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-semibold text-content">{title} <span className="font-normal text-content-subtle">({ids.length})</span></h4>
      <ul className="flex flex-wrap gap-1.5">
        {ids.map((id) => {
          const n = graph.nodes[id]
          if (!n) return null
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => onSelect(id)}
                className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-[11px] hover:bg-surface-sunken"
              >
                <span className={cn('inline-block h-1.5 w-1.5 rounded-full', LEVEL_DOT[n.status.level])} aria-hidden />
                <span className="text-content-subtle">{n.kind}</span>
                <span className="font-mono text-content">{n.name}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
