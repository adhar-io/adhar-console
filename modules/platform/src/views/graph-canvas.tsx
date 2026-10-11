import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  getStraightPath,
  Handle,
  type InternalNode,
  MarkerType,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useInternalNode,
  useReactFlow,
} from '@xyflow/react'
import flowCss from '@xyflow/react/dist/style.css?inline'
import { cn } from '@adhar/utils'
import { EDGE_PHRASE, type EdgeKind, type GraphEdge, type GraphNode, KIND_COLOR, KIND_LABEL, type NodeKind } from '../data/graph.ts'

/**
 * The knowledge-graph canvas, on React Flow 12.
 *
 * Two deterministic layouts — the same neighbourhood always draws the same way,
 * so "the red pod on the left" means something during an incident:
 *   - Radial: the selected thing in the middle, direct relations around it,
 *     second and third hops in arcs behind the relation they hang off.
 *   - Layered: one column per hop, left to right, sorted by kind then name.
 *
 * Interaction: hover lights a node's relationships and dims the rest; click
 * inspects; double-click recentres the graph on that node. Kinds and relation
 * types can be hidden, nodes can be dragged, and the minimap and controls give
 * zoom, fit and full screen.
 */

/* React Flow ships its CSS separately; a federated remote does not carry its
   stylesheet to the host, so inject it once (same pattern as the terminal). */
const STYLE_ID = 'adhar-xyflow-css'
function ensureFlowCss() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = `${flowCss}
.adhar-graph .react-flow__attribution{display:none}
.adhar-graph .react-flow__controls{box-shadow:none;border:1px solid var(--color-edge-default);border-radius:10px;overflow:hidden}
.adhar-graph .react-flow__controls-button{background:var(--color-surface-raised);border-bottom:1px solid var(--color-edge-subtle);color:var(--color-content-muted)}
.adhar-graph .react-flow__controls-button:hover{background:var(--color-surface-sunken)}
.adhar-graph .react-flow__controls-button svg{fill:currentColor}
.adhar-graph .react-flow__minimap{border:1px solid var(--color-edge-default);border-radius:10px;overflow:hidden;background:var(--color-surface-raised)}
.adhar-graph .react-flow__edge-textbg{fill:var(--color-surface-raised)}
.adhar-graph .react-flow__edge-text{fill:var(--color-content-muted);font-size:10px}
`
  document.head.appendChild(el)
}

/** Raw colours for the minimap and edges (Tailwind classes cannot reach SVG fills there). */
export const KIND_HEX: Record<NodeKind, string> = {
  cluster: '#64748b',
  node: '#64748b',
  namespace: '#3b82f6',
  org: '#c026d3',
  workload: '#7c3aed',
  pod: '#0ea5e9',
  container: '#38bdf8',
  image: '#f59e0b',
  service: '#14b8a6',
  ingress: '#06b6d4',
  route: '#06b6d4',
  config: '#78716c',
  secret: '#f43f5e',
  volume: '#65a30d',
  application: '#10b981',
  pipelinerun: '#ec4899',
  workflow: '#ec4899',
  repository: '#f97316',
} as Record<NodeKind, string>

const STATUS_HEX: Record<string, string> = {
  healthy: '#10b981',
  degraded: '#f59e0b',
  progressing: '#0ea5e9',
  failed: '#f43f5e',
}

export type LayoutKind = 'radial' | 'layered'

/** Hop distance from the root over undirected edges. */
export function hopsFrom(rootId: string, edges: GraphEdge[]): Map<string, number> {
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to])
    adj.set(e.to, [...(adj.get(e.to) ?? []), e.from])
  }
  const hop = new Map<string, number>([[rootId, 0]])
  const queue = [rootId]
  while (queue.length) {
    const id = queue.shift()!
    for (const n of adj.get(id) ?? []) {
      if (hop.has(n)) continue
      hop.set(n, hop.get(id)! + 1)
      queue.push(n)
    }
  }
  return hop
}

