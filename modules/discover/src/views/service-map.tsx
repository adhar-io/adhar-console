import { useMemo, useState } from 'react'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import type { lgtm } from '@adhar-console/api-clients'
import { useServiceMap } from '../data/observability.ts'

/**
 * Service Map — OpenTelemetry-derived service topology rendered as an
 * SVG flow with edge thickness ∝ RPS and a per-edge error pill. Click
 * a node to focus its 1-hop neighbourhood.
 */
export function ServiceMap() {
  const q = useServiceMap()
  const [focused, setFocused] = useState<string | null>(null)

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Building service map…
      </div>
    )
  }
  if (!q.data) {
    return <EmptyState title="Service map unavailable" />
  }

  const { nodes, edges } = q.data
  const layout = useMemo(() => layoutNodes(nodes, edges), [nodes, edges])
  const visibleEdges = focused
    ? edges.filter((e) => e.from === focused || e.to === focused)
    : edges

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
      <Card className="overflow-hidden">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-content">Topology</div>
            {focused ? (
              <button
                type="button"
                onClick={() => setFocused(null)}
                className="rounded-md px-2 py-0.5 text-[11px] text-brand-700 hover:bg-brand-50"
              >
                clear focus
              </button>
            ) : null}
          </div>
        </CardHeader>
        <CardBody className="p-3!">
          <div
            className="relative overflow-hidden rounded-md border border-edge-default bg-linear-to-br from-surface-sunken/40 to-white"
            style={{ aspectRatio: '16 / 9' }}
          >
            <svg viewBox="0 0 1000 560" preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full">
              <defs>
                <marker id="sm-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0,0 L10,5 L0,10 Z" fill="var(--color-content-subtle)" />
                </marker>
                <marker id="sm-arrow-err" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0,0 L10,5 L0,10 Z" fill="var(--color-rose-500)" />
                </marker>
              </defs>
              {/* edges */}
              {visibleEdges.map((e, i) => {
                const a = layout.get(e.from)
                const b = layout.get(e.to)
                if (!a || !b) return null
                const err = e.errorRate >= 1
                const w = Math.max(1, Math.min(6, e.rps / 20))
                const dx = b.x - a.x
                const dy = b.y - a.y
                const len = Math.hypot(dx, dy) || 1
                const ux = dx / len
                const uy = dy / len
                const sx = a.x + ux * 32
                const sy = a.y + uy * 32
                const ex = b.x - ux * 36
                const ey = b.y - uy * 36
                const mx = (sx + ex) / 2
                const my = (sy + ey) / 2
                return (
                  <g key={i}>
                    <line
                      x1={sx}
                      y1={sy}
                      x2={ex}
                      y2={ey}
                      stroke={err ? 'var(--color-rose-500)' : 'var(--color-content-subtle)'}
                      strokeOpacity={err ? 0.85 : 0.6}
                      strokeWidth={w}
                      markerEnd={err ? 'url(#sm-arrow-err)' : 'url(#sm-arrow)'}
                    />
                    <g transform={`translate(${mx},${my})`}>
                      <rect x="-22" y="-9" width="44" height="18" rx="9" fill="white" stroke="var(--color-edge-default)" />
                      <text x="0" y="3" fontSize="9" textAnchor="middle" fill={err ? 'var(--color-rose-700)' : 'var(--color-content-muted)'}>
                        {e.rps.toFixed(0)} rps · {e.errorRate.toFixed(1)}%
                      </text>
                    </g>
                  </g>
                )
              })}
              {/* nodes */}
              {nodes.map((n) => {
                const p = layout.get(n.name)
                if (!p) return null
                const errTone = n.errorRate >= 1 ? 'rose' : n.errorRate >= 0.3 ? 'amber' : 'emerald'
                const isActive = focused === n.name
                const fill =
                  errTone === 'rose'
                    ? 'var(--color-rose-50)'
                    : errTone === 'amber'
                      ? 'var(--color-amber-50)'
                      : 'var(--color-emerald-50)'
                const stroke =
                  errTone === 'rose'
                    ? 'var(--color-rose-500)'
                    : errTone === 'amber'
                      ? 'var(--color-amber-500)'
                      : 'var(--color-emerald-500)'
                return (
                  <g
                    key={n.name}
                    transform={`translate(${p.x},${p.y})`}
                    className="cursor-pointer"
                    onClick={() => setFocused(isActive ? null : n.name)}
                  >
                    <circle r={36} fill={fill} stroke={stroke} strokeWidth={isActive ? 3 : 1.5} />
                    <text x="0" y="-2" fontSize="11" fontWeight="600" textAnchor="middle" fill="var(--color-content)">
                      {n.name}
                    </text>
                    <text x="0" y="13" fontSize="9" textAnchor="middle" fill="var(--color-content-muted)">
                      {n.rps.toFixed(0)} rps · {n.p95Ms.toFixed(0)}ms
                    </text>
                  </g>
                )
              })}
            </svg>
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-content-muted">
            <Legend dot="bg-emerald-500" label="< 0.3% errors" />
            <Legend dot="bg-amber-500" label="0.3–1% errors" />
            <Legend dot="bg-rose-500" label="≥ 1% errors" />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <div className="text-sm font-semibold text-content">Services</div>
          <div className="text-[11px] text-content-subtle">{nodes.length} nodes · {edges.length} edges</div>
        </CardHeader>
        <CardBody className="p-0!">
          <ul className="divide-y divide-edge-subtle">
            {nodes
              .slice()
              .sort((a, b) => b.rps - a.rps)
              .map((n) => (
                <ServiceRow key={n.name} node={n} active={focused === n.name} onPick={() => setFocused(focused === n.name ? null : n.name)} />
              ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  )
}

function ServiceRow({
  node,
  active,
  onPick,
}: {
  node: lgtm.ServiceNode
  active: boolean
  onPick(): void
}) {
  const tone = node.errorRate >= 1 ? 'failed' : node.errorRate >= 0.3 ? 'progressing' : 'healthy'
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className={cn(
          'flex w-full items-center gap-2 px-4 py-2.5 text-left text-[11px] transition-colors',
          active ? 'bg-brand-50' : 'hover:bg-surface-sunken',
        )}
      >
        <StatusBadge kind={tone}>{node.errorRate.toFixed(1)}%</StatusBadge>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold text-content">{node.name}</div>
          <div className="text-[10px] text-content-subtle">
            {node.language ?? '—'} · apdex {(node.apdex ?? 1).toFixed(2)}
          </div>
        </div>
        <div className="text-right font-mono">
          <div className="text-content">{node.rps.toFixed(0)} rps</div>
          <div className="text-content-subtle">{node.p95Ms.toFixed(0)} ms</div>
        </div>
      </button>
    </li>
  )
}

