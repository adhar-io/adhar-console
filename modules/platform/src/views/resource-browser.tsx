import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Button,
  DataTable,
  EmptyState,
  POLL_FLOOR_MS,
  Spinner,
  StatusBadge,
  useMediaQuery,
  useToast,
  type Column,
} from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { kube } from '@adhar/api-clients/k8s'
import type { DiscoveredResource, GatewayGVR as GVR, KubeObject } from '@adhar/api-clients/k8s'
import { clusterParam, useActiveCluster, useActiveNamespace } from '../data/client.ts'
import { age } from '../data/format.ts'
import { useDiscovery, useLiveList, type LiveStatus } from '../data/live.ts'
import {
  apiVersionOf,
  browsableKinds,
  cellsFor,
  cellText,
  deriveStatus,
  type DerivedStatus,
  groupLabel,
  indexTableRows,
  kindKey,
  kindParam,
  type PrinterColumn,
  printerColumns,
  pushRecent,
  resolveKind,
  togglePin,
  type Tone,
} from '../data/explore.ts'
import { useExploreLink, useResourceTable, useStoredList } from '../data/explore-hooks.ts'
import { useNamespaces } from '../data/hooks.ts'
import { matchesSearch, StatusFilterPills, type FilterPill } from './list-shell.tsx'
import { KindPicker, type KindPickerHandle, KindPickerSheet, StarGlyph } from './explore-kind-picker.tsx'
import { ExploreDrawer } from './explore-drawer.tsx'

/** GVR the live hook holds (disabled) while discovery is still resolving. */
/** Minimum gap between two printer-column Table snapshots. */
const TABLE_MIN_GAP_MS = 30_000

const IDLE_GVR: GVR = { group: '', version: 'v1', resource: 'namespaces', namespaced: false }

/** Rows rendered at once — the grid isn't virtualised; search narrows the rest. */
const RENDER_CAP = 500

/** Pins a fresh browser starts with — the kinds people reach for first. */
const DEFAULT_PINS = ['/pods', 'apps/deployments', '/services', '/configmaps']

const PINS_KEY = 'adhar.explore.pins'
const RECENTS_KEY = 'adhar.explore.recents'

type Bucket = 'healthy' | 'progressing' | 'degraded' | 'failed' | 'other'
const BUCKET_OF: Record<Tone, Bucket> = {
  healthy: 'healthy',
  progressing: 'progressing',
  degraded: 'degraded',
  paused: 'other',
  failed: 'failed',
  unknown: 'other',
  info: 'other',
}
const BUCKET_PILLS: Array<Omit<FilterPill<Bucket>, 'count'>> = [
  { value: 'healthy', label: 'Healthy', tone: 'emerald' },
  { value: 'progressing', label: 'Progressing', tone: 'sky' },
  { value: 'degraded', label: 'Degraded', tone: 'amber' },
  { value: 'failed', label: 'Failed', tone: 'rose' },
  { value: 'other', label: 'Other', tone: 'slate' },
]

interface Props {
  namespace?: string
}

const objKey = (o: KubeObject) => o.metadata.uid ?? `${o.metadata.namespace ?? ''}/${o.metadata.name}`
const objRef = (o: { namespace?: string; name: string }) => (o.namespace ? `${o.namespace}/${o.name}` : o.name)
function parseRef(ref: string | undefined, namespaced: boolean): { namespace?: string; name: string } | null {
  if (!ref) return null
  const i = ref.indexOf('/')
  if (namespaced && i > 0) return { namespace: ref.slice(0, i), name: ref.slice(i + 1) }
  return { name: i >= 0 && !namespaced ? ref.slice(i + 1) : ref }
}