const byKindName = (a: GraphNode, b: GraphNode) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
const NODE_W = 196
const NODE_H = 58

function layoutLayered(root: GraphNode, nodes: GraphNode[], hop: Map<string, number>): Map<string, { x: number; y: number }> {
  const cols = new Map<number, GraphNode[]>()
  for (const n of nodes) {
    const h = n.id === root.id ? 0 : hop.get(n.id) ?? 4
    cols.set(h, [...(cols.get(h) ?? []), n])
  }
  const pos = new Map<string, { x: number; y: number }>()
  for (const [h, list] of cols) {
    list.sort(byKindName)
    const total = list.length * (NODE_H + 18)
    list.forEach((n, i) => pos.set(n.id, { x: h * (NODE_W + 110), y: i * (NODE_H + 18) - total / 2 }))
  }
  return pos
}

function layoutRadial(root: GraphNode, nodes: GraphNode[], edges: GraphEdge[], hop: Map<string, number>): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>([[root.id, { x: 0, y: 0 }]])
  const ring1 = nodes.filter((n) => hop.get(n.id) === 1).sort(byKindName)
  const rx1 = Math.max(320, ring1.length * 34)
  const ry1 = Math.max(200, ring1.length * 20)
  const angle = new Map<string, number>()
  ring1.forEach((n, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(ring1.length, 1)
    angle.set(n.id, a)
    pos.set(n.id, { x: rx1 * Math.cos(a), y: ry1 * Math.sin(a) })
  })
  // Later hops: an arc behind the nearest placed node they hang off.
  for (let h = 2; h <= 6; h++) {
    const ring = nodes.filter((n) => hop.get(n.id) === h).sort(byKindName)
    if (!ring.length) continue
    const groups = new Map<string, GraphNode[]>()
    for (const n of ring) {
      const parent = edges
        .map((e) => (e.from === n.id ? e.to : e.to === n.id ? e.from : undefined))
        .find((p) => p && hop.get(p) === h - 1 && angle.has(p))
      const key = parent ?? '__orphan'
      groups.set(key, [...(groups.get(key) ?? []), n])
    }
    const rx = rx1 + (h - 1) * 300
    const ry = ry1 + (h - 1) * 190
    const slice = (2 * Math.PI) / Math.max(angle.size, 1)
    for (const [parent, kids] of groups) {
      const base = angle.get(parent) ?? 0
      const span = parent === '__orphan' ? 2 * Math.PI : Math.min(slice * 0.85, 0.32 * kids.length)
      kids.forEach((n, i) => {
        const t = kids.length === 1 ? 0 : i / (kids.length - 1) - 0.5
        const a = parent === '__orphan' ? -Math.PI / 2 + (2 * Math.PI * i) / kids.length : base + t * span
        angle.set(n.id, a)
        pos.set(n.id, { x: rx * Math.cos(a), y: ry * Math.sin(a) })
      })
    }
  }
  return pos
}

/* ─────────── node ─────────── */

type EntityData = { node: GraphNode; hop: number; dim: boolean; focused: boolean; isRoot: boolean }

