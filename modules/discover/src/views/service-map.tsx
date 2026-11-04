import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, PageHeader, useLiveFlows, useLiveK8sList, useToast } from '@adhar/shell-ui'
import { isPlatformNamespace, cn } from '@adhar/utils'
import { buildGraph, GRAPH_SOURCES } from '../data/service-graph.ts'
import { useInstantSet, useMetricNames } from '../data/prom.ts'
import { readParams, replaceParams } from '../data/discover-links.ts'
import { incrementalLayout, layoutMap, type MapLayout, nodeSetKey, type Pos } from '../data/flow-layout.ts'
import {
  applyFilters,
  collapseNamespaces,
  EMPTY_GRAPH,
  edgeEnds,
  type FeedRow,
  type FlowsFrame,
  fromFrame,
  fromPromGraph,
  type MapGraph,
  neighbourhood,
  newRetained,
  type Proto,
  retain,
  type TopoWorkload,
  withTopology,
} from '../data/live-flows.ts'
import { type CanvasHandle, MapCanvas } from './service-map-canvas.tsx'
import {
  Chip,
  EdgePanel,
  FlowFeed,
  HeaderStats,
  NamespacePicker,
  NodePanel,
  NoLiveSource,
  NoTraffic,
  PROTO_LABEL,
  ServiceList,
  SourceBadge,
  type SourceMode,
  useMediaQuery,
} from './service-map-panels.tsx'
import { Drawer, Segmented } from './discover-ui.tsx'
import { Loading, VizStyle } from './viz.tsx'

/**
 * Service map — the live traffic view.
 *
 * Source chain (best first, never invented):
 *   1. LIVE — Hubble flows pushed over the one `/api/live` socket (topic
 *      `flows`): the BFF holds a single Hubble Relay stream, aggregates it in
 *      1-second buckets and sends each viewer a frame every ~1.5 s with only
 *      the namespaces they may list pods in.
 *   2. 1-MINUTE METRICS — when no relay is reachable: caller → callee request
 *      metrics in Prometheus (Tempo service graphs, Istio, Hubble httpV2 with
 *      context labels), refreshed at the 60 s floor and labelled as such.
 *   3. TOPOLOGY — with "Idle" on, workloads from Kubernetes watches appear
 *      dimmed in the namespaces in view, so quiet components are still there.
 *
 * URL: `?section=servicemap&focus=<node>&edge=<src>><dst>&ns=a,b&win=15s|1m|5m
 *       &src=live|tempo|istio|hubble&q=&proto=http,dns&errors=1&drops=0&idle=1&nodes=1`
 * (old links with `win=5m|15m|1h` and a single `ns` still work).
 */

const WINDOWS = [
  { id: '15s', label: '15s', s: 15, prom: '1m' },
  { id: '1m', label: '1m', s: 60, prom: '1m' },
  { id: '5m', label: '5m', s: 300, prom: '5m' },
] as const
type Win = (typeof WINDOWS)[number]['id']
const RETAIN_MS = 20_000
const listParam = (v?: string) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : [])

function readFeedPref(): boolean {
  try {
    return localStorage.getItem('discover.servicemap.feed') !== '0'
  } catch {
    return true
  }
}

