import { memo, type ReactNode, useMemo, useRef } from 'react'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react'
import { cn } from '@adhar/utils'
import { chromeRules, ensureFlowCss } from '../../components/flow-css.ts'
import { type EdgeState, type RunGraph, type RunGraphEdge, type RunGraphNode, type RunNodeKind, shortDuration, elapsedMs } from '../data/nodes.ts'
import { clockFor, layoutGraph, type Positions } from '../model/layout.ts'

/**
 * The workflow canvas on React Flow 12 (design 0026 §6.8). W1 ships the RUN
 * mode: the graph of one run, read-only, status on every card and edge, live
 * from the run's watch. The designer's EDIT mode arrives with W2 on the same
 * component.
 *
 * This file is the only one in the Workflows area that imports `@xyflow`; it
 * is loaded on demand (`React.lazy`) by the run view, so the overview and the
 * lists never carry React Flow (W1 acceptance 5, `chunks_test.ts`).
 */

export type CanvasMode = 'run'

/** Status → raw colour (the Tekton run canvas's, `tekton.tsx`): ring, minimap, edges. */
export const STATUS_HEX: Record<string, string> = {
  healthy: '#10b981',
  failed: '#f43f5e',
  degraded: '#f43f5e',
  progressing: '#6366f1',
  paused: '#f59e0b',
  unknown: '#94a3b8',
  info: '#94a3b8',
}

/** Green behind, indigo moving on the active path, grey ahead, red where it broke. */
export const EDGE_HEX: Record<EdgeState, string> = {
  done: '#10b981',
  active: '#6366f1',
  ahead: '#94a3b8',
  broken: '#f43f5e',
}

/** The kind's hue, as theme-aware classes for the icon tile. */
const KIND_TILE: Record<RunNodeKind, string> = {
  container: 'bg-sky-500/12 text-sky-600 dark:text-sky-300',
  script: 'bg-violet-500/12 text-violet-600 dark:text-violet-300',
  resource: 'bg-teal-500/12 text-teal-600 dark:text-teal-300',
  http: 'bg-indigo-500/12 text-indigo-600 dark:text-indigo-300',
  approval: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  suspend: 'bg-slate-500/12 text-content-muted',
  template: 'bg-cyan-500/12 text-cyan-700 dark:text-cyan-300',
  group: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  step: 'bg-cyan-500/12 text-cyan-700 dark:text-cyan-300',
  exit: 'bg-slate-500/12 text-content-muted',
}

const KIND_LABEL: Record<RunNodeKind, string> = {
  container: 'Container',
  script: 'Script',
  resource: 'Kubernetes resource',
  http: 'HTTP call',
  approval: 'Approval',
  suspend: 'Timer',
  template: 'Template',
  group: 'Sub-flow',
  step: 'Step',
  exit: 'Exit handler',
}