function Legend({ dot, label }: { dot: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  )
}

/**
 * Tiny radial layout — entry-points (no incoming edges) start on the left,
 * downstreams flow rightwards. Good enough for ~10 nodes; would swap for
 * d3-force at scale.
 */
function layoutNodes(
  nodes: lgtm.ServiceNode[],
  edges: lgtm.ServiceEdge[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  const inDeg = new Map<string, number>()
  nodes.forEach((n) => inDeg.set(n.name, 0))
  edges.forEach((e) => inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1))

  // Group by depth from any zero-in-degree root.
  const depth = new Map<string, number>()
  const roots = nodes.filter((n) => (inDeg.get(n.name) ?? 0) === 0).map((n) => n.name)
  const queue: string[] = roots.map((r) => {
    depth.set(r, 0)
    return r
  })
  while (queue.length) {
    const cur = queue.shift()!
    const d = depth.get(cur) ?? 0
    for (const e of edges) {
      if (e.from !== cur) continue
      const nd = (depth.get(e.to) ?? Infinity)
      if (d + 1 < nd) {
        depth.set(e.to, d + 1)
        queue.push(e.to)
      }
    }
  }
  // Anything still missing — treat as terminal column at max depth + 1.
  const maxDepth = Math.max(0, ...Array.from(depth.values()).filter(Number.isFinite))
  nodes.forEach((n) => {
    if (!depth.has(n.name)) depth.set(n.name, maxDepth + 1)
  })

  const cols: Record<number, string[]> = {}
  for (const n of nodes) {
    const d = depth.get(n.name) ?? 0
    ;(cols[d] ??= []).push(n.name)
  }

  const colKeys = Object.keys(cols).map(Number).sort((a, b) => a - b)
  const colW = 1000 / Math.max(colKeys.length, 1)
  for (const c of colKeys) {
    const list = cols[c]
    const rowH = 560 / (list.length + 1)
    list.forEach((name, i) => {
      const x = (c + 0.5) * colW
      const y = (i + 1) * rowH
      positions.set(name, { x, y })
    })
  }
  return positions
}