export function ServiceMap() {
  const boot = useMemo(readParams, [])
  const toast = useToast()
  const [win, setWin] = useState<Win>(() => (WINDOWS.some((w) => w.id === boot.win) ? (boot.win as Win) : boot.win ? '5m' : '1m'))
  const [ns, setNs] = useState<string[]>(() => listParam(boot.ns))
  // Default view: application namespaces only. On a platform cluster the
  // control plane alone is ~160 services, which buried a team's traffic.
  const [scope, setScope] = useState<'apps' | 'all'>(() => (boot.scope === 'all' ? 'all' : 'apps'))
  /** Apps scope applies only while no namespace is picked explicitly. */
  const appsOnly = scope === 'apps' && ns.length === 0
  const [search, setSearch] = useState(boot.q ?? '')
  const [errorsOnly, setErrorsOnly] = useState(boot.errors === '1')
  const [showDrops, setShowDrops] = useState(boot.drops !== '0')
  const [showIdle, setShowIdle] = useState(boot.idle === '1')
  const [showHosts, setShowHosts] = useState(boot.nodes === '1')
  const [protos, setProtos] = useState<Proto[]>(() => listParam(boot.proto) as Proto[])
  const [focus, setFocus] = useState<string | null>(boot.focus || null)
  const [edgeSel, setEdgeSel] = useState<string | null>(boot.edge || null)
  const [srcPref, setSrcPref] = useState(boot.src ?? '')
  const [paused, setPaused] = useState(false)
  const [feedOpen, setFeedOpen] = useState(readFeedPref)
  const [asideTab, setAsideTab] = useState<'flows' | 'services'>('flows')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [pinned, setPinned] = useState<Map<string, Pos>>(() => new Map())
  const [nonce, setNonce] = useState(0)
  const [help, setHelp] = useState(false)
  const wide = useMediaQuery('(min-width: 1024px)')
  const canvasApi = useRef<CanvasHandle | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const w = WINDOWS.find((x) => x.id === win)!

  useEffect(() => {
    replaceParams({
      win: win === '1m' ? null : win,
      ns: ns.join(','),
      scope: scope === 'all' ? 'all' : null,
      q: search,
      errors: errorsOnly ? '1' : null,
      drops: showDrops ? null : '0',
      idle: showIdle ? '1' : null,
      nodes: showHosts ? '1' : null,
      proto: protos.join(','),
      focus,
      edge: edgeSel,
      src: srcPref,
      range: null,
    })
  }, [win, ns, scope, search, errorsOnly, showDrops, showIdle, showHosts, protos, focus, edgeSel, srcPref])

  useEffect(() => {
    try {
      localStorage.setItem('discover.servicemap.feed', feedOpen ? '1' : '0')
    } catch {
      // storage unavailable — the preference just isn't remembered
    }
  }, [feedOpen])

  /* ─── 1. live ─── */
  const promOnly = !!srcPref && srcPref !== 'live'
  const live = useLiveFlows<FlowsFrame, FeedRow>(
    { windowS: w.s, namespaces: ns, scope: appsOnly ? 'apps' : 'all', protos, hosts: showHosts, focus: focus ?? undefined, edge: edgeSel ?? undefined, retry: nonce },
    { enabled: !paused && !promOnly, feedMax: 400 },
  )
  const liveDown = promOnly || live.state === 'unavailable' || live.state === 'error'

  /* ─── 2. 1-minute metrics fallback ─── */
  const names = useMetricNames()
  const promSources = useMemo(() => GRAPH_SOURCES.filter((s) => names.data?.includes(s.probe)), [names.data])
  const promSrc = liveDown ? promSources.find((s) => s.id === srcPref) ?? promSources[0] ?? null : null
  const promWin = boot.win === '15m' || boot.win === '1h' ? boot.win : w.prom
  const pq = promSrc ? promSrc.queries(promWin) : { rps: null, err: null, p95: null }
  const prom = useInstantSet({ rps: pq.rps, err: pq.err, p95: pq.p95 }, { refreshMs: 60_000, enabled: !!promSrc && !paused })

  const mode: SourceMode = paused
    ? 'paused'
    : !liveDown
    ? live.state === 'live' ? 'live' : live.state === 'reconnecting' ? 'reconnecting' : 'connecting'
    : promSrc
    ? 'metrics'
    : names.isLoading
    ? 'connecting'
    : 'none'

  /* ─── 3. topology (idle workloads) ─── */
  const topoOpts = { enabled: showIdle }
  const deps = useLiveK8sList<{ metadata?: { name?: string; namespace?: string } }>({ group: 'apps', version: 'v1', resource: 'deployments' }, topoOpts)
  const sts = useLiveK8sList<{ metadata?: { name?: string; namespace?: string } }>({ group: 'apps', version: 'v1', resource: 'statefulsets' }, topoOpts)
  const topo: TopoWorkload[] = useMemo(
    () =>
      showIdle
        ? [...deps.data, ...sts.data].flatMap((o) => (o.metadata?.name && o.metadata.namespace ? [{ ns: o.metadata.namespace, name: o.metadata.name }] : []))
        : [],
    [showIdle, deps.data, sts.data],
  )

  /* ─── graph pipeline ─── */
  const retainedRef = useRef(newRetained())
  useEffect(() => {
    retainedRef.current = newRetained()
  }, [win, ns.join(','), protos.join(','), mode === 'metrics'])

  const base: MapGraph = useMemo(() => {
    if (!liveDown) {
      if (!live.frame) return EMPTY_GRAPH
      return retain(retainedRef.current, fromFrame(live.frame), Date.now(), RETAIN_MS)
    }
    if (!promSrc) return EMPTY_GRAPH
    const g = fromPromGraph(buildGraph(promSrc, prom.rps.data ?? [], prom.err.data ?? [], prom.p95.data ?? []))
    if (!ns.length && !appsOnly) return g
    const inScope = (n: string | undefined) => !!n && (ns.length ? ns.includes(n) : !isPlatformNamespace(n))
    const keep = new Set(g.nodes.filter((n) => inScope(n.ns)).map((n) => n.id))
    const edges = g.edges.filter((e) => keep.has(e.s) || keep.has(e.d))
    const used = new Set(edges.flatMap((e) => [e.s, e.d]))
    return { nodes: g.nodes.filter((n) => used.has(n.id) || keep.has(n.id)), edges }
  }, [liveDown, live.frame, promSrc, prom.rps.data, prom.err.data, prom.p95.data, ns, appsOnly])

  const graph = useMemo(() => {
    // Idle workloads only for namespaces in view — in the apps scope, never
    // the platform's (the far end of an app → platform call is in the graph,
    // but its namespace's 100+ idle services are not).
    const inView = new Set(ns.length ? ns : base.nodes.flatMap((n) => (n.ns && !(appsOnly && isPlatformNamespace(n.ns)) ? [n.ns] : [])))
    const withIdle = showIdle ? withTopology(base, topo, inView) : base
    return applyFilters(collapseNamespaces(withIdle, collapsed), { search, errorsOnly, showDrops, showHosts })
  }, [base, showIdle, topo, ns, appsOnly, collapsed, search, errorsOnly, showDrops, showHosts])

  // Layout: incremental while live (nothing that is placed ever moves); a full,
  // order-preserving re-layout only on an explicit change, on "Tidy layout",
  // or once too many nodes sit in provisional slots.
  const [tidy, setTidy] = useState(0)
  const layoutRef = useRef<{ layout: MapLayout; scope: string } | null>(null)
  const nodesKey = nodeSetKey(graph)
  const pinKey = [...pinned.entries()].map(([k, p]) => `${k}:${p.x},${p.y}`).join('|')
  const scopeKey = [win, ns.join(','), protos.join(','), [...collapsed].join(','), showIdle, showHosts, errorsOnly, search, mode === 'metrics', tidy].join('#')
  const { layout, provisional } = useMemo(() => {
    const prev = layoutRef.current
    let next: { layout: MapLayout; provisional: number }
    if (!prev || prev.scope !== scopeKey) {
      next = { layout: layoutMap(graph, { prev: prev?.layout.pos, pinned }), provisional: 0 }
    } else {
      const inc = incrementalLayout(graph, prev.layout, { pinned })
      next = inc && inc.provisional <= Math.max(8, graph.nodes.length * 0.25)
        ? inc
        : { layout: layoutMap(graph, { prev: prev.layout.pos, pinned }), provisional: 0 }
    }
    layoutRef.current = { layout: next.layout, scope: scopeKey }
    return next
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodesKey, pinKey, scopeKey])
  // Offer "Tidy layout" once anything has been placed provisionally since the last full layout.
  const [untidy, setUntidy] = useState(false)
  useEffect(() => setUntidy(false), [scopeKey])
  useEffect(() => {
    if (provisional > 0) setUntidy(true)
  }, [layout, provisional])

  const near = useMemo(() => neighbourhood(graph, focus), [graph, focus])
  const nearEdge = useMemo(() => {
    const ends = edgeSel ? edgeEnds(edgeSel) : null
    return ends ? new Set([ends.s, ends.d]) : null
  }, [edgeSel])
  const selectedNode = graph.nodes.find((n) => n.id === focus) ?? null
  const selectedEdge = graph.edges.find((e) => e.id === edgeSel) ?? null
  const namespaces = useMemo(
    () => [...new Set([...(live.frame?.namespaces ?? []), ...base.nodes.flatMap((n) => (n.ns ? [n.ns] : []))])].sort(),
    [live.frame?.namespaces, base.nodes],
  )
  const protosSeen: Proto[] = live.frame?.protos ?? []

  const pickNode = useCallback((id: string) => {
    setEdgeSel(null)
    setFocus((f) => (f === id ? null : id))
  }, [])
  const pickEdge = useCallback((id: string) => {
    setFocus(null)
    setEdgeSel((e) => (e === id ? null : id))
  }, [])
  const clear = useCallback(() => {
    setFocus(null)
    setEdgeSel(null)
  }, [])
  const pin = useCallback((id: string, p: Pos) => {
    setPinned((m) => new Map(m).set(id, p))
  }, [])
  const toggleGroup = useCallback((nsName: string) => {
    setCollapsed((s) => {
      const n = new Set(s)
      if (n.has(nsName)) n.delete(nsName)
      else n.add(nsName)
      return n
    })
  }, [])
  const resetFilters = () => {
    setNs([])
    setProtos([])
    setSearch('')
    setErrorsOnly(false)
  }

  /* ─── keyboard ─── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        if (e.key === 'Escape') t.blur()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      switch (e.key) {
        case ' ':
          e.preventDefault()
          setPaused((p) => !p)
          break
        case 'f':
          canvasApi.current?.fit()
          break
        case '/':
          e.preventDefault()
          searchRef.current?.focus()
          break
        case 'e':
          setErrorsOnly((v) => !v)
          break
        case 'd':
          setShowDrops((v) => !v)
          break
        case 'i':
          setShowIdle((v) => !v)
          break
        case 'l':
          setFeedOpen((v) => !v)
          break
        case 'n':
          setShowHosts((v) => !v)
          break
        case '+':
        case '=':
          canvasApi.current?.zoomBy(1.2)
          break
        case '-':
          canvasApi.current?.zoomBy(1 / 1.2)
          break
        case '1':
        case '2':
        case '3':
          setWin(WINDOWS[Number(e.key) - 1].id)
          break
        case '?':
          setHelp((h) => !h)
          break
        case 'Escape':
          if (help) setHelp(false)
          else clear()
          break
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [clear, help])

  /* ─── sizing: the canvas ends at the bottom of the page ─── */
  const paneRef = useRef<HTMLDivElement | null>(null)
  const [paneH, setPaneH] = useState(560)
  useEffect(() => {
    const measure = () => {
      const el = paneRef.current
      if (!el) return
      if (!wide) return setPaneH(Math.max(380, Math.round(globalThis.innerHeight * 0.62)))
      const main = el.closest('main')
      let bottom = globalThis.innerHeight
      if (main) {
        bottom = Math.min(bottom, main.getBoundingClientRect().bottom)
        for (let n = el.parentElement; n && n !== main; n = n.parentElement) {
          const cs = getComputedStyle(n)
          bottom -= (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.marginBottom) || 0)
        }
      }
      setPaneH(Math.max(460, Math.floor(bottom - el.getBoundingClientRect().top - 8)))
    }
    measure()
    globalThis.addEventListener('resize', measure)
    return () => globalThis.removeEventListener('resize', measure)
  }, [wide, mode])

  const sourceLabel = mode === 'live'
    ? 'Live · Hubble'
    : mode === 'paused'
    ? 'Paused'
    : mode === 'reconnecting'
    ? 'Reconnecting…'
    : mode === 'connecting'
    ? 'Connecting…'
    : mode === 'metrics'
    ? `1-minute metrics · ${promSrc?.label}`
    : 'No live source'

  const filtered = ns.length > 0 || protos.length > 0 || !!search || errorsOnly
  const loading = mode === 'connecting' && !live.frame
  const empty = !loading && graph.nodes.length === 0
  const metricsMode = mode === 'metrics' || (paused && liveDown)
  const hasSelection = !!(selectedNode || selectedEdge)
  const asideOpen = wide && (hasSelection || feedOpen)

  const details = selectedNode ? (
    <NodePanel node={selectedNode} graph={graph} frame={live.frame} feed={live.feed} metricsMode={metricsMode} embedded={!wide} onEdge={pickEdge} onClose={clear} />
  ) : selectedEdge ? (
    <EdgePanel edge={selectedEdge} graph={graph} frame={live.frame} feed={live.feed} metricsMode={metricsMode} embedded={!wide} onNode={pickNode} onClose={clear} />
  ) : null

  return (
    <div className="space-y-3">
      <VizStyle />
      <PageHeader
        title="Service Map"
        compact
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <SourceBadge mode={mode} label={sourceLabel} />
            {mode !== 'none' ? (
              <Button
                variant={paused ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setPaused((p) => !p)}
                aria-keyshortcuts="Space"
                leading={paused ? <PlayIcon /> : <PauseIcon />}
              >
                {paused ? 'Resume' : 'Pause'}
              </Button>
            ) : null}
            {!metricsMode && mode !== 'none' ? (
              <Button size="sm" aria-pressed={feedOpen} onClick={() => setFeedOpen((v) => !v)} aria-keyshortcuts="L" leading={<FeedIcon />}>
                Flow feed
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" aria-label="Keyboard shortcuts" onClick={() => setHelp((h) => !h)}>?</Button>
          </div>
        }
      />

      {mode === 'none' ? (
        <NoLiveSource reason={live.reason} message={live.message} onRetry={() => setNonce((n) => n + 1)} />
      ) : (
        <>
          <HeaderStats totals={live.frame && !liveDown ? live.frame.totals : promTotals(base)} live={!liveDown} windowLabel={liveDown ? promWin : w.label} />

          {/* toolbar */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-2 shadow-sm">
            <Segmented value={win} onChange={setWin} ariaLabel="Time window" size="xs" options={WINDOWS.map((x) => ({ id: x.id, label: x.label }))} />
            <NamespacePicker all={namespaces} value={ns} onChange={setNs} scope={scope} onScope={setScope} />
            <div className="relative min-w-0 flex-1 basis-40 sm:max-w-60">
              <input
                ref={searchRef}
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Find a service…"
                aria-label="Search services"
                aria-keyshortcuts="/"
                className="h-7 w-full rounded-md border border-edge-default bg-surface-sunken pl-2 pr-7 text-[11.5px] text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
              />
              <kbd className="pointer-events-none absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded border border-edge-default px-1 text-[10px] text-content-subtle sm:block">/</kbd>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {protosSeen.map((p) => (
                <Chip key={p} on={protos.includes(p)} onClick={() => setProtos((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]))}>
                  {PROTO_LABEL[p]}
                </Chip>
              ))}
              {protosSeen.length ? <span className="mx-0.5 hidden h-4 w-px bg-edge-default sm:block" /> : null}
              <Chip on={errorsOnly} onClick={() => setErrorsOnly((v) => !v)} title="Errors ≥ 1% or drops (E)">Errors only</Chip>
              {!metricsMode ? <Chip on={showDrops} onClick={() => setShowDrops((v) => !v)} title="Show dropped traffic (D)">Drops</Chip> : null}
              <Chip on={showIdle} onClick={() => setShowIdle((v) => !v)} title="Workloads with no traffic, from Kubernetes (I)">Idle</Chip>
              <Chip on={showHosts} onClick={() => setShowHosts((v) => !v)} title="Traffic to and from the nodes themselves — kubelet probes, host networking (N)">Node traffic</Chip>
              {promSources.length > 0 ? (
                <select
                  aria-label="Source"
                  value={srcPref}
                  onChange={(e) => setSrcPref(e.target.value)}
                  className="h-7 rounded-md border border-edge-default bg-surface-raised px-1.5 text-[11.5px] text-content-muted"
                >
                  <option value="">Auto (live first)</option>
                  <option value="live">Live · Hubble</option>
                  {promSources.map((s) => <option key={s.id} value={s.id}>{s.label} (1-min)</option>)}
                </select>
              ) : null}
            </div>
          </div>

          <div className={cn('grid min-w-0 gap-3', asideOpen && 'lg:grid-cols-[minmax(0,1fr)_380px]')}>
            <div ref={paneRef} className="relative min-w-0 overflow-hidden rounded-xl border border-edge-default shadow-sm" style={{ height: paneH }}>
              {loading ? (
                <div className="flex h-full items-center justify-center bg-surface-raised"><Loading height={200} /></div>
              ) : empty ? (
                <div className="flex h-full items-center justify-center bg-surface-raised">
                  <NoTraffic
                    window={liveDown ? promWin : w.label}
                    filtered={filtered}
                    appsOnly={appsOnly}
                    onShowAll={() => setScope('all')}
                    onWiden={win !== '5m' ? () => setWin('5m') : undefined}
                    onClear={resetFilters}
                  />
                </div>
              ) : (
                <MapCanvas
                  graph={graph}
                  layout={layout}
                  focus={focus}
                  edge={edgeSel}
                  near={near ?? nearEdge}
                  animate={!paused}
                  onNode={pickNode}
                  onEdge={pickEdge}
                  onClear={clear}
                  onPin={pin}
                  onToggleGroup={toggleGroup}
                  collapsed={collapsed}
                  handle={(h) => (canvasApi.current = h)}
                  className="h-full w-full"
                />
              )}
              {!loading && !empty ? (
                <CanvasOverlay
                  mode={mode}
                  promLabel={promSrc?.label}
                  frame={liveDown ? null : live.frame}
                  collapsed={[...collapsed]}
                  onExpand={(n) => toggleGroup(n)}
                  pinned={pinned.size}
                  untidy={untidy}
                  onTidy={() => setTidy((t) => t + 1)}
                  onResetLayout={() => {
                    setPinned(new Map())
                    setTidy((t) => t + 1)
                    toast.info('Layout reset', { description: 'Dragged nodes are back in the automatic layout.' })
                  }}
                  onZoom={(f) => canvasApi.current?.zoomBy(f)}
                  onFit={() => canvasApi.current?.fit()}
                />
              ) : null}
            </div>

            {asideOpen ? (
              <aside className="min-w-0 overflow-hidden rounded-xl border border-edge-default bg-surface-canvas shadow-sm" style={{ height: paneH }}>
                {details ? (
                  <div className="h-full overflow-y-auto">{details}</div>
                ) : (
                  <div className="flex h-full flex-col">
                    <div className="flex items-center justify-between gap-2 border-b border-edge-default bg-surface-raised px-3 py-2">
                      <Segmented
                        value={asideTab}
                        onChange={setAsideTab}
                        size="xs"
                        ariaLabel="Side panel"
                        options={[{ id: 'flows', label: metricsMode ? 'Flows' : 'Live flows' }, { id: 'services', label: 'Services', count: graph.nodes.filter((n) => !n.idle).length }]}
                      />
                      <span className="truncate text-[11px] text-content-subtle">{asideTab === 'flows' ? (paused ? 'paused' : 'hover to hold') : 'click to focus'}</span>
                    </div>
                    <div className="min-h-0 flex-1">
                      {asideTab === 'flows' ? (
                        metricsMode ? (
                          <div className="p-4 text-[12px] text-content-muted">Individual flows need the live Hubble source; 1-minute metrics only carry rates.</div>
                        ) : (
                          <FlowFeed rows={feedRows(live.feed, graph)} height={paneH - 48} paused={paused} />
                        )
                      ) : (
                        <ServiceList graph={graph} onNode={pickNode} height={paneH - 96} />
                      )}
                    </div>
                  </div>
                )}
              </aside>
            ) : null}
          </div>

          {!wide && feedOpen && !metricsMode ? (
            <section className="overflow-hidden rounded-xl border border-edge-default bg-surface-canvas shadow-sm">
              <div className="border-b border-edge-default bg-surface-raised px-3 py-2 text-[12px] font-semibold text-content">Live flows</div>
              <FlowFeed rows={feedRows(live.feed, graph)} height={360} paused={paused} />
            </section>
          ) : null}

          {!wide ? (
            <Drawer
              open={hasSelection}
              onClose={clear}
              title={selectedNode?.name ?? (selectedEdge ? 'Connection' : '')}
              width="max-w-lg"
              widthId="discover.servicemap.drawer"
            >
              {details}
            </Drawer>
          ) : null}
        </>
      )}

      {help ? <ShortcutHelp onClose={() => setHelp(false)} /> : null}
    </div>
  )
}