/**
 * Explore — a Lens / k9s-grade browser for every kind the cluster serves.
 *
 *   ┌ kinds ────────┐ ┌ Deployment · apps/v1 · 12 ● live ───── [☆] [copy] ┐
 *   │ / find…       │ │ Healthy 10 · Progressing 2                         │
 *   │ Pinned        │ │ [search] [label selector] [namespace]       [⟳]   │
 *   │ Recent        │ │ NAME  NAMESPACE  STATUS  READY  UP-TO-DATE  AGE    │
 *   │ Core ▸ Apps ▸ │ │ …live rows… → click opens the detail drawer        │
 *   └───────────────┘ └────────────────────────────────────────────────────┘
 *
 * Kinds come from API discovery. Rows are a live watch; the columns are the
 * apiserver's own Table rendering (kubectl's printer columns, CRDs'
 * `additionalPrinterColumns` included), refreshed whenever the watch moves.
 * On phones the kind rail becomes a bottom sheet behind the title. The
 * selection is deep-linkable: `?section=explore&kind=deployments.apps&obj=ns/name`.
 */
export function ResourceBrowser({ namespace: initialNamespace }: Props = {}) {
  const toast = useToast()
  const discovery = useDiscovery()
  const wide = useMediaQuery('(min-width: 1024px)')
  const { namespace: activeNs, setNamespace } = useActiveNamespace()
  const namespace = activeNs ?? initialNamespace
  const [link, setLink] = useExploreLink()
  const [pins, setPins] = useStoredList(PINS_KEY, DEFAULT_PINS)
  const [recents, setRecents] = useStoredList(RECENTS_KEY)
  const [sheetOpen, setSheetOpen] = useState(false)
  const pickerRef = useRef<KindPickerHandle>(null)

  const kinds = useMemo(() => browsableKinds(discovery.data), [discovery.data])
  const selected = useMemo(
    () => resolveKind(kinds, link.kind) ?? (link.kind ? undefined : resolveKind(kinds, 'pods') ?? kinds[0]),
    [kinds, link.kind],
  )
  const unknownKind = !!link.kind && kinds.length > 0 && !resolveKind(kinds, link.kind)

  const selectKind = useCallback(
    (k: DiscoveredResource) => {
      setLink({ kind: kindParam(k), obj: undefined })
      setRecents((r) => pushRecent(r, kindKey(k)))
    },
    [setLink, setRecents],
  )

  // `/` focuses the kind finder (rail) or opens the sheet (phone).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      e.preventDefault()
      if (wide) pickerRef.current?.focus()
      else setSheetOpen(true)
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [wide])

  const pickerProps = {
    kinds,
    loading: discovery.isLoading,
    error: discovery.isError ? ((discovery.error as Error)?.message ?? 'Discovery failed') : undefined,
    selectedKey: selected ? kindKey(selected) : null,
    pins,
    recents,
    namespace,
    onSelect: selectKind,
    onTogglePin: (key: string) => setPins((p) => togglePin(p, key)),
    onRetry: () => discovery.refetch(),
  }

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[16.5rem_minmax(0,1fr)] lg:gap-6">
      {wide ? (
        <aside className="sticky top-4 h-[calc(100dvh-9rem)] min-h-[24rem] self-start">
          <KindPicker ref={pickerRef} {...pickerProps} />
        </aside>
      ) : null}

      <div className="min-w-0 space-y-4">
        {!wide && !selected ? (
          <Button variant="secondary" block onClick={() => setSheetOpen(true)} trailing={<SwapGlyph />}>
            {discovery.isLoading ? 'Discovering resource types…' : 'Choose a resource type'}
          </Button>
        ) : null}

        {unknownKind ? (
          <EmptyState
            title="Resource type not served"
            description={
              <>
                This cluster's API has no <span className="font-mono">{link.kind}</span>. The CRD may have been removed, or
                the link is from another cluster.
              </>
            }
            action={
              <Button size="sm" variant="secondary" onClick={() => setLink({ kind: undefined, obj: undefined })}>
                Back to Pods
              </Button>
            }
          />
        ) : selected ? (
          <KindView
            key={`${kindKey(selected)}@${selected.version}`}
            kind={selected}
            kinds={kinds}
            namespace={namespace}
            onNamespace={setNamespace}
            pinned={pins.includes(kindKey(selected))}
            onTogglePin={() => {
              const key = kindKey(selected)
              const was = pins.includes(key)
              setPins((p) => togglePin(p, key))
              toast.success(was ? `Unpinned ${selected.kind}` : `Pinned ${selected.kind}`)
            }}
            objRefParam={link.obj}
            onObj={(obj) => setLink({ obj })}
            onOpenKind={(k, target) => {
              setRecents((r) => pushRecent(r, kindKey(k)))
              setLink({ kind: kindParam(k), obj: objRef(target) })
            }}
            onSwitchKind={wide ? undefined : () => setSheetOpen(true)}
            quick={wide ? null : <QuickKinds kinds={kinds} selected={selected} pins={pins} recents={recents} onSelect={selectKind} />}
          />
        ) : discovery.isLoading ? (
          <div className="h-64 animate-pulse rounded-xl border border-edge-default bg-surface-sunken/50" />
        ) : discovery.isError ? (
          <EmptyState
            title="Couldn't discover the cluster's API"
            description={(discovery.error as Error)?.message}
            action={<Button size="sm" variant="secondary" onClick={() => discovery.refetch()}>Try again</Button>}
          />
        ) : (
          <EmptyState title="No listable resources" description="Your identity can't list any resource type on this cluster." />
        )}
      </div>

      {!wide ? <KindPickerSheet open={sheetOpen} onClose={() => setSheetOpen(false)} {...pickerProps} /> : null}
    </div>
  )
}

