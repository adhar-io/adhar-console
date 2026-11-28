import { type DragEvent, memo, type MutableRefObject, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  type Connection,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import { cn } from '@adhar/utils'
import { chromeRules, ensureFlowCss } from '../../components/flow-css.ts'
import type { WfDoc } from '../model/doc.ts'
import { CONDITIONS, type Condition } from '../model/depends.ts'
import type { DesignerGraph } from '../model/project.ts'
import { type Action, GRID } from './designer-state.ts'
import { type CardData, FlowCache, type FlowEdgeData, toFlow } from './flow-model.ts'
import { KindTile } from './glyph.tsx'
import { KIND_LOOK } from './kind-look.ts'
import { MIME } from './mime.ts'

/**
 * The designer's canvas, EDIT mode (design 0026 §6.8, W2-C2). The only file of
 * the designer that imports @xyflow; `views/designer.tsx` loads it with
 * React.lazy, so the overview, the lists and the designer's own shell carry no
 * React Flow (W1 acceptance 5, `chunks_test.ts`).
 *
 * Controlled: nodes and edges come from the projection through `toFlow`,
 * which hands back the same objects for every card that did not change — so a
 * pan re-renders nothing and an edit re-renders the cards it touched
 * (acceptance 7, `flow-model_test.ts`). While a card is being dragged its
 * position lives here; the document hears about it once, on drag END.
 */

export { MIME }

export interface CanvasCommands {
  fit?(): void
  zoomIn?(): void
  zoomOut?(): void
}

export interface DesignerCanvasProps {
  graph: DesignerGraph
  doc: WfDoc
  frozen: boolean
  selected: string | null
  dispatch(a: Action): void
  commands: MutableRefObject<CanvasCommands>
  height?: number | string
  className?: string
}

type CardNode = Node<CardData, 'card'>
type DependsEdge = Edge<FlowEdgeData & { onRemove?(source: string, target: string): void }, 'depends'>

const SCOPE = 'adhar-flow-designer'
const RULES = `${chromeRules(SCOPE)}
.${SCOPE} .react-flow__handle{width:10px;height:10px;border:2px solid var(--color-surface-raised);background:var(--color-edge-strong)}
.${SCOPE} .react-flow__handle-connecting,.${SCOPE} .react-flow__handle-valid{background:#6366f1}
.${SCOPE} .react-flow__node:focus-visible{outline:none}
.${SCOPE} .react-flow__node:focus-visible .wf-card{box-shadow:0 0 0 3px #6366f1}
`

/* ─────────────────────────── the card ─────────────────────────── */

function Chip({ children, title }: { children: ReactNode; title: string }) {
  return <span title={title} className="rounded bg-surface-sunken px-1 py-px font-mono text-[10px] leading-tight text-content-muted">{children}</span>
}

const Card = memo(function Card({ data }: NodeProps<CardNode>) {
  const { node, subtitle, errors, warnings, problem, selected, editable } = data
  const look = KIND_LOOK[node.kind]
  const b = node.badges
  return (
    <div
      className={cn(
        'wf-card relative flex h-[72px] w-[248px] items-center gap-2.5 rounded-xl border bg-surface-raised px-3 text-left shadow-sm transition-shadow',
        selected ? 'border-brand-500 shadow-md ring-2 ring-brand-500/40' : 'border-edge-default hover:shadow-md',
        errors ? 'border-rose-500/70' : warnings ? 'border-amber-500/60' : '',
        node.lane === 'exit' && 'border-dashed',
      )}
      title={problem}
    >
      <Handle type="target" position={Position.Left} isConnectable={editable} aria-label={`Connect into ${node.id}`} />
      <KindTile look={look} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold text-content" title={node.id}>{node.id}</div>
        <div className="truncate font-mono text-[11px] text-content-subtle" title={subtitle ?? node.title}>{subtitle ?? node.title ?? look.label}</div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        {errors ? <span className="rounded bg-rose-500/15 px-1 text-[10px] font-semibold text-rose-700 dark:text-rose-300" title={problem}>{errors} error{errors === 1 ? '' : 's'}</span> : warnings ? <span className="rounded bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-800 dark:text-amber-300" title={problem}>{warnings} warning{warnings === 1 ? '' : 's'}</span> : null}
        {b.retry ? <Chip title={`retried up to ${b.retry} times`}>×{b.retry}</Chip> : null}
        {b.timeout ? <Chip title={`time limit ${b.timeout}`}>⏱</Chip> : null}
        {b.when ? <Chip title={`when: ${b.when}`}>when</Chip> : null}
        {b.fanOut ? <Chip title={`fan-out (${b.fanOut})`}>×N</Chip> : null}
        {b.hooks ? <Chip title={`${b.hooks} hook${b.hooks === 1 ? '' : 's'}`}>hooks</Chip> : null}
        {b.expression ? <Chip title="depends is an expression">ƒ</Chip> : null}
        {node.group ? <Chip title={`${node.group.nodes.length} steps inside`}>{node.group.nodes.length}</Chip> : null}
        {node.lane === 'exit' ? <Chip title="runs when the workflow ends">exit</Chip> : null}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={editable} aria-label={`Connect from ${node.id}`} />
    </div>
  )
})

/* ─────────────────────────── the edge ─────────────────────────── */

function DependsLine({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd, deletable }: EdgeProps<DependsEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 10 })
  const look = data?.look ?? { stroke: '#94a3b8' }
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ stroke: look.stroke, strokeWidth: 1.5, strokeDasharray: look.dash }} />
      {look.label || deletable ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan group absolute flex items-center gap-1 rounded bg-surface-raised px-1 font-mono text-[10px] text-content-muted ring-1 ring-edge-subtle"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all' }}
          >
            {look.label ? <span>{look.label}</span> : null}
            {deletable && data?.onRemove ? (
              <button
                type="button"
                className="rounded px-0.5 text-content-subtle opacity-40 hover:bg-rose-500/10 hover:text-rose-600 hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
                aria-label={`Remove the connection from ${source} to ${target}`}
                title="Remove this connection"
                onClick={() => data.onRemove?.(source, target)}
              >
                ×
              </button>
            ) : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

const nodeTypes = { card: Card }
const edgeTypes = { depends: DependsLine }

/* ─────────────────────────── the canvas ─────────────────────────── */

export function DesignerCanvas(props: DesignerCanvasProps) {
  ensureFlowCss(SCOPE, RULES)
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  )
}

export default DesignerCanvas

function Inner({ graph, doc, frozen, selected, dispatch, commands, height = '100%', className }: DesignerCanvasProps) {
  const flow = useReactFlow<CardNode, DependsEdge>()
  const cache = useRef(new FlowCache())
  const base = useMemo(() => toFlow(graph, doc, selected, cache.current, { frozen }), [graph, doc, selected, frozen])
  // Positions of the cards being dragged (until drag end); everything else is the projection's.
  const [dragging, setDragging] = useState<Record<string, { x: number; y: number }>>({})
  const nodes = useMemo(() => {
    const ids = Object.keys(dragging)
    if (!ids.length) return base.nodes as unknown as CardNode[]
    return base.nodes.map((n) => (dragging[n.id] ? { ...n, position: dragging[n.id] } : n)) as unknown as CardNode[]
  }, [base.nodes, dragging])
  const onRemove = useCallback((source: string, target: string) => dispatch({ type: 'disconnect', source, target }), [dispatch])
  const edgesWithRemove = useRef(new WeakMap<object, DependsEdge>())
  const edges = useMemo(() => base.edges.map((e) => {
    // Keep each edge's object stable too: wrap once per flow-model object.
    let w = edgesWithRemove.current.get(e)
    if (!w) {
      w = { ...(e as unknown as DependsEdge), markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: e.markerEnd.color }, data: { ...e.data, onRemove } }
      edgesWithRemove.current.set(e, w)
    }
    return w
  }), [base.edges, onRemove])

  useEffect(() => {
    commands.current = {
      fit: () => void flow.fitView({ padding: 0.2, maxZoom: 1.1, duration: 200 }),
      zoomIn: () => void flow.zoomIn({ duration: 150 }),
      zoomOut: () => void flow.zoomOut({ duration: 150 }),
    }
  }, [flow, commands])

  const onNodesChange = useCallback((changes: NodeChange<CardNode>[]) => {
    const moving: Record<string, { x: number; y: number }> = {}
    for (const c of changes) {
      if (c.type === 'position' && c.position && c.dragging) moving[c.id] = c.position
      // Keyboard (Enter/Space on a focused card) and click both arrive as a select change.
      if (c.type === 'select' && c.selected) dispatch({ type: 'select', node: c.id })
    }
    if (Object.keys(moving).length) setDragging((d) => ({ ...d, ...moving }))
  }, [dispatch])

  const onNodeDragStop = useCallback((_: unknown, _node: CardNode, moved: CardNode[]) => {
    const positions: Record<string, { x: number; y: number }> = {}
    for (const n of moved) positions[n.id] = { x: Math.round(n.position.x / GRID) * GRID, y: Math.round(n.position.y / GRID) * GRID }
    setDragging({})
    dispatch({ type: 'moved', positions })
  }, [dispatch])

  // Shift held when the connection was started: ask for the condition (§6.8).
  const shiftAtStart = useRef(false)
  const [asking, setAsking] = useState<{ source: string; target: string } | null>(null)
  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return
    if (shiftAtStart.current) setAsking({ source: c.source, target: c.target })
    else dispatch({ type: 'connect', source: c.source, target: c.target })
  }, [dispatch])

  const onDragOver = useCallback((e: DragEvent) => {
    if (!e.dataTransfer.types.includes(MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])
  const onDrop = useCallback((e: DragEvent) => {
    const id = e.dataTransfer.getData(MIME)
    if (!id) return
    e.preventDefault()
    dispatch({ type: 'drop', entry: id, at: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }) })
  }, [dispatch, flow])

  const editable = graph.editable && !frozen
  return (
    <div className={cn(SCOPE, 'relative h-full overflow-hidden bg-surface-app', className)} style={{ height }} onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow<CardNode, DependsEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={editable}
        nodesConnectable={editable}
        nodesFocusable
        edgesFocusable={false}
        elementsSelectable
        // Delete is the page's key (it knows the selection and announces the result).
        deleteKeyCode={null}
        snapToGrid
        snapGrid={[GRID, GRID]}
        onlyRenderVisibleElements={nodes.length > 150}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onConnectStart={(e) => void (shiftAtStart.current = Boolean((e as MouseEvent).shiftKey))}
        onConnect={onConnect}
        onPaneClick={() => dispatch({ type: 'select', node: null })}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} color="var(--color-edge-strong)" />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(n) => KIND_LOOK[(n.data as CardData).node.kind].hex} nodeStrokeWidth={2} />
        {asking ? (
          <Panel position="top-center">
            <div role="dialog" aria-label="When does it run?" className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-surface-raised p-2 text-xs shadow-lg">
              <span className="mr-1 text-content-muted">"{asking.target}" runs when "{asking.source}"</span>
              {CONDITIONS.map((c: Condition) => (
                <button
                  key={c}
                  type="button"
                  className="rounded-md border border-edge-default px-2 py-0.5 hover:bg-surface-sunken"
                  onClick={() => {
                    dispatch({ type: 'connect', source: asking.source, target: asking.target, condition: c })
                    setAsking(null)
                  }}
                >
                  {c}
                </button>
              ))}
              <button type="button" className="ml-1 text-content-subtle hover:underline" onClick={() => setAsking(null)}>Cancel</button>
            </div>
          </Panel>
        ) : null}
      </ReactFlow>
      {!graph.nodes.length && editable ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center">
          <div className="max-w-sm rounded-xl border border-dashed border-edge-strong bg-surface-raised/80 px-5 py-4 text-sm text-content-muted">
            Drag a step from the palette, or select one and press Enter.
          </div>
        </div>
      ) : null}
    </div>
  )
}