/** Feed rows that belong to what is on the map (search/errors filters apply). */
function feedRows(rows: FeedRow[], g: MapGraph): FeedRow[] {
  if (!g.nodes.length) return rows
  const ids = new Set(g.nodes.map((n) => n.id))
  return rows.filter((r) => ids.has(r.s) && ids.has(r.d))
}

function promTotals(g: MapGraph): FlowsFrame['totals'] | null {
  if (!g.edges.length) return null
  let rps = 0
  let e5 = 0
  for (const e of g.edges) {
    rps += e.rps
    e5 += ((e.err ?? 0) / 100) * e.rps
  }
  const services = new Set(g.edges.flatMap((e) => [e.s, e.d])).size
  return { rps, cps: 0, fps: 0, err: rps > 0 ? (100 * e5) / rps : null, drops: 0, services, edges: g.edges.length }
}

/* ─────────────────────────── overlay ─────────────────────────── */

function CanvasOverlay({ mode, promLabel, frame, collapsed, onExpand, pinned, untidy, onTidy, onResetLayout, onZoom, onFit }: {
  mode: SourceMode
  promLabel?: string
  frame: FlowsFrame | null
  collapsed: string[]
  onExpand(ns: string): void
  pinned: number
  untidy: boolean
  onTidy(): void
  onResetLayout(): void
  onZoom(f: number): void
  onFit(): void
}) {
  const btn = 'flex h-8 w-8 items-center justify-center rounded-md text-content-muted hover:bg-surface-sunken hover:text-content'
  return (
    <>
      <div className="pointer-events-none absolute left-3 top-3 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-1.5">
        {mode === 'metrics' ? (
          <span className="pointer-events-auto rounded-full border border-brand-400/40 bg-surface-raised/95 px-2.5 py-1 text-[11px] font-medium text-brand-700 shadow-sm dark:text-brand-200">
            1-minute metrics · {promLabel} — not live
          </span>
        ) : null}
        {frame && frame.hidden.edges > 0 ? (
          <span className="rounded-full border border-edge-default bg-surface-raised/95 px-2.5 py-1 text-[11px] text-content-muted shadow-sm">
            Busiest {frame.edges.length} of {frame.totals.edges} connections
          </span>
        ) : null}
        {frame && frame.lost > 0 ? (
          <span className="rounded-full border border-amber-500/40 bg-surface-raised/95 px-2.5 py-1 text-[11px] text-amber-700 shadow-sm dark:text-amber-300">
            Hubble dropped {frame.lost} events (buffer full)
          </span>
        ) : null}
        {collapsed.map((n) => (
          <button key={n} type="button" onClick={() => onExpand(n)} className="pointer-events-auto rounded-full border border-edge-default bg-surface-raised/95 px-2.5 py-1 text-[11px] text-content-muted shadow-sm hover:text-content">
            {n} collapsed · expand
          </button>
        ))}
      </div>
      <div className="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-lg border border-edge-default bg-surface-raised/95 p-0.5 shadow-md backdrop-blur">
        <button type="button" className={btn} onClick={() => onZoom(1.2)} aria-label="Zoom in" title="Zoom in (+)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 5v14M5 12h14" /></svg></button>
        <button type="button" className={btn} onClick={() => onZoom(1 / 1.2)} aria-label="Zoom out" title="Zoom out (−)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12h14" /></svg></button>
        <button type="button" className={btn} onClick={onFit} aria-label="Zoom to fit" title="Zoom to fit (F)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg></button>
        {untidy ? (
          <button type="button" className="h-8 rounded-md px-2 text-[11px] font-medium text-content-muted hover:bg-surface-sunken hover:text-content" onClick={onTidy} title="New services were placed in free slots; re-arrange everything">Tidy layout</button>
        ) : null}
        {pinned ? (
          <button type="button" className="h-8 rounded-md px-2 text-[11px] font-medium text-content-muted hover:bg-surface-sunken hover:text-content" onClick={onResetLayout}>Reset layout</button>
        ) : null}
      </div>
      <Legend />
    </>
  )
}