/* ─── phone: one-tap chips for pinned + recent kinds ───────────────────── */

function QuickKinds({
  kinds,
  selected,
  pins,
  recents,
  onSelect,
}: {
  kinds: DiscoveredResource[]
  selected?: DiscoveredResource
  pins: string[]
  recents: string[]
  onSelect(k: DiscoveredResource): void
}) {
  const byKey = useMemo(() => new Map(kinds.map((k) => [kindKey(k), k])), [kinds])
  const quick = [...new Set([...pins, ...recents])]
    .map((k) => byKey.get(k))
    .filter((k): k is DiscoveredResource => !!k)
    .slice(0, 10)
  if (!quick.length) return null
  return (
    <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {quick.map((k) => {
        const on = selected && kindKey(k) === kindKey(selected)
        return (
          <button
            key={kindKey(k)}
            type="button"
            onClick={() => onSelect(k)}
            aria-pressed={!!on}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors pointer-coarse:py-2',
              on
                ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300'
                : 'border-edge-default bg-surface-raised text-content-muted hover:text-content',
            )}
          >
            {k.kind}
          </button>
        )
      })}
    </div>
  )
}

/* ─── one kind: header, filters, table, drawer ──────────────────────────── */

function KindView({
  kind,
  kinds,
  namespace,
  onNamespace,
  pinned,
  onTogglePin,
  objRefParam,
  onObj,
  onOpenKind,
  onSwitchKind,
  quick,
}: {
  kind: DiscoveredResource
  kinds: DiscoveredResource[]
  namespace?: string
  onNamespace(ns?: string): void
  pinned: boolean
  onTogglePin(): void
  objRefParam?: string
  onObj(ref: string | undefined): void
  onOpenKind(k: DiscoveredResource, target: { namespace?: string; name: string }): void
  /** Phones: the title opens the kind sheet. */
  onSwitchKind?(): void
  /** Phones: pinned / recent chips under the header. */
  quick?: ReactNode
}) {
  const toast = useToast()
  const { cluster } = useActiveCluster()
  const gvr: GVR = useMemo(
    () => ({ group: kind.group, version: kind.version, resource: kind.name, namespaced: kind.namespaced }),
    [kind],
  )
  const ns = kind.namespaced ? namespace : undefined
  const [search, setSearch] = useState('')
  const [selectorDraft, setSelectorDraft] = useState('')
  const [selector, setSelector] = useState('')
  const [bucket, setBucket] = useState<Bucket | 'all'>('all')
  const [showAll, setShowAll] = useState(false)

  // Debounce the label selector so typing doesn't restart the watch per key.
  useEffect(() => {
    const t = setTimeout(() => setSelector(selectorDraft.trim()), 400)
    return () => clearTimeout(t)
  }, [selectorDraft])

  const watchable = kind.verbs.includes('watch')
  const live = useLiveList(watchable ? gvr : IDLE_GVR, {
    namespace: ns,
    labelSelector: selector || undefined,
    enabled: watchable,
  })
  // List-only kinds (metrics.k8s.io, some aggregated APIs) can't be watched — poll.
  const polled = useQuery({
    queryKey: ['k8s', 'explore-list', gvr.group, gvr.version, gvr.resource, ns ?? '', selector, cluster],
    queryFn: () => kube.list(gvr, { namespace: ns, labelSelector: selector || undefined, cluster: clusterParam(cluster) }).then((l) => l.items),
    enabled: !watchable,
    refetchInterval: POLL_FLOOR_MS,
  })
  const items: KubeObject[] = watchable ? live.data : (polled.data ?? [])
  const loading = watchable ? live.isLoading : polled.isLoading
  const error = (watchable ? live.error : (polled.error as Error | null)) as (Error & { status?: number }) | null
  const liveStatus: LiveStatus | 'polling' = watchable ? live.status : 'polling'
  const refetch = () => (watchable ? live.refetch() : void polled.refetch())

  // Server-rendered printer columns; re-snapshot whenever the watch moves —
  // debounced, and at most once per TABLE_MIN_GAP_MS. The rows themselves are
  // live from the watch; only the printer-column cells lag, and a busy kind
  // (pods, events) would otherwise re-LIST the Table every couple of seconds.
  const signature = useMemo(() => items.map((o) => o.metadata.resourceVersion ?? '').join(','), [items])
  const [tableVersion, setTableVersion] = useState(0)
  const firstSig = useRef(true)
  const lastSnap = useRef(0)
  const pendingSnap = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (loading) return
    if (firstSig.current) {
      firstSig.current = false
      lastSnap.current = Date.now()
      return
    }
    // Throttle, not debounce: constant churn must not starve the snapshot.
    if (pendingSnap.current) return
    const wait = Math.max(2_000, TABLE_MIN_GAP_MS - (Date.now() - lastSnap.current))
    pendingSnap.current = setTimeout(() => {
      pendingSnap.current = undefined
      lastSnap.current = Date.now()
      setTableVersion((v) => v + 1)
    }, wait)
  }, [signature, loading])
  useEffect(() => () => clearTimeout(pendingSnap.current), [])
  const table = useResourceTable(gvr, { namespace: ns, labelSelector: selector || undefined, enabled: !error, version: tableVersion })
  const pcols = useMemo(() => printerColumns(table.data), [table.data])
  const cellIndex = useMemo(() => indexTableRows(table.data), [table.data])

  const statuses = useMemo(() => new Map(items.map((o) => [objKey(o), deriveStatus(o)])), [items])
  const hasStatus = useMemo(() => [...statuses.values()].some(Boolean), [statuses])
  const bucketCounts = useMemo(() => {
    const c: Partial<Record<Bucket, number>> = {}
    for (const s of statuses.values()) if (s) c[BUCKET_OF[s.tone]] = (c[BUCKET_OF[s.tone]] ?? 0) + 1
    return c
  }, [statuses])

  const filtered = useMemo(() => {
    const q = search.trim()
    return items.filter((o) => {
      if (bucket !== 'all') {
        const s = statuses.get(objKey(o))
        if (!s || BUCKET_OF[s.tone] !== bucket) return false
      }
      return !q || matchesSearch(o.metadata.name, q) || matchesSearch(o.metadata.namespace, q)
    })
  }, [items, search, bucket, statuses])
  const rows = showAll ? filtered : filtered.slice(0, RENDER_CAP)

  const columns = useMemo(
    () => buildColumns({ showNamespace: kind.namespaced && !ns, hasStatus, pcols, cellIndex, statuses, onNamespace }),
    [kind.namespaced, ns, hasStatus, pcols, cellIndex, statuses, onNamespace],
  )

  const target = parseRef(objRefParam, kind.namespaced)
  const liveObj = target
    ? items.find((o) => o.metadata.name === target.name && (!kind.namespaced || o.metadata.namespace === target.namespace))
    : undefined

  const copyList = async () => {
    const cmd = `kubectl get ${kindParam(kind)}${kind.namespaced ? (ns ? ` -n ${ns}` : ' -A') : ''}${selector ? ` -l '${selector}'` : ''}`
    try {
      await navigator.clipboard.writeText(cmd)
      toast.success('Copied kubectl command', { description: <span className="break-all font-mono text-[11px]">{cmd}</span> })
    } catch {
      toast.error('Clipboard unavailable', { description: 'Your browser blocked clipboard access.' })
    }
  }

  const filtersActive = !!(search || selector || bucket !== 'all')
  const scopeText = kind.namespaced ? (ns ? `in ${ns}` : 'in all namespaces') : 'cluster-scoped'

  return (
    <div className="space-y-4">
      {/* Kind header — identity on the left, actions on the right. */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            {onSwitchKind ? (
              <button
                type="button"
                onClick={onSwitchKind}
                aria-label={`${kind.kind} — change resource type`}
                className="-mx-1 inline-flex min-w-0 items-center gap-1.5 rounded-md px-1 text-xl font-semibold tracking-tight text-content hover:bg-surface-sunken"
              >
                <span className="truncate">{kind.kind}</span>
                <SwapGlyph />
              </button>
            ) : (
              <h2 className="text-xl font-semibold tracking-tight text-content">{kind.kind}</h2>
            )}
            {error ? null : <span className="font-mono text-sm tabular-nums text-content-muted">{loading ? '…' : items.length}</span>}
            <LiveDot status={liveStatus} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-content-muted">
            <span className="font-mono">{apiVersionOf(kind)}</span>
            <span aria-hidden className="text-content-subtle">·</span>
            <span>{groupLabel(kind.group)}</span>
            <span aria-hidden className="text-content-subtle">·</span>
            <span>{scopeText}</span>
            {kind.shortNames?.length ? (
              <>
                <span aria-hidden className="hidden text-content-subtle sm:inline">·</span>
                <span className="hidden font-mono text-content-subtle sm:inline">{kind.shortNames.join(', ')}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={onTogglePin}
            aria-pressed={pinned}
            aria-label={pinned ? `Unpin ${kind.kind}` : `Pin ${kind.kind}`}
            title={pinned ? 'Unpin from the resource list' : 'Pin to the top of the resource list'}
            leading={<span className={pinned ? 'text-amber-500' : undefined}><StarGlyph filled={pinned} /></span>}
          >
            <span className="hidden sm:inline">{pinned ? 'Pinned' : 'Pin'}</span>
          </Button>
          <Button size="sm" variant="secondary" onClick={copyList} leading={<TerminalGlyph />} aria-label="Copy kubectl command" title="Copy the equivalent kubectl get">
            <span className="hidden sm:inline">kubectl</span>
          </Button>
        </div>
      </div>

      {quick}

      {/* Toolbar — phones: search + refresh, then selector + namespace; one row from sm. */}
      <div className="flex flex-col gap-2 rounded-xl border border-edge-default bg-surface-raised p-2 shadow-sm sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-center gap-2 sm:w-72 sm:shrink-0">
          <TextField
            value={search}
            onChange={setSearch}
            placeholder={kind.namespaced && !ns ? 'Search name or namespace…' : 'Search by name…'}
            label="Search objects"
            icon={<SearchGlyph />}
            className="flex-1"
          />
          <RefreshButton onClick={refetch} busy={table.isFetching && !loading} className="sm:hidden" />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <TextField
            value={selectorDraft}
            onChange={setSelectorDraft}
            placeholder="Label selector (app=web)"
            label="Label selector"
            mono
            active={!!selector}
            className="min-w-0 flex-1 sm:w-56 sm:flex-none"
          />
          {kind.namespaced ? <NamespaceSelect value={ns} onChange={onNamespace} /> : null}
        </div>
        <div className="hidden items-center gap-3 sm:ml-auto sm:flex">
          {filtered.length !== items.length ? (
            <span className="font-mono text-[11px] tabular-nums text-content-subtle">
              {filtered.length} / {items.length}
            </span>
          ) : null}
          <RefreshButton onClick={refetch} busy={table.isFetching && !loading} />
        </div>
      </div>

      {error ? (
        <ListError error={error} kind={kind} namespace={ns} selector={selector} onRetry={refetch} onAllNamespaces={() => onNamespace(undefined)} />
      ) : (
        <>
          <DataTable<KubeObject>
            tableId={`explore:${kindKey(kind)}`}
            toolbar={
              hasStatus ? (
                <StatusFilterPills<Bucket>
                  value={bucket}
                  onChange={setBucket}
                  pills={BUCKET_PILLS.map((p) => ({ ...p, count: bucketCounts[p.value] ?? 0 })).filter((p) => p.count > 0 || p.value === bucket)}
                />
              ) : undefined
            }
            features={{ columns: true, export: true }}
            loading={loading}
            columns={columns}
            rows={rows}
            rowKey={objKey}
            onRowClick={(o) => onObj(objRef({ namespace: o.metadata.namespace, name: o.metadata.name }))}
            defaultSort={{ key: 'name', dir: 'asc' }}
            empty={
              <EmptyState
                title={filtersActive ? `No ${kind.kind} match` : `No ${kind.kind} ${kind.namespaced ? scopeText : 'yet'}`}
                description={
                  filtersActive
                    ? 'Nothing matches the search, label selector or status filter.'
                    : kind.namespaced && ns
                      ? `There are no ${kind.name} in ${ns}. Try all namespaces.`
                      : `The cluster has no ${kind.name}.`
                }
                action={
                  filtersActive ? (
                    <Button size="sm" variant="secondary" onClick={() => { setSearch(''); setSelectorDraft(''); setBucket('all') }}>
                      Clear filters
                    </Button>
                  ) : kind.namespaced && ns ? (
                    <Button size="sm" variant="secondary" onClick={() => onNamespace(undefined)}>
                      All namespaces
                    </Button>
                  ) : undefined
                }
              />
            }
          />
          {filtered.length > rows.length ? (
            <div className="flex flex-wrap items-center justify-center gap-2 py-1 text-xs text-content-muted">
              Showing {rows.length} of {filtered.length} — search or filter to narrow it down, or
              <button type="button" onClick={() => setShowAll(true)} className="font-medium text-brand-700 hover:underline dark:text-brand-300">
                render all
              </button>
            </div>
          ) : null}
        </>
      )}

      {target ? (
        <ExploreDrawer
          key={`${kindKey(kind)}:${objRefParam}`}
          kind={kind}
          kinds={kinds}
          live={liveObj}
          target={target}
          printer={{ columns: pcols, cells: liveObj ? cellsFor(cellIndex, liveObj.metadata) : undefined }}
          onClose={() => onObj(undefined)}
          onOpen={(k, t) => (kindKey(k) === kindKey(kind) ? onObj(objRef(t)) : onOpenKind(k, t))}
          onFilterLabel={(sel) => {
            setSelectorDraft(sel)
            setSelector(sel)
            onObj(undefined)
            toast.info(`Filtering ${kind.name} by ${sel}`)
          }}
        />
      ) : null}
    </div>
  )
}

/* ─── columns ───────────────────────────────────────────────────────────── */

function buildColumns({
  showNamespace,
  hasStatus,
  pcols,
  cellIndex,
  statuses,
  onNamespace,
}: {
  showNamespace: boolean
  hasStatus: boolean
  pcols: PrinterColumn[]
  cellIndex: Map<string, unknown[]>
  statuses: Map<string, DerivedStatus | null>
  onNamespace(ns?: string): void
}): Column<KubeObject>[] {
  const cols: Column<KubeObject>[] = [
    {
      key: 'name',
      header: 'Name',
      pinned: true,
      minWidth: 160,
      value: (o) => o.metadata.name,
      cell: (o) => (
        <span className="block max-w-[28rem] truncate font-medium text-content" title={o.metadata.name}>
          {o.metadata.name}
        </span>
      ),
    },
  ]
  if (showNamespace) {
    cols.push({
      key: 'namespace',
      header: 'Namespace',
      value: (o) => o.metadata.namespace ?? '',
      cell: (o) =>
        o.metadata.namespace ? (
          <button
            type="button"
            title={`Show only ${o.metadata.namespace}`}
            onClick={(e) => {
              e.stopPropagation()
              onNamespace(o.metadata.namespace)
            }}
            className="text-content-muted hover:text-brand-700 hover:underline dark:hover:text-brand-300"
          >
            {o.metadata.namespace}
          </button>
        ) : (
          <span className="text-content-subtle">—</span>
        ),
    })
  }
  if (hasStatus) {
    cols.push({
      key: 'status',
      header: 'Status',
      value: (o) => statuses.get(objKey(o))?.text ?? '',
      cell: (o) => {
        const s = statuses.get(objKey(o))
        if (!s) return <span className="text-content-subtle">—</span>
        return (
          <span title={s.detail} className="inline-flex max-w-[16rem]">
            <StatusBadge kind={s.tone} className="max-w-full truncate">{s.text}</StatusBadge>
          </span>
        )
      },
    })
  }
  for (const pc of pcols) {
    const numeric = pc.type === 'integer' || pc.type === 'number'
    const raw = (o: KubeObject) => cellsFor(cellIndex, o.metadata)?.[pc.index]
    cols.push({
      key: `pc:${pc.name}`,
      header: <span title={pc.description}>{pc.name}</span>,
      numeric,
      // The derived Status badge already covers kubectl's STATUS column.
      defaultHidden: pc.wide || (hasStatus && pc.name.toLowerCase() === 'status'),
      value: (o) => {
        const v = raw(o)
        if (v === undefined || v === null || v === '') return null
        if (numeric) return typeof v === 'number' ? v : Number(v)
        if (pc.type === 'date') return new Date(String(v))
        return cellText(v)
      },
      cell: (o) => {
        const v = raw(o)
        const text = pc.type === 'date' && v ? age(String(v)) : cellText(v)
        if (!text) return <span className="text-content-subtle">—</span>
        return (
          <span className={cn('block max-w-[18rem] truncate', numeric ? 'font-mono tabular-nums' : 'text-content-muted')} title={cellText(v)}>
            {text}
          </span>
        )
      },
    })
  }
  cols.push({
    key: 'age',
    header: 'Age',
    // Sort on the timestamp, not the "5d" label.
    value: (o) => (o.metadata.creationTimestamp ? -new Date(o.metadata.creationTimestamp).getTime() : null),
    cell: (o) => (
      <span className="font-mono text-[12px] tabular-nums text-content-muted" title={o.metadata.creationTimestamp ? new Date(o.metadata.creationTimestamp).toLocaleString() : undefined}>
        {age(o.metadata.creationTimestamp)}
      </span>
    ),
  })
  return cols
}

/* ─── states ────────────────────────────────────────────────────────────── */

function ListError({
  error,
  kind,
  namespace,
  selector,
  onRetry,
  onAllNamespaces,
}: {
  error: Error & { status?: number }
  kind: DiscoveredResource
  namespace?: string
  selector: string
  onRetry(): void
  onAllNamespaces(): void
}) {
  const msg = error.message ?? ''
  const status = error.status
  if (status === 403 || /forbidden/i.test(msg)) {
    return (
      <EmptyState
        title={`No access to ${kind.name}`}
        description={
          <>
            Your identity can't list <span className="font-mono">{kindParam(kind)}</span>{' '}
            {kind.namespaced ? (namespace ? `in ${namespace}` : 'across all namespaces') : 'on this cluster'}. Kubernetes RBAC
            decides this — ask a platform admin for a Role{kind.namespaced && !namespace ? ', or pick a namespace you work in' : ''}.
          </>
        }
      />
    )
  }
  if (status === 404 || /not ?found|could not find the requested resource/i.test(msg)) {
    return (
      <EmptyState
        title={`${kind.kind} isn't served any more`}
        description={`The apiserver no longer serves ${apiVersionOf(kind)}/${kind.name}. Its CRD or API service may have been removed or upgraded.`}
        action={<Button size="sm" variant="secondary" onClick={onRetry}>Retry</Button>}
      />
    )
  }
  if (selector && (status === 400 || /selector/i.test(msg))) {
    return <EmptyState title="Invalid label selector" description={msg} />
  }
  return (
    <EmptyState
      title={`Couldn't list ${kind.name}`}
      description={msg || 'The watch failed.'}
      action={
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={onRetry}>Retry</Button>
          {kind.namespaced && namespace ? <Button size="sm" variant="ghost" onClick={onAllNamespaces}>All namespaces</Button> : null}
        </div>
      }
    />
  )
}

function LiveDot({ status }: { status: LiveStatus | 'polling' }) {
  const tone =
    status === 'live'
      ? 'text-emerald-600 dark:text-emerald-400'
      : status === 'error'
        ? 'text-rose-600 dark:text-rose-400'
        : status === 'polling'
          ? 'text-sky-600 dark:text-sky-400'
          : 'text-amber-600 dark:text-amber-400'
  const label = status === 'polling' ? 'polling' : status
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-medium', tone)} title={status === 'polling' ? 'This API has no watch — refreshed every 15s' : undefined}>
      <span className={cn('h-1.5 w-1.5 rounded-full bg-current', status !== 'live' && status !== 'polling' && 'animate-pulse')} />
      {label}
    </span>
  )
}

/* ─── toolbar controls ──────────────────────────────────────────────────── */

const FIELD =
  'h-9 w-full rounded-lg border bg-surface-raised text-sm text-content placeholder:text-content-subtle ' +
  'focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20 pointer-coarse:h-11'

function TextField({
  value,
  onChange,
  placeholder,
  label,
  icon,
  mono,
  active,
  className,
}: {
  value: string
  onChange(v: string): void
  placeholder: string
  label: string
  icon?: ReactNode
  mono?: boolean
  /** Highlight the border while the value is applied (e.g. a live selector). */
  active?: boolean
  className?: string
}) {
  return (
    <div className={cn('relative', className)}>
      {icon ? <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle">{icon}</span> : null}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation()
            onChange('')
          }
        }}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        className={cn(
          FIELD,
          icon ? 'pl-8' : 'pl-2.5',
          'pr-7',
          mono && 'font-mono text-xs placeholder:font-sans',
          active ? 'border-brand-300 dark:border-brand-500/40' : 'border-edge-default',
        )}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={`Clear ${label.toLowerCase()}`}
          className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-content-subtle hover:bg-surface-sunken hover:text-content"
        >
          <ClearGlyph />
        </button>
      ) : null}
    </div>
  )
}