function KindGlyph({ kind }: { kind: RunNodeKind }) {
  const p = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  switch (kind) {
    case 'container':
      return <svg {...p}><path d="M21 8 12 3 3 8v8l9 5 9-5z" /><path d="m3 8 9 5 9-5M12 13v8" /></svg>
    case 'script':
      return <svg {...p}><path d="m7 8-4 4 4 4M17 8l4 4-4 4M14 4l-4 16" /></svg>
    case 'resource':
      return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 3v18M3 12h18" /></svg>
    case 'http':
      return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>
    case 'approval':
      return <svg {...p}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" /><path d="m9 12 2 2 4-4" /></svg>
    case 'suspend':
      return <svg {...p}><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2M9 2h6" /></svg>
    case 'group':
      return <svg {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><path d="M10 6.5h4a3 3 0 0 1 3 3V14" /></svg>
    case 'exit':
      return <svg {...p}><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" /></svg>
    default:
      return <svg {...p}><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 9h8M8 13h8M8 17h5" /></svg>
  }
}

/* ─────────────────────────── node ─────────────────────────── */

export interface RunNodeData extends Record<string, unknown> {
  node: RunGraphNode
  now: number
  selected: boolean
  onSelect?(id: string): void
}

type RunFlowNode = Node<RunNodeData, 'run'>

const RunNodeCard = memo(function RunNodeCard({ data }: NodeProps<RunFlowNode>) {
  const { node, now, selected } = data
  const ring = STATUS_HEX[node.status] ?? STATUS_HEX.unknown
  const running = !node.dim && (node.status === 'progressing' || node.status === 'paused')
  const elapsed = elapsedMs(node.startedAt, node.finishedAt, now)
  const fan = node.fanOut
  const fanPct = fan && fan.total ? Math.round(((fan.succeeded + fan.failed) / fan.total) * 100) : undefined
  return (
    <div
      role="button"
      tabIndex={-1}
      aria-label={`${node.label}: ${node.awaitingApproval ? 'waiting for approval' : node.phase ?? 'not started'}`}
      onClick={() => data.onSelect?.(node.id)}
      className={cn(
        'wf-run-node relative flex h-[88px] w-[248px] cursor-pointer flex-col rounded-xl border bg-surface-raised text-left shadow-sm transition-shadow',
        selected ? 'border-brand-500 shadow-md' : 'border-edge-default hover:shadow-md',
        node.dim && 'opacity-60',
      )}
      style={{ boxShadow: `0 0 0 ${selected ? 3 : 2}px ${ring}${node.dim ? '55' : ''}` }}
    >
      {running ? <span aria-hidden className="wf-pulse pointer-events-none absolute -inset-[3px] rounded-[14px]" style={{ boxShadow: `0 0 0 2px ${ring}` }} /> : null}
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-transparent" isConnectable={false} />
      <div className="flex min-h-0 flex-1 items-center gap-2.5 px-3 pt-2">
        <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', KIND_TILE[node.kind])} title={KIND_LABEL[node.kind]}>
          <KindGlyph kind={node.kind} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-content" title={node.label}>{node.label}</div>
          {node.subtitle ? <div className="truncate font-mono text-[11px] text-content-subtle" title={node.subtitle}>{node.subtitle}</div> : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          {node.attempts && node.attempts > 1 ? <Chip title={`${node.attempts} attempts`}>×{node.attempts}</Chip> : null}
          {fan ? <Chip title="Fan-out">×{fan.total || '…'}</Chip> : null}
          {node.when ? <Chip title={`when: ${node.when}`}>when</Chip> : null}
          {node.children ? <Chip title={`${node.children} nodes inside`}>{node.children}</Chip> : null}
        </div>
      </div>
      <div className="flex h-6 shrink-0 items-center gap-2 border-t border-edge-subtle px-3 text-[11px] text-content-muted">
        <span className="font-medium" style={{ color: node.dim ? undefined : ring }}>
          {node.awaitingApproval ? 'Waiting for approval' : node.phase ?? 'Not started'}
        </span>
        {fan && fan.total ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5" title={`${fan.succeeded} succeeded, ${fan.failed} failed, ${fan.running} running of ${fan.total}`}>
            <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-sunken">
              <span className="block h-full rounded-full" style={{ width: `${fanPct}%`, background: fan.failed ? STATUS_HEX.failed : STATUS_HEX.healthy }} />
            </span>
          </span>
        ) : <span className="flex-1" />}
        <span className="tabular-nums">{elapsed !== undefined ? shortDuration(elapsed) : ''}</span>
      </div>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-transparent" isConnectable={false} />
    </div>
  )
})

function Chip({ children, title }: { children: ReactNode; title: string }) {
  return <span title={title} className="rounded bg-surface-sunken px-1 py-px font-mono text-[10px] leading-tight text-content-muted">{children}</span>
}

/* ─────────────────────────── edge ─────────────────────────── */

interface RunEdgeData extends Record<string, unknown> {
  edge: RunGraphEdge
  /** The target is guarded by `when`. */
  guard?: string
}

type RunFlowEdge = Edge<RunEdgeData, 'run'>

/** What an edge says about its condition (§6.8): failure rose + dashed, expressions ƒ, `when` amber. */
export function edgeLook(e: RunGraphEdge, guard?: string): { stroke: string; dash?: string; label?: string; animated: boolean } {
  const stroke = EDGE_HEX[e.state]
  const animated = e.state === 'active'
  if (e.condition === 'Failed' || e.condition === 'Errored' || e.condition === 'AllFailed') return { stroke: e.state === 'ahead' ? '#fb7185' : stroke, dash: '6 4', label: 'on failure', animated }
  if (e.condition === 'Expression') return { stroke, dash: '4 4', label: 'ƒ', animated }
  if (e.condition !== 'Succeeded') return { stroke, dash: '4 4', label: e.condition, animated }
  if (guard) return { stroke: e.state === 'ahead' ? '#f59e0b' : stroke, dash: '5 4', label: guard.length > 24 ? `${guard.slice(0, 23)}…` : guard, animated }
  return { stroke, animated }
}

function RunEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps<RunFlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 10 })
  const look = data ? edgeLook(data.edge, data.guard) : { stroke: EDGE_HEX.ahead, animated: false }
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={look.animated ? 'wf-edge-active' : undefined}
        style={{ stroke: look.stroke, strokeWidth: 1.5, strokeDasharray: look.animated ? '6 4' : look.dash }}
      />
      {look.label ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded bg-surface-raised px-1 font-mono text-[10px] text-content-muted ring-1 ring-edge-subtle"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {look.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

const nodeTypes = { run: RunNodeCard }
const edgeTypes = { run: RunEdge }

/* ─────────────────────────── canvas ─────────────────────────── */

const SCOPE = 'adhar-flow'
const ORIGIN = { x: 0, y: 0 }

/** The canvas's own rules on top of the shared chrome: the running pulse and the moving edge, both off under reduced motion. */
const FLOW_RULES = `${chromeRules(SCOPE)}
.${SCOPE} .wf-pulse{animation:wf-pulse 1.6s ease-out infinite}
@keyframes wf-pulse{0%{opacity:.75;transform:scale(1)}100%{opacity:0;transform:scale(1.04)}}
.${SCOPE} .wf-edge-active{animation:wf-dash 1s linear infinite}
@keyframes wf-dash{to{stroke-dashoffset:-20}}
@media (prefers-reduced-motion: reduce){.${SCOPE} .wf-pulse{animation:none;opacity:.5}.${SCOPE} .wf-edge-active{animation:none;stroke-dasharray:2 3}}
`

export interface WorkflowCanvasProps {
  mode?: CanvasMode
  graph: RunGraph
  /** Designer positions (`adhar.io/designer-positions`), when the template carries them. */
  positions?: Positions
  selected?: string | null
  onSelect?(taskId: string): void
  now: number
  height?: number | string
  className?: string
}

/** A stable key for the graph's SHAPE: layout is recomputed only when it changes. */
function shapeKey(g: RunGraph): string {
  return `${g.nodes.map((n) => `${n.id}:${n.lane}`).join('|')}#${g.edges.map((e) => e.id).join('|')}`
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  ensureFlowCss(SCOPE, FLOW_RULES)
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  )
}