function Legend() {
  const item = (color: string, label: string, dashed = false) => (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <svg width="18" height="6" aria-hidden><line x1="1" y1="3" x2="17" y2="3" stroke={color} strokeWidth="2.5" strokeDasharray={dashed ? '3 3' : undefined} strokeLinecap="round" /></svg>
      {label}
    </span>
  )
  return (
    <div className="pointer-events-none absolute right-3 top-3 hidden items-center gap-3 whitespace-nowrap rounded-full border border-edge-default bg-surface-raised/95 px-3 py-1 text-[10.5px] text-content-muted shadow-sm xl:flex">
      {item('var(--color-emerald-500)', '< 1% errors')}
      {item('var(--color-amber-500)', '1–5%')}
      {item('var(--color-rose-500)', '≥ 5%')}
      {item('var(--color-slate-400)', 'L4 only')}
      {item('var(--color-rose-500)', 'drops', true)}
    </div>
  )
}

/* ─────────────────────────── help & icons ─────────────────────────── */

const SHORTCUTS: Array<[string, string]> = [
  ['Space', 'Pause / resume'],
  ['1 · 2 · 3', 'Window 15s · 1m · 5m'],
  ['/', 'Search'],
  ['F', 'Zoom to fit'],
  ['+ / −', 'Zoom'],
  ['E', 'Errors only'],
  ['D', 'Show drops'],
  ['I', 'Idle workloads'],
  ['N', 'Node traffic'],
  ['L', 'Flow feed'],
  ['Esc', 'Clear selection'],
]

function ShortcutHelp({ onClose }: { onClose(): void }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative w-full max-w-sm rounded-xl border border-edge-default bg-surface-raised p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-content">Keyboard shortcuts</h2>
          <Button size="xs" variant="ghost" onClick={onClose}>Close</Button>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="contents">
              <dt><kbd className="rounded border border-edge-default bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content">{k}</kbd></dt>
              <dd className="text-content-muted">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-[11px] text-content-subtle">Drag the background to pan, drag a service to pin it, pinch or Ctrl/⌘ + scroll to zoom. Click a namespace frame to collapse it.</p>
      </div>
    </div>
  )
}

const PauseIcon = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
const PlayIcon = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M7 5v14l12-7z" /></svg>
const FeedIcon = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M4 6h16M4 12h10M4 18h13" /></svg>