/** The shared namespace selection (the top bar's), as a compact select. */
function NamespaceSelect({ value, onChange }: { value?: string; onChange(ns?: string): void }) {
  const q = useNamespaces()
  const names = useMemo(() => {
    const all = (q.data ?? []).map((n) => n.metadata.name).filter(Boolean)
    // Keep a selection the list doesn't include (no list RBAC, other org) selectable.
    if (value && !all.includes(value)) all.push(value)
    return all.sort()
  }, [q.data, value])
  return (
    <div className="relative w-[42%] shrink-0 sm:w-48">
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        aria-label="Namespace"
        className={cn(FIELD, 'appearance-none truncate border-edge-default pl-2.5 pr-7')}
      >
        <option value="">All namespaces</option>
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <span aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-content-subtle">
        <ChevronDown />
      </span>
    </div>
  )
}

function RefreshButton({ onClick, busy, className }: { onClick(): void; busy?: boolean; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Refresh"
      title="Relist and rewatch"
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-edge-default bg-surface-raised text-content-muted transition-colors pointer-coarse:h-11 pointer-coarse:w-11',
        'hover:border-brand-300 hover:text-brand-700 dark:hover:text-brand-300',
        className,
      )}
    >
      {busy ? <Spinner size={14} /> : <RefreshGlyph />}
    </button>
  )
}

function SearchGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

function ClearGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function RefreshGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  )
}

function ChevronDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function SwapGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-content-subtle">
      <path d="m7 15 5 5 5-5" />
      <path d="m7 9 5-5 5 5" />
    </svg>
  )
}

function TerminalGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m4 17 6-5-6-5" />
      <path d="M12 19h8" />
    </svg>
  )
}

export default ResourceBrowser