const EntityNode = memo(function EntityNode({ data }: NodeProps<Node<EntityData>>) {
  const { node, hop, dim, focused, isRoot } = data
  const status = node.status && node.status !== 'unknown' ? node.status : undefined
  return (
    <div
      className={cn(
        'relative flex w-[196px] items-stretch overflow-hidden rounded-xl border bg-surface-raised text-left shadow-sm transition-[opacity,box-shadow] duration-150',
        isRoot ? 'border-brand-500 shadow-md ring-4 ring-brand-500/15' : focused ? 'border-brand-400 ring-2 ring-brand-400/30' : 'border-edge-default',
        dim && 'opacity-25',
      )}
      title={`${KIND_LABEL[node.kind]} · ${node.namespace ? `${node.namespace}/` : ''}${node.name}`}
    >
      <Handle type="target" position={Position.Left} className="opacity-0!" isConnectable={false} />
      <span className="w-1.5 shrink-0" style={{ background: KIND_HEX[node.kind] ?? '#94a3b8' }} />
      <div className="min-w-0 flex-1 px-2.5 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className={cn('truncate text-[10px] font-semibold uppercase tracking-wide', KIND_COLOR[node.kind]?.text)}>{KIND_LABEL[node.kind]}</span>
          {status ? <span className="ml-auto size-2 shrink-0 rounded-full" style={{ background: STATUS_HEX[status] }} title={status} /> : null}
          {!isRoot ? <span className={cn('shrink-0 rounded bg-surface-sunken px-1 font-mono text-[9px] text-content-subtle', !status && 'ml-auto')}>{hop}</span> : null}
        </div>
        <div className={cn('truncate text-[12px] text-content', isRoot && 'font-semibold')}>{node.name}</div>
        {node.namespace ? <div className="truncate font-mono text-[10px] text-content-subtle">{node.namespace}</div> : null}
      </div>
      <Handle type="source" position={Position.Right} className="opacity-0!" isConnectable={false} />
    </div>
  )
})

const nodeTypes = { entity: EntityNode }

/* ─────────── floating edge ─────────── */

/**
 * Where the line between two node centres crosses `a`'s border. Fixed
 * left/right handles made radial edges hook around their nodes; a floating
 * edge leaves each card at the side facing the other.
 */
function borderPoint(a: InternalNode, b: InternalNode): { x: number; y: number } {
  const w = (a.measured.width ?? NODE_W) / 2
  const h = (a.measured.height ?? NODE_H) / 2
  const ax = a.internals.positionAbsolute.x + w
  const ay = a.internals.positionAbsolute.y + h
  const bx = b.internals.positionAbsolute.x + (b.measured.width ?? NODE_W) / 2
  const by = b.internals.positionAbsolute.y + (b.measured.height ?? NODE_H) / 2
  const xx1 = (bx - ax) / (2 * w) - (by - ay) / (2 * h)
  const yy1 = (bx - ax) / (2 * w) + (by - ay) / (2 * h)
  const k = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1)
  const xx3 = k * xx1
  const yy3 = k * yy1
  return { x: w * (xx3 + yy3) + ax, y: h * (-xx3 + yy3) + ay }
}

type FloatData = { layered: boolean; text?: string; lit: boolean }

