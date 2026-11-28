import type { WfDoc } from '../model/doc.ts'
import { getIn } from '../model/doc.ts'
import type { DesignerEdge, DesignerGraph, DesignerNode } from '../model/project.ts'
import { allNodes } from '../model/project.ts'
import type { Diagnostic } from '../model/validate.ts'

/**
 * Designer graph → React Flow's nodes and edges (design 0026 §6.8), as plain
 * objects so this stays testable without React Flow.
 *
 * The budget it serves: a 200-node DAG pans smoothly (W2 acceptance 7).
 * Panning re-renders nothing as long as the `nodes`/`edges` props keep their
 * identity, and an edit re-renders only the cards it changed as long as every
 * other card keeps its object. So `toFlow` keeps a cache: a node whose drawn
 * content (its signature) did not change gets back the SAME object, and when
 * nothing changed at all the SAME arrays come back. `flow-model_test.ts` holds
 * it to that on a synthetic 200-node DAG.
 */

export interface CardData extends Record<string, unknown> {
  node: DesignerNode
  /** Image short name, or `library/template` for a reference. */
  subtitle?: string
  errors: number
  warnings: number
  /** First error or warning, for the card's tooltip. */
  problem?: string
  selected: boolean
  editable: boolean
}

export interface FlowNode {
  id: string
  type: 'card'
  position: { x: number; y: number }
  data: CardData
  draggable: boolean
  connectable: boolean
  selectable: true
  focusable: true
  selected: boolean
  ariaLabel: string
}

export interface EdgeLook {
  stroke: string
  dash?: string
  label?: string
}

export interface FlowEdgeData extends Record<string, unknown> {
  edge: DesignerEdge
  look: EdgeLook
}

export interface FlowEdge {
  id: string
  source: string
  target: string
  type: 'depends'
  data: FlowEdgeData
  markerEnd: { type: 'arrowclosed'; width: number; height: number; color: string }
  focusable: boolean
  deletable: boolean
  ariaLabel: string
}

export const EDGE_HEX = { success: '#94a3b8', failure: '#f43f5e', guard: '#f59e0b', expression: '#64748b', other: '#6366f1' } as const

/** §6.8 edges: failure rose + dashed "on failure", `when` amber + dashed with the condition, expressions slate + dashed ƒ. */
export function edgeLook(e: DesignerEdge, guard?: string): EdgeLook {
  if (e.condition === 'Failed' || e.condition === 'Errored' || e.condition === 'AllFailed') return { stroke: EDGE_HEX.failure, dash: '6 4', label: 'on failure' }
  if (e.condition === 'Expression') return { stroke: EDGE_HEX.expression, dash: '4 4', label: 'ƒ' }
  if (e.condition !== 'Succeeded') return { stroke: EDGE_HEX.other, dash: '4 4', label: e.condition }
  if (guard) return { stroke: EDGE_HEX.guard, dash: '5 4', label: guard.length > 24 ? `${guard.slice(0, 23)}…` : guard }
  return { stroke: EDGE_HEX.success }
}