export default WorkflowCanvas

function Canvas({ graph, positions, selected = null, onSelect, now, height = 460, className }: WorkflowCanvasProps) {
  const shape = shapeKey(graph)
  // Layout follows the shape only; status changes move no card (§6.8).
  const pos = useMemo(() => {
    const auto = layoutGraph(graph.nodes, graph.edges)
    return positions ? { ...auto, ...Object.fromEntries(Object.entries(positions).filter(([k]) => auto[k])) } : auto
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, positions])
  const guards = useMemo(() => new Map(graph.nodes.filter((n) => n.when).map((n) => [n.id, n.when!])), [graph.nodes])
  // The clock ticks every second while a run is live, but only a card whose
  // step is still running shows it: every other card keeps the SAME node
  // object between ticks, so React Flow and the memoised card skip it rather
  // than re-rendering the whole graph once a second (§6.8 budgets).
  const cache = useRef(new Map<string, { src: RunGraphNode; tick: number; selected: boolean; pos: { x: number; y: number }; onSelect?: (id: string) => void; flow: RunFlowNode }>())
  const nodes: RunFlowNode[] = useMemo(() => {
    const next = new Map<string, { src: RunGraphNode; tick: number; selected: boolean; pos: { x: number; y: number }; onSelect?: (id: string) => void; flow: RunFlowNode }>()
    const out = graph.nodes.map((n) => {
      const tick = clockFor(n, now)
      const isSel = selected === n.id
      const p = pos[n.id] ?? ORIGIN
      const hit = cache.current.get(n.id)
      if (hit && hit.src === n && hit.tick === tick && hit.selected === isSel && hit.pos === p && hit.onSelect === onSelect) {
        next.set(n.id, hit)
        return hit.flow
      }
      const flow: RunFlowNode = {
        id: n.id,
        type: 'run' as const,
        position: p,
        data: { node: n, now: tick, selected: isSel, onSelect },
        draggable: false,
        connectable: false,
        selectable: true,
        focusable: true,
        ariaLabel: n.label,
      }
      next.set(n.id, { src: n, tick, selected: isSel, pos: p, onSelect, flow })
      return flow
    })
    cache.current = next
    return out
  }, [graph.nodes, pos, now, selected, onSelect])
  const edges: RunFlowEdge[] = useMemo(
    () => graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'run' as const,
      data: { edge: e, guard: guards.get(e.target) },
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: edgeLook(e, guards.get(e.target)).stroke },
      focusable: false,
    })),
    [graph.edges, guards],
  )
  const running = graph.nodes.filter((n) => !n.dim && n.status === 'progressing').length
  const failed = graph.nodes.filter((n) => n.status === 'failed').length
  const waiting = graph.nodes.filter((n) => n.awaitingApproval).length
  return (
    <div className={cn(SCOPE, 'relative overflow-hidden rounded-xl border border-edge-default bg-surface-app', className)} style={{ height }}>
      <ReactFlow<RunFlowNode, RunFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable
        edgesFocusable={false}
        elementsSelectable
        onlyRenderVisibleElements={graph.nodes.length > 150}
        onNodeClick={(_, n) => onSelect?.(n.id)}
        // Keyboard: Enter/Space on a focused card selects it inside React Flow
        // (a `select` change) and fires no click — without this, a keyboard
        // user could focus every step and open none (§6.8 "nodes are focusable
        // and every action has a button").
        onNodesChange={(changes) => {
          const picked = changes.find((c) => c.type === 'select' && c.selected)
          if (picked && 'id' in picked && picked.id !== selected) onSelect?.(picked.id)
        }}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
        minZoom={0.15}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} color="var(--color-edge-strong)" />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(n) => STATUS_HEX[(n.data as RunNodeData).node.status] ?? STATUS_HEX.unknown} nodeStrokeWidth={2} />
      </ReactFlow>
      <div className="sr-only" aria-live="polite">
        {`${running} running, ${waiting} waiting for approval, ${failed} failed`}
      </div>
    </div>
  )
}