function FloatingEdge({ id, source, target, markerEnd, style, data }: EdgeProps<Edge<FloatData>>) {
  const s = useInternalNode(source)
  const t = useInternalNode(target)
  if (!s || !t) return null
  const a = borderPoint(s, t)
  const b = borderPoint(t, s)
  const [path, lx, ly] = data?.layered
    ? getBezierPath({ sourceX: a.x, sourceY: a.y, sourcePosition: Position.Right, targetX: b.x, targetY: b.y, targetPosition: Position.Left })
    : getStraightPath({ sourceX: a.x, sourceY: a.y, targetX: b.x, targetY: b.y })
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {data?.text ? (
        <EdgeLabelRenderer>
          <div
            className={cn(
              'nodrag nopan pointer-events-none absolute rounded px-1 py-px text-[9.5px] leading-tight ring-1',
              data.lit
                ? 'z-10 bg-brand-50 text-brand-700 ring-brand-200 dark:bg-brand-500/15 dark:text-brand-200 dark:ring-brand-500/30'
                : 'bg-surface-raised text-content-subtle ring-edge-subtle',
            )}
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`, opacity: (style?.opacity as number) ?? 1 }}
          >
            {data.text}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

const edgeTypes = { floating: FloatingEdge }

/* ─────────── canvas ─────────── */

export interface GraphCanvasProps {
  root: GraphNode
  nodes: GraphNode[]
  edges: GraphEdge[]
  truncated: boolean
  focusedId: string | null
  onFocus(id: string): void
  onRecentre(id: string): void
}

export function GraphCanvas(props: GraphCanvasProps) {
  ensureFlowCss()
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  )
}

function Canvas({ root, nodes, edges, truncated, focusedId, onFocus, onRecentre }: GraphCanvasProps) {
  const [layoutKind, setLayoutKind] = useState<LayoutKind>('radial')
  const [hover, setHover] = useState<string | null>(null)
  const [hiddenKinds, setHiddenKinds] = useState<Set<NodeKind>>(new Set())
  const [hiddenRels, setHiddenRels] = useState<Set<EdgeKind>>(new Set())
  const [labels, setLabels] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const [dragged, setDragged] = useState<Map<string, { x: number; y: number }>>(new Map())
  // Nodes are controlled, so React Flow's measurements only reach them (and
  // with them the minimap) through onNodesChange.
  const [sizes, setSizes] = useState<Map<string, { width: number; height: number }>>(new Map())
  const flow = useReactFlow()

  const hop = useMemo(() => hopsFrom(root.id, edges), [root.id, edges])
  const visibleNodes = useMemo(
    () => nodes.filter((n) => n.id === root.id || !hiddenKinds.has(n.kind)),
    [nodes, hiddenKinds, root.id],
  )
  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes])
  const visibleEdges = useMemo(
    () => edges.filter((e) => !hiddenRels.has(e.kind) && visibleIds.has(e.from) && visibleIds.has(e.to)),
    [edges, hiddenRels, visibleIds],
  )
  const positions = useMemo(
    () => (layoutKind === 'layered' ? layoutLayered(root, visibleNodes, hop) : layoutRadial(root, visibleNodes, visibleEdges, hop)),
    [layoutKind, root, visibleNodes, visibleEdges, hop],
  )

  // New root or layout: forget manual drags and fit.
  useEffect(() => {
    setDragged(new Map())
    const t = setTimeout(() => flow.fitView({ padding: 0.15, duration: 300 }), 30)
    return () => clearTimeout(t)
  }, [root.id, layoutKind, flow])

  const neighbours = useMemo(() => {
    if (!hover) return null
    const s = new Set([hover])
    for (const e of visibleEdges) {
      if (e.from === hover) s.add(e.to)
      if (e.to === hover) s.add(e.from)
    }
    return s
  }, [hover, visibleEdges])

  const rfNodes: Node<EntityData>[] = useMemo(
    () =>
      visibleNodes.map((n) => ({
        id: n.id,
        type: 'entity',
        position: dragged.get(n.id) ?? positions.get(n.id) ?? { x: 0, y: 0 },
        data: { node: n, hop: hop.get(n.id) ?? 0, dim: neighbours ? !neighbours.has(n.id) : false, focused: n.id === focusedId, isRoot: n.id === root.id },
        origin: [0.5, 0.5] as [number, number],
        measured: sizes.get(n.id),
      })),
    [visibleNodes, positions, dragged, sizes, hop, neighbours, focusedId, root.id],
  )

  const rfEdges: Edge<FloatData>[] = useMemo(
    () =>
      visibleEdges.map((e) => {
        const lit = hover !== null && (e.from === hover || e.to === hover)
        const faded = hover !== null && !lit
        return {
          id: `${e.from}|${e.kind}|${e.to}`,
          source: e.from,
          target: e.to,
          type: 'floating',
          animated: lit,
          data: { layered: layoutKind === 'layered', lit, text: labels || lit ? EDGE_PHRASE[e.kind]?.out ?? e.kind : undefined },
          style: { stroke: lit ? 'var(--color-brand-500)' : 'var(--color-edge-strong)', strokeWidth: lit ? 2 : 1.25, opacity: faded ? 0.12 : 1 },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: lit ? 'var(--color-brand-500)' : 'var(--color-edge-strong)' },
        }
      }),
    [visibleEdges, hover, labels, layoutKind],
  )

  const kindsHere = useMemo(() => {
    const m = new Map<NodeKind, number>()
    for (const n of nodes) if (n.id !== root.id) m.set(n.kind, (m.get(n.kind) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [nodes, root.id])
  const relsHere = useMemo(() => {
    const m = new Map<EdgeKind, number>()
    for (const e of edges) m.set(e.kind, (m.get(e.kind) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [edges])

  const toggle = <T,>(set: Set<T>, v: T) => {
    const next = new Set(set)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    return next
  }

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const moved = changes.filter((c) => c.type === 'position' && c.position)
    const sized = changes.filter((c) => c.type === 'dimensions' && c.dimensions)
    if (moved.length) {
      setDragged((m) => {
        const next = new Map(m)
        for (const c of moved) if (c.type === 'position' && c.position) next.set(c.id, c.position)
        return next
      })
    }
    if (sized.length) {
      setSizes((m) => {
        const next = new Map(m)
        for (const c of sized) if (c.type === 'dimensions' && c.dimensions) next.set(c.id, c.dimensions)
        return next
      })
    }
  }, [])

  return (
    <div className={cn('adhar-graph flex flex-col bg-surface-raised', fullscreen ? 'fixed inset-0 z-50' : 'relative')}>
      {/* filters */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-edge-subtle px-3 py-2">
        <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Show</span>
        {kindsHere.map(([k, n]) => (
          <button
            key={k}
            type="button"
            onClick={() => setHiddenKinds((s) => toggle(s, k))}
            aria-pressed={!hiddenKinds.has(k)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              hiddenKinds.has(k) ? 'border-edge-default text-content-subtle line-through opacity-60' : 'border-edge-strong bg-surface-raised text-content',
            )}
          >
            <span className="size-2 rounded-full" style={{ background: KIND_HEX[k] }} />
            {KIND_LABEL[k]} <span className="font-mono text-[10px] text-content-subtle">{n}</span>
          </button>
        ))}
        {relsHere.length > 1 ? <span className="mx-1 h-4 w-px bg-edge-default" aria-hidden /> : null}
        {relsHere.length > 1
          ? relsHere.map(([k, n]) => (
            <button
              key={k}
              type="button"
              onClick={() => setHiddenRels((s) => toggle(s, k))}
              aria-pressed={!hiddenRels.has(k)}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                hiddenRels.has(k) ? 'border-edge-default text-content-subtle line-through opacity-60' : 'border-edge-default bg-surface-sunken text-content-muted',
              )}
            >
              {EDGE_PHRASE[k]?.out ?? k} <span className="font-mono text-[10px]">{n}</span>
            </button>
          ))
          : null}
      </div>

      <div className={cn('relative', fullscreen ? 'min-h-0 flex-1' : 'h-[560px]')}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={(_, n) => onFocus(n.id)}
          onNodeDoubleClick={(_, n) => onRecentre(n.id)}
          onNodeMouseEnter={(_, n) => setHover(n.id)}
          onNodeMouseLeave={() => setHover(null)}
          onNodesChange={onNodesChange}
          nodesConnectable={false}
          minZoom={0.15}
          maxZoom={2}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="var(--color-edge-strong)" />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            nodeColor={(n) => KIND_HEX[(n.data as EntityData).node.kind] ?? '#94a3b8'}
            nodeStrokeWidth={0}
            nodeBorderRadius={6}
            bgColor="var(--color-surface-raised)"
            maskColor="rgb(100 116 139 / 0.12)"
          />
          <Panel position="top-right">
            <div className="flex items-center gap-1 rounded-lg border border-edge-default bg-surface-raised/95 p-1 shadow-sm backdrop-blur">
              {(['radial', 'layered'] as LayoutKind[]).map((l) => (
                <button key={l} type="button" onClick={() => setLayoutKind(l)} className={cn('h-7 rounded-md px-2.5 text-[11px] font-medium capitalize', layoutKind === l ? 'bg-brand-600 text-white' : 'text-content-muted hover:bg-surface-sunken hover:text-content')}>
                  {l}
                </button>
              ))}
              <span className="mx-0.5 h-4 w-px bg-edge-default" aria-hidden />
              <button type="button" onClick={() => setLabels((v) => !v)} aria-pressed={labels} className={cn('h-7 rounded-md px-2.5 text-[11px] font-medium', labels ? 'text-content' : 'text-content-subtle')} title="Relationship labels">
                Labels
              </button>
              <button type="button" onClick={() => { setDragged(new Map()); flow.fitView({ padding: 0.15, duration: 300 }) }} className="h-7 rounded-md px-2.5 text-[11px] font-medium text-content-muted hover:bg-surface-sunken hover:text-content" title="Reset positions and fit">
                Reset
              </button>
              <button type="button" onClick={() => setFullscreen((v) => !v)} className="h-7 rounded-md px-2.5 text-[11px] font-medium text-content-muted hover:bg-surface-sunken hover:text-content">
                {fullscreen ? 'Exit full screen' : 'Full screen'}
              </button>
            </div>
          </Panel>
        </ReactFlow>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-edge-subtle px-3 py-1.5 text-[11px] text-content-subtle">
        <span>{visibleNodes.length} of {nodes.length} nodes · {visibleEdges.length} relationships</span>
        {truncated ? <span className="text-amber-700 dark:text-amber-400">capped — part of the neighbourhood, not all of it</span> : null}
        <span className="ml-auto">hover to trace · click to inspect · double-click to recentre · drag to arrange</span>
      </div>
    </div>
  )
}

/* ─────────── depth summary ─────────── */

/** Per-hop counts and the unhealthy things in the neighbourhood — what to look at first. */
export function DepthSummary({ root, nodes, edges, onFocus }: { root: GraphNode; nodes: GraphNode[]; edges: GraphEdge[]; onFocus(id: string): void }) {
  const hop = useMemo(() => hopsFrom(root.id, edges), [root.id, edges])
  const byHop = useMemo(() => {
    const m = new Map<number, GraphNode[]>()
    for (const n of nodes) {
      if (n.id === root.id) continue
      const h = hop.get(n.id) ?? -1
      m.set(h, [...(m.get(h) ?? []), n])
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0])
  }, [nodes, hop, root.id])
  const issues = nodes.filter((n) => n.status === 'failed' || n.status === 'degraded').sort((a, b) => (hop.get(a.id) ?? 9) - (hop.get(b.id) ?? 9))
  return (
    <div className="grid gap-3 border-t border-edge-subtle px-3 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div>
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">By depth</div>
        <div className="space-y-1">
          {byHop.map(([h, list]) => {
            const kinds = new Map<NodeKind, number>()
            for (const n of list) kinds.set(n.kind, (kinds.get(n.kind) ?? 0) + 1)
            return (
              <div key={h} className="flex items-center gap-2 text-[12px]">
                <span className="w-14 shrink-0 font-mono text-content-subtle">{h < 0 ? 'other' : `hop ${h}`}</span>
                <span className="w-8 shrink-0 text-right font-mono tabular-nums text-content">{list.length}</span>
                <span className="flex min-w-0 flex-wrap gap-1">
                  {[...kinds.entries()].map(([k, n]) => (
                    <span key={k} className="inline-flex items-center gap-1 rounded bg-surface-sunken px-1.5 py-px text-[10px] text-content-muted">
                      <span className="size-1.5 rounded-full" style={{ background: KIND_HEX[k] }} />
                      {KIND_LABEL[k]} {n}
                    </span>
                  ))}
                </span>
              </div>
            )
          })}
        </div>
      </div>
      <div>
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Needs attention · {issues.length}</div>
        {issues.length === 0 ? (
          <p className="text-[12px] text-content-subtle">Nothing failed or degraded in this neighbourhood.</p>
        ) : (
          <ul className="max-h-36 space-y-0.5 overflow-y-auto">
            {issues.map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => onFocus(n.id)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] hover:bg-surface-sunken">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: STATUS_HEX[n.status ?? ''] }} />
                  <span className="min-w-0 flex-1 truncate text-content">{n.name}</span>
                  <span className="shrink-0 text-[10px] text-content-subtle">{KIND_LABEL[n.kind]} · hop {hop.get(n.id) ?? '?'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