/** What the card says under the name: the image's last path segment, or the reference. */
export function subtitleOf(d: WfDoc, n: DesignerNode): string | undefined {
  if (n.template.ref) return `${n.template.ref.name}/${n.template.ref.template}`
  if (!n.templatePath) return undefined
  const image = getIn<string>(d, [...n.templatePath, 'container', 'image']) ?? getIn<string>(d, [...n.templatePath, 'script', 'image'])
  if (typeof image === 'string') return image.split('/').pop()
  const url = getIn<string>(d, [...n.templatePath, 'http', 'url'])
  if (typeof url === 'string') return url.replace(/^https?:\/\//, '')
  const duration = getIn<string>(d, [...n.templatePath, 'suspend', 'duration'])
  if (duration !== undefined) return `wait ${duration}`
  if (n.group) return `${n.group.nodes.length} step${n.group.nodes.length === 1 ? '' : 's'}`
  return undefined
}

interface Cached<T> {
  sig: string
  value: T
}

export class FlowCache {
  nodes = new Map<string, Cached<FlowNode>>()
  edges = new Map<string, Cached<FlowEdge>>()
  lastNodes: FlowNode[] = []
  lastEdges: FlowEdge[] = []
  /** How many node objects the last call built (the render-work measure the perf test bounds). */
  built = 0
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function nodeSig(n: DesignerNode, sub: string | undefined, diags: readonly Diagnostic[], selected: boolean, editable: boolean): string {
  return JSON.stringify([
    n.uid, n.id, n.kind, n.title, n.lane, n.sharedBy, n.path, n.templatePath, n.template, n.badges, n.position.x, n.position.y, n.column, n.group?.nodes.length,
    sub, diags.length, diags.map((x) => x.level + x.message), selected, editable,
  ])
}

/** Diagnostics per node uid, in one pass (a per-node filter is O(nodes × diagnostics) on every edit). */
function diagnosticsByNode(g: DesignerGraph, nodes: readonly DesignerNode[]): Map<string, Diagnostic[]> {
  const byTask = new Map<string, Diagnostic[]>()
  const byTemplate = new Map<string, Diagnostic[]>()
  for (const d of g.diagnostics) {
    if (d.level === 'info') continue
    if (d.task) byTask.set(d.task.uid, [...(byTask.get(d.task.uid) ?? []), d])
    else if (d.template) byTemplate.set(d.template, [...(byTemplate.get(d.template) ?? []), d])
  }
  const out = new Map<string, Diagnostic[]>()
  for (const n of nodes) {
    const own = byTask.get(n.uid) ?? []
    const tpl = n.template.local ? byTemplate.get(n.template.local) ?? [] : []
    if (own.length || tpl.length) out.set(n.uid, [...own, ...tpl])
  }
  return out
}

/** The canvas's nodes and edges; reuses every object (and the arrays) whose content did not change. */
export function toFlow(g: DesignerGraph, d: WfDoc, selected: string | null, cache: FlowCache, opts: { frozen?: boolean } = {}): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const visible = allNodes(g, false)
  const diags = diagnosticsByNode(g, visible)
  const nextNodes = new Map<string, Cached<FlowNode>>()
  let built = 0
  const nodes = visible.map((n) => {
    const editable = !opts.frozen && (n.lane === 'main' ? g.editable : Boolean(g.exitLane?.editable))
    const sub = subtitleOf(d, n)
    const mine = diags.get(n.uid) ?? []
    const isSel = selected === n.uid
    const sig = nodeSig(n, sub, mine, isSel, editable)
    const hit = cache.nodes.get(n.uid)
    if (hit && hit.sig === sig) {
      nextNodes.set(n.uid, hit)
      return hit.value
    }
    built++
    const errors = mine.filter((x) => x.level === 'error')
    const value: FlowNode = {
      id: n.uid,
      type: 'card',
      position: { x: n.position.x, y: n.position.y },
      data: {
        node: n,
        subtitle: sub,
        errors: errors.length,
        warnings: mine.length - errors.length,
        problem: (errors[0] ?? mine[0])?.message,
        selected: isSel,
        editable,
      },
      draggable: editable,
      connectable: editable,
      selectable: true,
      focusable: true,
      selected: isSel,
      ariaLabel: `${n.id}, ${n.title ?? n.kind}${errors.length ? `, ${errors.length} error${errors.length === 1 ? '' : 's'}` : ''}`,
    }
    nextNodes.set(n.uid, { sig, value })
    return value
  })
  cache.nodes = nextNodes
  cache.built = built
  if (!sameList(nodes, cache.lastNodes)) cache.lastNodes = nodes

  const guards = new Map(visible.filter((n) => n.badges.when).map((n) => [n.uid, n.badges.when!]))
  const all = [...g.edges, ...(g.exitLane?.edges ?? [])]
  const nextEdges = new Map<string, Cached<FlowEdge>>()
  const edges = all.map((e) => {
    const guard = guards.get(e.target)
    const editable = !opts.frozen && g.editable && e.condition !== 'Expression'
    const sig = JSON.stringify([e, guard, editable])
    const hit = cache.edges.get(e.id)
    if (hit && hit.sig === sig) {
      nextEdges.set(e.id, hit)
      return hit.value
    }
    const look = edgeLook(e, guard)
    const value: FlowEdge = {
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'depends',
      data: { edge: e, look },
      markerEnd: { type: 'arrowclosed', width: 16, height: 16, color: look.stroke },
      focusable: editable,
      deletable: editable,
      ariaLabel: `${e.target} runs after ${e.source}${e.condition === 'Succeeded' ? '' : ` (${e.condition})`}`,
    }
    nextEdges.set(e.id, { sig, value })
    return value
  })
  cache.edges = nextEdges
  if (!sameList(edges, cache.lastEdges)) cache.lastEdges = edges
  return { nodes: cache.lastNodes, edges: cache.lastEdges }
}
