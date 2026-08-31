import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import type { GatewayGVR as GVR, KubeObject } from '@adhar-console/api-clients/k8s'
import { kube } from '@adhar-console/api-clients/k8s'
import { cn } from '@adhar-console/utils'
import { useLiveList, type LiveStatus } from '../data/live.ts'
import { clusterParam, useActiveCluster } from '../data/client.ts'
import { useGeneric } from '../data/hooks.ts'
import { useHasK8sPermission } from '../data/access.ts'
import { age } from '../data/format.ts'
import { K8sRolePill } from '../components/role-gate.tsx'
import { DrawerSection, DrawerStatusTile, Row } from './resource-drawer.tsx'
import { ListShell, matchesSearch } from './list-shell.tsx'

/**
 * Tekton CI/CD surface — PipelineRuns (with a task DAG / service map, per-step
 * logs, and re-run / cancel / delete management), Pipelines (with a Run
 * action), Tasks, and Triggers. Everything reads/writes through the per-user
 * Kubernetes gateway (`kube`), so RBAC and audit reflect the real actor. All
 * GVRs are `tekton.dev/v1` unless noted; Triggers are `triggers.tekton.dev`.
 */

/* ─────────── GVRs ─────────── */

const PIPELINERUNS_GVR: GVR = { group: 'tekton.dev', version: 'v1', resource: 'pipelineruns', namespaced: true }
const TASKRUNS_GVR: GVR = { group: 'tekton.dev', version: 'v1', resource: 'taskruns', namespaced: true }
const PIPELINES_GVR: GVR = { group: 'tekton.dev', version: 'v1', resource: 'pipelines', namespaced: true }
const TASKS_GVR: GVR = { group: 'tekton.dev', version: 'v1', resource: 'tasks', namespaced: true }
const CLUSTERTASKS_GVR: GVR = { group: 'tekton.dev', version: 'v1beta1', resource: 'clustertasks', namespaced: false }
const EVENTLISTENERS_GVR: GVR = { group: 'triggers.tekton.dev', version: 'v1beta1', resource: 'eventlisteners', namespaced: true }
const TRIGGERTEMPLATES_GVR: GVR = { group: 'triggers.tekton.dev', version: 'v1beta1', resource: 'triggertemplates', namespaced: true }
const TRIGGERBINDINGS_GVR: GVR = { group: 'triggers.tekton.dev', version: 'v1beta1', resource: 'triggerbindings', namespaced: true }

/* ─────────── Loosely-typed Tekton shapes (any field may be absent) ─────────── */

interface TektonCondition {
  type?: string
  status?: string
  reason?: string
  message?: string
  lastTransitionTime?: string
}
interface TektonParamValue {
  name?: string
  value?: unknown
}
interface TektonWhen {
  input?: string
  operator?: string
  values?: string[]
}
interface TektonPipelineTask {
  name?: string
  displayName?: string
  taskRef?: { name?: string; kind?: string }
  taskSpec?: { steps?: Array<{ name?: string; image?: string }> }
  runAfter?: string[]
  when?: TektonWhen[]
  params?: TektonParamValue[]
}
interface TektonParamSpec {
  name?: string
  type?: string
  description?: string
  default?: unknown
}
interface TektonWorkspaceDecl {
  name?: string
  description?: string
  optional?: boolean
}
interface TektonPipelineSpec {
  tasks?: TektonPipelineTask[]
  finally?: TektonPipelineTask[]
  params?: TektonParamSpec[]
  workspaces?: TektonWorkspaceDecl[]
  results?: Array<{ name?: string; description?: string; value?: string }>
}
interface TektonChildRef {
  name?: string
  kind?: string
  pipelineTaskName?: string
}
interface TektonRunStatus {
  startTime?: string
  completionTime?: string
  conditions?: TektonCondition[]
  childReferences?: TektonChildRef[]
  taskRuns?: Record<string, { pipelineTaskName?: string; status?: { conditions?: TektonCondition[] } }>
  pipelineSpec?: TektonPipelineSpec
  results?: TektonParamValue[]
  skippedTasks?: Array<{ name?: string; reason?: string }>
}
interface TektonRunSpec {
  pipelineRef?: { name?: string }
  pipelineSpec?: TektonPipelineSpec
  params?: TektonParamValue[]
  workspaces?: Array<Record<string, unknown> & { name?: string }>
  status?: string
  timeouts?: Record<string, unknown>
  serviceAccountName?: string
  taskRunTemplate?: Record<string, unknown>
}
interface TektonRun extends KubeObject {
  spec?: TektonRunSpec
  status?: TektonRunStatus
}

interface TektonStepState {
  name?: string
  container?: string
  terminated?: { exitCode?: number; reason?: string; startedAt?: string; finishedAt?: string }
  running?: { startedAt?: string }
  waiting?: { reason?: string }
}
interface TektonTaskRunObj extends KubeObject {
  spec?: { taskRef?: { name?: string; kind?: string } }
  status?: {
    conditions?: TektonCondition[]
    podName?: string
    startTime?: string
    completionTime?: string
    steps?: TektonStepState[]
    taskSpec?: { steps?: Array<{ name?: string; image?: string }> }
    results?: TektonParamValue[]
  }
}
interface TektonPipelineObj extends KubeObject {
  spec?: TektonPipelineSpec
}
interface TektonTaskObj extends KubeObject {
  spec?: {
    steps?: Array<{ name?: string; image?: string; script?: string }>
    params?: TektonParamSpec[]
    results?: Array<{ name?: string; description?: string }>
    workspaces?: TektonWorkspaceDecl[]
    description?: string
  }
}

/* ─────────── Helpers ─────────── */

/** Human duration between two timestamps; end defaults to now while running. */
function duration(start?: string, end?: string): string {
  if (!start) return '—'
  const startMs = new Date(start).getTime()
  if (!Number.isFinite(startMs)) return '—'
  const endMs = end ? new Date(end).getTime() : Date.now()
  let s = Math.max(0, Math.floor((endMs - startMs) / 1000))
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}

/** Re-render on an interval so live durations keep ticking. */
function useTick(ms = 1000) {
  const [, setN] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms)
    return () => clearInterval(id)
  }, [ms])
}

function creationOf(o: KubeObject): number {
  return new Date(o.metadata?.creationTimestamp ?? 0).getTime()
}
function newestFirst(a: KubeObject, b: KubeObject): number {
  return creationOf(b) - creationOf(a)
}

/** Newest `Succeeded`-type condition (falls back to first condition). */
function tektonCondition(conds?: TektonCondition[]): TektonCondition | undefined {
  const all = conds ?? []
  const succeeded = all.filter((c) => c.type === 'Succeeded')
  const pool = succeeded.length ? succeeded : all
  return [...pool].sort(
    (a, b) =>
      new Date(b.lastTransitionTime ?? 0).getTime() - new Date(a.lastTransitionTime ?? 0).getTime(),
  )[0]
}
function tektonKind(c?: TektonCondition): StatusKind {
  if (!c) return 'unknown'
  if (c.status === 'True') return 'healthy'
  if (c.status === 'False') return 'failed'
  return 'progressing'
}
function tektonLabel(c?: TektonCondition): string {
  if (!c) return 'Unknown'
  if (c.reason) return c.reason
  return c.status === 'True' ? 'Succeeded' : c.status === 'False' ? 'Failed' : 'Running'
}
function isRunning(run: TektonRun): boolean {
  if (run.status?.completionTime) return false
  const c = tektonCondition(run.status?.conditions)
  return !c || c.status === 'Unknown'
}
function runProgress(run: TektonRun): string {
  const refs = run.status?.childReferences ?? []
  const trs = Object.values(run.status?.taskRuns ?? {})
  const specTasks = (run.status?.pipelineSpec?.tasks ?? run.spec?.pipelineSpec?.tasks ?? []).length
  const total = refs.length || trs.length || specTasks
  if (!total) return '—'
  const done = trs.filter((tr) => {
    const c = (tr.status?.conditions ?? []).find((x) => x.type === 'Succeeded')
    return c ? c.status !== 'Unknown' : false
  }).length
  return `${done}/${total}`
}

/** Trigger source label from the run's labels or pipelineRef. */
function runTrigger(run: TektonRun): string {
  const labels = run.metadata?.labels ?? {}
  const el = labels['triggers.tekton.dev/eventlistener']
  const trig = labels['triggers.tekton.dev/trigger']
  if (el) return trig ? `${el} · ${trig}` : `EventListener ${el}`
  const pl = labels['tekton.dev/pipeline']
  if (pl) return pl
  return run.spec?.pipelineRef?.name ?? 'manual'
}

/** Health-state → concrete colour usable in SVG (legible on both themes). */
function stateColor(kind: StatusKind): string {
  switch (kind) {
    case 'healthy':
      return '#10b981'
    case 'failed':
    case 'degraded':
      return '#f43f5e'
    case 'progressing':
      return '#6366f1'
    case 'paused':
      return '#f59e0b'
    case 'info':
      return '#0ea5e9'
    default:
      return '#94a3b8'
  }
}

const LIVE_TONE: Record<LiveStatus, string> = {
  live: 'bg-emerald-500',
  connecting: 'bg-amber-500 animate-pulse',
  reconnecting: 'bg-amber-500 animate-pulse',
  error: 'bg-rose-500',
}
function LiveIndicator({ status }: { status: LiveStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-content-subtle">
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${LIVE_TONE[status]}`} />
      {status}
    </span>
  )
}

/* ─────────── DAG model (shared by runs + pipeline preview) ─────────── */

interface DagNode {
  task: TektonPipelineTask
  name: string
  level: number
  kind: StatusKind
  label: string
  isFinally: boolean
}
interface DagEdge {
  from: string
  to: string
}

/** Extract cross-task references from `$(tasks.X.results...)`, `when`, params. */
function referencedTasks(task: TektonPipelineTask, taskNames: Set<string>): Set<string> {
  const out = new Set<string>()
  const scan = (v: unknown) => {
    if (typeof v !== 'string') return
    const re = /\$\(tasks\.([a-z0-9][a-z0-9-]*)\./g
    let m: RegExpExecArray | null
    while ((m = re.exec(v))) {
      if (taskNames.has(m[1])) out.add(m[1])
    }
  }
  for (const p of task.params ?? []) scan(p.value)
  for (const w of task.when ?? []) {
    scan(w.input)
    for (const val of w.values ?? []) scan(val)
  }
  return out
}

/**
 * Build a levelled DAG from a pipeline spec. Edges come from `runAfter` deps
 * plus best-effort `$(tasks.X.*)` result/when/param references. Levels are the
 * longest-path from a root, so dependencies read left→right. `finally` tasks
 * are pinned into the last column. `statusFor` colours each node.
 */
function buildDag(
  spec: TektonPipelineSpec | undefined,
  statusFor: (taskName: string) => { kind: StatusKind; label: string },
): { nodes: DagNode[]; edges: DagEdge[] } {
  const tasks = spec?.tasks ?? []
  const finallyTasks = spec?.finally ?? []
  const names = new Set(tasks.map((t) => t.name ?? '').filter(Boolean))

  const edges: DagEdge[] = []
  const seen = new Set<string>()
  const addEdge = (from: string, to: string) => {
    if (!from || !to || from === to) return
    const key = `${from}→${to}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ from, to })
  }
  for (const t of tasks) {
    const to = t.name ?? ''
    for (const dep of t.runAfter ?? []) if (names.has(dep)) addEdge(dep, to)
    for (const ref of referencedTasks(t, names)) addEdge(ref, to)
  }

  // Longest-path levelling (iterate until stable; capped against cycles).
  const level = new Map<string, number>()
  for (const n of names) level.set(n, 0)
  const incoming = new Map<string, string[]>()
  for (const e of edges) {
    const arr = incoming.get(e.to) ?? []
    arr.push(e.from)
    incoming.set(e.to, arr)
  }
  let maxRegular = 0
  for (let iter = 0; iter < names.size + 1; iter++) {
    let changed = false
    for (const n of names) {
      const parents = incoming.get(n) ?? []
      const lvl = parents.length ? Math.max(...parents.map((p) => (level.get(p) ?? 0) + 1)) : 0
      if (lvl !== level.get(n)) {
        level.set(n, lvl)
        changed = true
      }
    }
    if (!changed) break
  }
  for (const n of names) maxRegular = Math.max(maxRegular, level.get(n) ?? 0)
  const finallyLevel = names.size ? maxRegular + 1 : 0

  const nodes: DagNode[] = []
  for (const t of tasks) {
    const s = statusFor(t.name ?? '')
    nodes.push({ task: t, name: t.name ?? '', level: level.get(t.name ?? '') ?? 0, kind: s.kind, label: s.label, isFinally: false })
  }
  for (const t of finallyTasks) {
    const s = statusFor(t.name ?? '')
    nodes.push({ task: t, name: t.name ?? '', level: finallyLevel, kind: s.kind, label: s.label, isFinally: true })
  }
  return { nodes, edges }
}

const NODE_W = 190
const NODE_H = 52
const COL_GAP = 62
const ROW_GAP = 18

/** SVG-topology DAG: absolute-positioned theme-aware HTML nodes over an SVG edge layer. */
function TaskGraph({
  spec,
  statusFor,
  selected,
  onSelect,
}: {
  spec: TektonPipelineSpec | undefined
  statusFor: (taskName: string) => { kind: StatusKind; label: string }
  selected?: string | null
  onSelect?: (taskName: string) => void
}) {
  const { nodes, edges } = useMemo(() => buildDag(spec, statusFor), [spec, statusFor])

  const layout = useMemo(() => {
    const byLevel = new Map<number, DagNode[]>()
    for (const n of nodes) {
      const arr = byLevel.get(n.level) ?? []
      arr.push(n)
      byLevel.set(n.level, arr)
    }
    const pos = new Map<string, { x: number; y: number }>()
    let maxRow = 0
    for (const [lvl, group] of byLevel) {
      group.forEach((n, i) => {
        pos.set(n.name, { x: lvl * (NODE_W + COL_GAP) + 4, y: i * (NODE_H + ROW_GAP) + 6 })
        maxRow = Math.max(maxRow, i)
      })
    }
    const levels = [...byLevel.keys()]
    const maxLevel = levels.length ? Math.max(...levels) : 0
    const width = (maxLevel + 1) * (NODE_W + COL_GAP) + 8
    const height = (maxRow + 1) * (NODE_H + ROW_GAP) + 12
    return { pos, width, height }
  }, [nodes])

  if (!nodes.length) {
    return (
      <EmptyState
        compact
        title="No task graph available"
        description="This run doesn't expose an inline pipelineSpec, and the referenced Pipeline couldn't be resolved."
      />
    )
  }

  return (
    <div className="overflow-x-auto">
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
        <svg className="absolute inset-0" width={layout.width} height={layout.height} aria-hidden>
          {edges.map((e, i) => {
            const a = layout.pos.get(e.from)
            const b = layout.pos.get(e.to)
            if (!a || !b) return null
            const x1 = a.x + NODE_W
            const y1 = a.y + NODE_H / 2
            const x2 = b.x
            const y2 = b.y + NODE_H / 2
            const mx = (x1 + x2) / 2
            const target = nodes.find((n) => n.name === e.to)
            return (
              <path
                key={i}
                d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                fill="none"
                stroke={stateColor(target?.kind ?? 'unknown')}
                strokeWidth={1.5}
                strokeOpacity={0.55}
              />
            )
          })}
        </svg>
        {nodes.map((n) => {
          const p = layout.pos.get(n.name)!
          return (
            <GraphNode
              key={(n.isFinally ? 'finally-' : '') + n.name}
              left={p.x}
              top={p.y}
              name={n.displayName ?? n.name}
              sub={n.task.taskRef?.name ?? (n.task.taskSpec ? 'inline taskSpec' : undefined)}
              kind={n.kind}
              label={n.label}
              badge={n.isFinally ? 'finally' : undefined}
              selected={selected === n.name}
              onClick={onSelect ? () => onSelect(n.name) : undefined}
            />
          )
        })}
      </div>
      <GraphLegend nodes={nodes} />
    </div>
  )
}

function GraphNode({
  left,
  top,
  name,
  sub,
  kind,
  label,
  badge,
  selected,
  onClick,
}: {
  left: number
  top: number
  name: string
  sub?: string
  kind: StatusKind
  label?: string
  badge?: string
  selected?: boolean
  onClick?: () => void
}) {
  const color = stateColor(kind)
  const cls = cn(
    'absolute flex flex-col justify-center gap-0.5 rounded-lg border bg-surface-raised px-2.5 py-1.5 text-left shadow-sm transition-shadow border-edge-default',
    onClick && 'cursor-pointer hover:shadow-md focus-visible:outline-2 focus-visible:outline-brand-500',
    selected && 'ring-2 ring-brand-500/50',
  )
  const style = { left, top, width: NODE_W, height: NODE_H, borderLeftColor: color, borderLeftWidth: 3 } as const
  const inner = (
    <>
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <span className="truncate text-xs font-semibold text-content">{name}</span>
        {badge ? (
          <span className="ml-auto rounded bg-surface-sunken px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-content-subtle">
            {badge}
          </span>
        ) : null}
      </div>
      <div className="truncate pl-3 text-[10px] font-mono text-content-subtle">
        {label ? `${label}` : ''}
        {sub ? `${label ? ' · ' : ''}${sub}` : ''}
      </div>
    </>
  )
  return onClick ? (
    <button type="button" onClick={onClick} className={cls} style={style} title={`${name}${label ? ` · ${label}` : ''}`} aria-pressed={selected}>
      {inner}
    </button>
  ) : (
    <div className={cls} style={style} title={`${name}${label ? ` · ${label}` : ''}`}>
      {inner}
    </div>
  )
}

function GraphLegend({ nodes }: { nodes: DagNode[] }) {
  const groups: Array<[StatusKind, string]> = [
    ['healthy', 'Succeeded'],
    ['progressing', 'Running'],
    ['failed', 'Failed'],
    ['paused', 'Skipped'],
    ['unknown', 'Pending'],
  ]
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-edge-subtle pt-2.5">
      {groups.map(([kind, label]) => {
        const count = nodes.filter((n) => n.kind === kind).length
        if (!count) return null
        return (
          <span key={kind} className="inline-flex items-center gap-1.5 text-[11px] text-content-muted">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: stateColor(kind) }} />
            {count} {label.toLowerCase()}
          </span>
        )
      })}
    </div>
  )
}

/* ─────────── PipelineRuns tab ─────────── */

export function TektonPipelineRuns({ namespace }: { namespace?: string }) {
  const live = useLiveList<TektonRun>(PIPELINERUNS_GVR, { namespace })
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<TektonRun | null>(null)
  useTick()

  const all = live.data
  const rows = useMemo(
    () =>
      all
        .filter(
          (r) =>
            matchesSearch(r.metadata?.name, search) ||
            matchesSearch(r.metadata?.namespace, search) ||
            matchesSearch(r.spec?.pipelineRef?.name, search) ||
            matchesSearch(tektonCondition(r.status?.conditions)?.reason, search),
        )
        .slice()
        .sort(newestFirst),
    [all, search],
  )

  const notInstalled = live.status === 'error' && all.length === 0

  return (
    <>
      <ListShell
        title="PipelineRuns"
        total={all.length}
        visible={rows.length}
        loading={live.isLoading}
        onRefresh={() => live.refetch()}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search pipeline runs…"
        caption="newest first"
        filters={<LiveIndicator status={live.status} />}
      >
        <DataTable
          loading={live.isLoading}
          onRowClick={(r) => setSelected(r)}
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (r) => (
                <div className="min-w-0">
                  <div className="truncate font-medium text-content">{r.metadata?.name}</div>
                  <div className="truncate text-[11px] text-content-muted">{r.metadata?.namespace}</div>
                </div>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (r) => {
                const c = tektonCondition(r.status?.conditions)
                return <StatusBadge kind={tektonKind(c)}>{tektonLabel(c)}</StatusBadge>
              },
            },
            {
              key: 'pipeline',
              header: 'Pipeline',
              cell: (r) => (
                <code className="text-xs text-content-muted">
                  {r.spec?.pipelineRef?.name ?? (r.spec?.pipelineSpec ? 'inline' : '—')}
                </code>
              ),
            },
            {
              key: 'trigger',
              header: 'Trigger',
              cell: (r) => <span className="text-xs text-content-muted">{runTrigger(r)}</span>,
            },
            {
              key: 'tasks',
              header: 'Tasks',
              cell: (r) => <span className="font-mono text-xs text-content-muted">{runProgress(r)}</span>,
            },
            {
              key: 'started',
              header: 'Started',
              cell: (r) => age(r.status?.startTime ?? r.metadata?.creationTimestamp),
            },
            {
              key: 'duration',
              header: 'Duration',
              cell: (r) => (
                <span className="font-mono text-xs tabular-nums text-content-muted">
                  {duration(r.status?.startTime, r.status?.completionTime)}
                </span>
              ),
            },
          ]}
          rows={rows}
          rowKey={(r) => r.metadata?.uid ?? `${r.metadata?.namespace}/${r.metadata?.name}`}
          empty={
            notInstalled ? (
              <EmptyState
                title="Tekton Pipelines not available"
                description="The tekton.dev/v1 PipelineRuns API isn't served on this cluster (or the watch was denied). Install Tekton Pipelines to see runs here."
              />
            ) : (
              <EmptyState
                title="No pipeline runs"
                description="Tekton PipelineRuns in this scope will appear here as they start."
              />
            )
          }
        />
      </ListShell>
      {selected ? <PipelineRunDrawer run={selected} onClose={() => setSelected(null)} /> : null}
    </>
  )
}

/* ─────────── PipelineRun detail drawer (the centerpiece) ─────────── */

function PipelineRunDrawer({ run: initial, onClose }: { run: TektonRun; onClose(): void }) {
  const { cluster } = useActiveCluster()
  const cp = clusterParam(cluster)
  const qc = useQueryClient()
  const canWrite = useHasK8sPermission('crds.write')
  const ns = initial.metadata?.namespace
  const name = initial.metadata?.name ?? ''
  useTick()

  const [selectedTask, setSelectedTask] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [deleted, setDeleted] = useState(false)

  // Live single-run refetch so the drawer reflects progress.
  const runQ = useQuery<TektonRun>({
    queryKey: ['platform', 'tekton', 'pipelinerun', ns ?? '-', name, cp ?? '-'],
    queryFn: () => kube.get<TektonRun>(PIPELINERUNS_GVR, ns, name, { cluster: cp }),
    initialData: initial,
    refetchInterval: 5000,
    retry: false,
  })
  const run = runQ.data ?? initial
  const running = isRunning(run)

  // TaskRuns for this run — colours the DAG and feeds per-step logs.
  const taskRunsQ = useQuery<TektonTaskRunObj[]>({
    queryKey: ['platform', 'tekton', 'taskruns', ns ?? '-', name, cp ?? '-'],
    queryFn: () =>
      kube
        .list<TektonTaskRunObj>(TASKRUNS_GVR, {
          namespace: ns,
          labelSelector: `tekton.dev/pipelineRun=${name}`,
          cluster: cp,
        })
        .then((l) => l.items),
    refetchInterval: running ? 5000 : false,
    retry: false,
  })
  const taskRunsForbidden = (taskRunsQ.error as { status?: number } | null)?.status === 403

  const spec = run.status?.pipelineSpec ?? run.spec?.pipelineSpec
  const skipped = new Set((run.status?.skippedTasks ?? []).map((s) => s.name).filter(Boolean) as string[])

  // pipelineTaskName → TaskRun (label `tekton.dev/pipelineTask`, else childRef map).
  const trByTask = useMemo(() => {
    const map = new Map<string, TektonTaskRunObj>()
    const list = taskRunsQ.data ?? []
    const childByName = new Map<string, string>() // taskRun name → pipelineTaskName
    for (const ref of run.status?.childReferences ?? []) {
      if (ref.name && ref.pipelineTaskName) childByName.set(ref.name, ref.pipelineTaskName)
    }
    for (const tr of list) {
      const lbl = tr.metadata?.labels?.['tekton.dev/pipelineTask']
      const key = lbl ?? (tr.metadata?.name ? childByName.get(tr.metadata.name) : undefined)
      if (key) map.set(key, tr)
    }
    return map
  }, [taskRunsQ.data, run.status?.childReferences])

  const statusFor = useMemo(
    () =>
      (taskName: string): { kind: StatusKind; label: string } => {
        if (skipped.has(taskName)) return { kind: 'paused', label: 'Skipped' }
        const tr = trByTask.get(taskName)
        if (!tr) {
          // Embedded (deprecated) taskRuns fallback.
          const embedded = Object.values(run.status?.taskRuns ?? {}).find((t) => t.pipelineTaskName === taskName)
          if (embedded) {
            const c = tektonCondition(embedded.status?.conditions)
            return { kind: tektonKind(c), label: tektonLabel(c) }
          }
          return { kind: 'unknown', label: running ? 'Pending' : '—' }
        }
        const c = tektonCondition(tr.status?.conditions)
        return { kind: tektonKind(c), label: tektonLabel(c) }
      },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trByTask, skipped, run.status?.taskRuns, running],
  )

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['platform', 'tekton'] })
  }

  const cancelMut = useMutation({
    mutationFn: () =>
      kube.patch(PIPELINERUNS_GVR, ns, name, { spec: { status: 'Cancelled' } }, 'merge', { cluster: cp }),
    onSuccess: () => {
      setActionError(null)
      runQ.refetch()
      invalidate()
    },
    onError: (e) => setActionError(describeErr(e, 'Cancel failed')),
  })

  const rerunMut = useMutation({
    mutationFn: () => {
      const manifest: KubeObject = {
        apiVersion: 'tekton.dev/v1',
        kind: 'PipelineRun',
        metadata: { name: rerunName(name), ...(ns ? { namespace: ns } : {}) },
        spec: pruneSpec(run.spec),
      }
      return kube.apply<TektonRun>(manifest, { cluster: cp })
    },
    onSuccess: () => {
      setActionError(null)
      invalidate()
      onClose()
    },
    onError: (e) => setActionError(describeErr(e, 'Re-run failed')),
  })

  const deleteMut = useMutation({
    mutationFn: () => kube.delete(PIPELINERUNS_GVR, ns, name, { cluster: cp }),
    onSuccess: () => {
      setActionError(null)
      setDeleted(true)
      setConfirmDelete(false)
      invalidate()
    },
    onError: (e) => setActionError(describeErr(e, 'Delete failed')),
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirmDelete) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, confirmDelete])

  const primary = tektonCondition(run.status?.conditions)
  const kind = tektonKind(primary)
  const label = tektonLabel(primary)
  const params = run.spec?.params ?? []
  const results = run.status?.results ?? []
  const workspaces = run.spec?.workspaces ?? []
  const selectedTr = selectedTask ? trByTask.get(selectedTask) : undefined

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wider text-content-subtle">
              PipelineRun · {ns ?? 'cluster'}
            </div>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-content">{name}</h2>
            <div className="mt-1 flex items-center gap-2 text-[11px] font-mono text-content-muted">
              tekton.dev/v1
              {runQ.isFetching ? (
                <span className="inline-flex items-center gap-1 text-content-subtle">
                  <Spinner size={12} /> refreshing
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge kind={kind}>{label}</StatusBadge>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
            >
              <IconClose />
            </button>
          </div>
        </header>

        {/* Action bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-edge-default bg-surface-sunken/50 px-6 py-2.5">
          {canWrite ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={!running || cancelMut.isPending}
                onClick={() => cancelMut.mutate()}
                title={running ? 'Cancel this running PipelineRun' : 'Only running PipelineRuns can be cancelled'}
              >
                {cancelMut.isPending ? 'Cancelling…' : 'Cancel'}
              </Button>
              <Button size="sm" variant="secondary" disabled={rerunMut.isPending} onClick={() => rerunMut.mutate()}>
                {rerunMut.isPending ? 'Starting…' : 'Re-run'}
              </Button>
              <Button size="sm" variant="danger" disabled={deleteMut.isPending || deleted} onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            </>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-edge-default px-2 py-1 text-[11px] text-content-muted">
              Manage runs <K8sRolePill perm="crds.write" />
            </span>
          )}
          {deleted ? <span className="text-[12px] text-content-muted">Deleted — this run has been removed.</span> : null}
        </div>

        {actionError ? (
          <div className="border-b border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10 px-6 py-2 text-[12px] text-rose-800 dark:text-rose-300" role="alert">
            {actionError}
          </div>
        ) : null}

        {confirmDelete ? (
          <div className="border-b border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10 px-6 py-3" role="alertdialog" aria-label="Confirm delete">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 flex-1 text-[12px] text-content-muted">
                Delete PipelineRun <code className="font-mono">{name}</code>? This removes the run and its TaskRuns/logs. This cannot be undone.
              </p>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)} disabled={deleteMut.isPending}>
                  Cancel
                </Button>
                <Button size="sm" variant="danger" disabled={deleteMut.isPending} onClick={() => deleteMut.mutate()}>
                  {deleteMut.isPending ? 'Deleting…' : 'Delete run'}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <DrawerStatusTile label="Status" kind={kind} value={label} sub={primary?.message} />
            <DrawerStatusTile label="Tasks" kind="info" value={runProgress(run)} />
            <DrawerStatusTile label="Duration" kind="info" value={duration(run.status?.startTime, run.status?.completionTime)} />
            <DrawerStatusTile label="Started" kind="info" value={age(run.status?.startTime ?? run.metadata?.creationTimestamp)} />
          </section>

          <DrawerSection title="Task graph">
            {taskRunsForbidden ? (
              <div className="mb-2 flex items-center gap-1.5 text-[11px] text-content-muted">
                Task status hidden <K8sRolePill perm="crds.read" /> — the graph shows structure only.
              </div>
            ) : null}
            <TaskGraph spec={spec} statusFor={statusFor} selected={selectedTask} onSelect={(t) => setSelectedTask((s) => (s === t ? null : t))} />
            <p className="mt-2 text-[11px] text-content-subtle">Click a task to inspect its steps and logs below.</p>
          </DrawerSection>

          {selectedTask ? (
            <DrawerSection title={`Steps · ${selectedTask}`}>
              <TaskRunSteps namespace={ns} taskRun={selectedTr} taskName={selectedTask} running={running} cluster={cp} />
            </DrawerSection>
          ) : null}

          <DrawerSection title={`Parameters (${params.length})`}>
            {params.length ? (
              <div className="divide-y divide-edge-subtle text-sm">
                {params.map((p, i) => (
                  <Row key={p.name ?? i} label={p.name ?? '—'} value={<code className="font-mono text-xs">{formatValue(p.value)}</code>} />
                ))}
              </div>
            ) : (
              <EmptyState compact title="No parameters" />
            )}
          </DrawerSection>

          <DrawerSection title={`Results (${results.length})`}>
            {results.length ? (
              <div className="divide-y divide-edge-subtle text-sm">
                {results.map((r, i) => (
                  <Row key={r.name ?? i} label={r.name ?? '—'} value={<code className="font-mono text-xs">{formatValue(r.value)}</code>} />
                ))}
              </div>
            ) : (
              <EmptyState compact title={running ? 'No results yet — run in progress' : 'No results emitted'} />
            )}
          </DrawerSection>

          <DrawerSection title={`Workspaces (${workspaces.length})`}>
            {workspaces.length ? (
              <div className="divide-y divide-edge-subtle text-sm">
                {workspaces.map((w, i) => (
                  <Row key={(w.name as string) ?? i} label={(w.name as string) ?? '—'} value={<code className="font-mono text-xs">{workspaceBinding(w)}</code>} />
                ))}
              </div>
            ) : (
              <EmptyState compact title="No workspaces bound" />
            )}
          </DrawerSection>

          <DrawerSection title="Timeline">
            <RunTimeline trByTask={trByTask} spec={spec} onSelect={(t) => setSelectedTask(t)} />
          </DrawerSection>

          <DrawerSection title={`Conditions (${(run.status?.conditions ?? []).length})`}>
            {(run.status?.conditions ?? []).length ? (
              <ul className="divide-y divide-edge-subtle">
                {(run.status?.conditions ?? []).map((c, i) => (
                  <li key={`${c.type ?? 'c'}-${i}`} className="flex items-start gap-3 px-1 py-2 text-sm">
                    <StatusBadge kind={tektonKind(c)}>{c.reason ?? c.type ?? '—'}</StatusBadge>
                    <div className="min-w-0 flex-1">
                      <div className="text-content">{c.type ?? '—'}</div>
                      {c.message ? <div className="mt-0.5 text-xs text-content-muted">{c.message}</div> : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact title="No conditions reported" />
            )}
          </DrawerSection>

          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Raw object</div>
            </CardHeader>
            <CardBody>
              <pre className="max-h-96 overflow-auto rounded-lg bg-slate-950 p-4 font-mono text-[11px] leading-relaxed text-slate-100">
                {JSON.stringify(run, null, 2)}
              </pre>
            </CardBody>
          </Card>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

/* ─────────── Per-step logs for the selected task ─────────── */

function TaskRunSteps({
  namespace,
  taskRun,
  taskName,
  running,
  cluster,
}: {
  namespace?: string
  taskRun?: TektonTaskRunObj
  taskName: string
  running: boolean
  cluster?: string
}) {
  const canLogs = useHasK8sPermission('pods.logs')
  const steps = useMemo(() => {
    const s = taskRun?.status?.steps ?? []
    if (s.length) return s
    // Fall back to declared steps (no runtime status yet).
    const decl = taskRun?.status?.taskSpec?.steps ?? []
    return decl.map((d) => ({ name: d.name, container: d.name ? `step-${d.name}` : undefined }) as TektonStepState)
  }, [taskRun])

  const [active, setActive] = useState(0)
  useEffect(() => setActive(0), [taskName])
  const activeStep = steps[active]
  const podName = taskRun?.status?.podName
  const container = activeStep?.container ?? (activeStep?.name ? `step-${activeStep.name}` : undefined)
  const cond = tektonCondition(taskRun?.status?.conditions)

  if (!taskRun) {
    return (
      <EmptyState
        compact
        title={running ? 'Task not started yet' : 'No TaskRun found'}
        description={
          running
            ? 'This task has not been scheduled yet — its steps and logs will appear once its TaskRun starts.'
            : 'No TaskRun exists for this pipeline task (it may have been skipped, or its status is unavailable).'
        }
      />
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge kind={tektonKind(cond)}>{tektonLabel(cond)}</StatusBadge>
        {taskRun.spec?.taskRef?.name ? (
          <code className="text-[11px] text-content-muted">taskRef: {taskRun.spec.taskRef.name}</code>
        ) : null}
        <span className="text-[11px] text-content-subtle">
          {duration(taskRun.status?.startTime, taskRun.status?.completionTime)}
        </span>
      </div>

      {steps.length ? (
        <div className="flex flex-wrap gap-1.5">
          {steps.map((s, i) => (
            <button
              key={s.name ?? i}
              type="button"
              onClick={() => setActive(i)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
                i === active
                  ? 'border-brand-300 bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300'
                  : 'border-edge-default text-content-muted hover:bg-surface-sunken hover:text-content',
              )}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: stateColor(stepKind(s)) }} />
              {s.name ?? `step-${i}`}
              {s.terminated?.exitCode ? <span className="font-mono text-rose-600">×{s.terminated.exitCode}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      {!canLogs ? (
        <div className="flex items-center gap-1.5 rounded-lg border border-edge-default bg-surface-sunken/50 px-3 py-2 text-[12px] text-content-muted">
          Streaming step logs requires <K8sRolePill perm="pods.logs" />
        </div>
      ) : !podName ? (
        <EmptyState compact title="No pod yet" description="This TaskRun hasn't been assigned a pod — logs become available once it schedules." />
      ) : (
        <StepLog namespace={namespace} pod={podName} container={container} running={running} cluster={cluster} />
      )}
    </div>
  )
}

function stepKind(s: TektonStepState): StatusKind {
  if (s.terminated) return s.terminated.reason === 'Completed' || s.terminated.exitCode === 0 ? 'healthy' : 'failed'
  if (s.running) return 'progressing'
  if (s.waiting) return 'unknown'
  return 'unknown'
}

function StepLog({
  namespace,
  pod,
  container,
  running,
  cluster,
}: {
  namespace?: string
  pod: string
  container?: string
  running: boolean
  cluster?: string
}) {
  const logQ = useQuery<string>({
    queryKey: ['platform', 'tekton', 'logs', namespace ?? '-', pod, container ?? 'default', cluster ?? '-'],
    enabled: Boolean(namespace && pod),
    refetchInterval: running ? 4000 : false,
    retry: false,
    queryFn: () =>
      kube.logStream(namespace as string, pod, { container, tailLines: 2000, timestamps: false, follow: false, cluster }),
  })

  const status = (logQ.error as { status?: number } | null)?.status
  const preRef = useRef<HTMLPreElement | null>(null)
  useEffect(() => {
    if (running && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [logQ.data, running])

  if (logQ.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-slate-950 px-4 py-6 text-[12px] text-slate-300">
        <Spinner size={14} /> Loading logs…
      </div>
    )
  }
  if (status === 403) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg border border-edge-default bg-surface-sunken/50 px-3 py-2 text-[12px] text-content-muted">
        Not authorized to read logs for this pod <K8sRolePill perm="pods.logs" />
      </div>
    )
  }
  if (status === 404) {
    return (
      <EmptyState compact title="Pod no longer exists" description={`The pod backing this TaskRun (${pod}) has been cleaned up, so its logs are no longer available.`} />
    )
  }
  if (logQ.isError) {
    return <div className="rounded-lg border border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10 px-3 py-2 text-[12px] text-rose-800 dark:text-rose-300">Couldn't load logs: {(logQ.error as Error).message}</div>
  }
  const text = logQ.data ?? ''
  if (!text.trim()) {
    return <EmptyState compact title="No log output" description="This step produced no output (yet)." />
  }
  return (
    <div className="relative">
      <pre ref={preRef} className="max-h-80 overflow-auto rounded-lg bg-slate-950 p-4 font-mono text-[11px] leading-relaxed text-slate-100">
        {text}
      </pre>
      {running ? (
        <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded bg-slate-800/80 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> live
        </span>
      ) : null}
    </div>
  )
}

/* ─────────── Timeline (TaskRuns ordered by start) ─────────── */

function RunTimeline({
  trByTask,
  spec,
  onSelect,
}: {
  trByTask: Map<string, TektonTaskRunObj>
  spec: TektonPipelineSpec | undefined
  onSelect: (taskName: string) => void
}) {
  const rows = useMemo(() => {
    const taskNames = [
      ...(spec?.tasks ?? []).map((t) => t.name ?? ''),
      ...(spec?.finally ?? []).map((t) => t.name ?? ''),
    ].filter(Boolean)
    const list = taskNames.map((tn) => {
      const tr = trByTask.get(tn)
      return {
        task: tn,
        start: tr?.status?.startTime,
        end: tr?.status?.completionTime,
        cond: tektonCondition(tr?.status?.conditions),
        has: Boolean(tr),
      }
    })
    return list.sort((a, b) => new Date(a.start ?? '9999').getTime() - new Date(b.start ?? '9999').getTime())
  }, [trByTask, spec])

  if (!rows.length) return <EmptyState compact title="No tasks to time" />
  return (
    <ul className="divide-y divide-edge-subtle">
      {rows.map((r) => (
        <li key={r.task}>
          <button
            type="button"
            onClick={() => onSelect(r.task)}
            className="flex w-full items-center justify-between gap-3 rounded-md px-1.5 py-2 text-left text-sm transition-colors hover:bg-surface-sunken"
          >
            <div className="min-w-0">
              <div className="truncate font-medium text-content">{r.task}</div>
              <div className="text-[11px] text-content-subtle">
                {r.start ? `started ${age(r.start)} ago` : 'not started'}
                {r.start ? ` · ${duration(r.start, r.end)}` : ''}
              </div>
            </div>
            <StatusBadge kind={r.has ? tektonKind(r.cond) : 'unknown'}>
              {r.has ? tektonLabel(r.cond) : 'Pending'}
            </StatusBadge>
          </button>
        </li>
      ))}
    </ul>
  )
}

/* ─────────── Pipelines tab ─────────── */

export function TektonPipelines({ namespace }: { namespace?: string }) {
  const q = useGeneric(PIPELINES_GVR, namespace)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<TektonPipelineObj | null>(null)
  const [running, setRunning] = useState<TektonPipelineObj | null>(null)

  const is404 = q.isError && (q.error as { status?: number })?.status === 404
  const all = (q.data ?? []) as unknown as TektonPipelineObj[]
  const rows = useMemo(
    () => all.filter((p) => matchesSearch(p.metadata?.name, search)).slice().sort(newestFirst),
    [all, search],
  )

  if (is404) {
    return (
      <EmptyState
        title="Tekton Pipelines not installed"
        description="The tekton.dev/v1 Pipelines API isn't registered on this cluster. Install Tekton Pipelines to define and run pipelines."
      />
    )
  }

  return (
    <>
      <ListShell
        title="Pipelines"
        total={all.length}
        visible={rows.length}
        loading={q.isLoading}
        isFetching={q.isFetching && !q.isLoading}
        onRefresh={() => q.refetch()}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search pipelines…"
      >
        <DataTable
          loading={q.isLoading}
          onRowClick={(p) => setSelected(p)}
          columns={[
            { key: 'name', header: 'Name', cell: (p) => <span className="font-medium text-content">{p.metadata?.name}</span> },
            { key: 'ns', header: 'Namespace', cell: (p) => p.metadata?.namespace ?? '—' },
            { key: 'tasks', header: 'Tasks', cell: (p) => <span className="font-mono text-xs text-content-muted">{p.spec?.tasks?.length ?? 0}</span> },
            { key: 'params', header: 'Params', cell: (p) => <span className="font-mono text-xs text-content-muted">{p.spec?.params?.length ?? 0}</span> },
            { key: 'age', header: 'Age', cell: (p) => age(p.metadata?.creationTimestamp) },
          ]}
          rows={rows}
          rowKey={(p) => p.metadata?.uid ?? `${p.metadata?.namespace}/${p.metadata?.name}`}
          empty={<EmptyState title="No pipelines" description="Tekton Pipelines defined in this scope will appear here." />}
        />
      </ListShell>
      {selected ? (
        <PipelineDrawer pipeline={selected} onClose={() => setSelected(null)} onRun={(p) => { setSelected(null); setRunning(p) }} />
      ) : null}
      {running ? <RunPipelineModal pipeline={running} onClose={() => setRunning(null)} /> : null}
    </>
  )
}

function PipelineDrawer({
  pipeline,
  onClose,
  onRun,
}: {
  pipeline: TektonPipelineObj
  onClose(): void
  onRun(p: TektonPipelineObj): void
}) {
  const canWrite = useHasK8sPermission('crds.write')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const spec = pipeline.spec
  const statusFor = () => ({ kind: 'info' as StatusKind, label: '' })

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wider text-content-subtle">Pipeline · {pipeline.metadata?.namespace}</div>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-content">{pipeline.metadata?.name}</h2>
            <div className="mt-1 text-[11px] font-mono text-content-muted">tekton.dev/v1</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {canWrite ? (
              <Button size="sm" onClick={() => onRun(pipeline)}>
                Run
              </Button>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-edge-default px-2 py-1 text-[11px] text-content-muted">
                Run <K8sRolePill perm="crds.write" />
              </span>
            )}
            <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content">
              <IconClose />
            </button>
          </div>
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <DrawerSection title="Task graph">
            <TaskGraph spec={spec} statusFor={statusFor} />
          </DrawerSection>
          <DrawerSection title={`Parameters (${spec?.params?.length ?? 0})`}>
            {spec?.params?.length ? (
              <div className="divide-y divide-edge-subtle text-sm">
                {spec.params.map((p, i) => (
                  <Row
                    key={p.name ?? i}
                    label={p.name ?? '—'}
                    value={
                      <span className="text-right">
                        <code className="font-mono text-xs">{p.type ?? 'string'}</code>
                        {p.default !== undefined ? <span className="ml-1 text-content-subtle">default {formatValue(p.default)}</span> : null}
                      </span>
                    }
                  />
                ))}
              </div>
            ) : (
              <EmptyState compact title="No parameters" />
            )}
          </DrawerSection>
          <DrawerSection title={`Workspaces (${spec?.workspaces?.length ?? 0})`}>
            {spec?.workspaces?.length ? (
              <div className="divide-y divide-edge-subtle text-sm">
                {spec.workspaces.map((w, i) => (
                  <Row key={w.name ?? i} label={w.name ?? '—'} value={w.optional ? 'optional' : 'required'} />
                ))}
              </div>
            ) : (
              <EmptyState compact title="No workspaces declared" />
            )}
          </DrawerSection>
          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Raw object</div>
            </CardHeader>
            <CardBody>
              <pre className="max-h-96 overflow-auto rounded-lg bg-slate-950 p-4 font-mono text-[11px] leading-relaxed text-slate-100">
                {JSON.stringify(pipeline, null, 2)}
              </pre>
            </CardBody>
          </Card>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

/** Small generated form to start a PipelineRun from a Pipeline. */
function RunPipelineModal({ pipeline, onClose }: { pipeline: TektonPipelineObj; onClose(): void }) {
  const { cluster } = useActiveCluster()
  const cp = clusterParam(cluster)
  const qc = useQueryClient()
  const ns = pipeline.metadata?.namespace
  const pname = pipeline.metadata?.name ?? ''
  const paramSpecs = pipeline.spec?.params ?? []
  const workspaces = pipeline.spec?.workspaces ?? []

  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const p of paramSpecs) out[p.name ?? ''] = p.default !== undefined ? String(p.default) : ''
    return out
  })

  const runMut = useMutation({
    mutationFn: () => {
      const params: TektonParamValue[] = paramSpecs
        .map((p) => ({ name: p.name, value: values[p.name ?? ''] ?? '' }))
        .filter((p) => p.name)
      const wsBindings = workspaces
        .filter((w) => !w.optional && w.name)
        .map((w) => ({ name: w.name, emptyDir: {} }))
      const spec: TektonRunSpec = { pipelineRef: { name: pname } }
      if (params.length) spec.params = params
      if (wsBindings.length) spec.workspaces = wsBindings as TektonRunSpec['workspaces']
      const manifest: KubeObject = {
        apiVersion: 'tekton.dev/v1',
        kind: 'PipelineRun',
        metadata: { name: `${pname.slice(0, 40)}-run-${Date.now().toString(36)}`, ...(ns ? { namespace: ns } : {}) },
        spec,
      }
      return kube.apply<TektonRun>(manifest, { cluster: cp })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platform', 'tekton'] })
      onClose()
    },
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !runMut.isPending) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, runMut.isPending])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-slate-900/45 backdrop-blur-[2px]" onClick={() => !runMut.isPending && onClose()} />
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-edge-default bg-surface-app shadow-2xl">
        <header className="border-b border-edge-default bg-surface-raised px-5 py-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-content-subtle">Start a run</div>
          <h2 className="mt-0.5 text-lg font-semibold text-content">Run {pname}</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-content-muted">
            Creates a real PipelineRun referencing this pipeline via server-side apply. Required workspaces are bound to an <code className="font-mono">emptyDir</code> by default.
          </p>
        </header>
        <form
          className="flex-1 space-y-4 overflow-y-auto px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault()
            runMut.mutate()
          }}
        >
          {paramSpecs.length ? (
            <fieldset className="space-y-3" disabled={runMut.isPending}>
              <legend className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Parameters</legend>
              {paramSpecs.map((p) => (
                <div key={p.name}>
                  <label className="mb-1 block text-xs font-medium text-content" htmlFor={`p-${p.name}`}>
                    {p.name}
                    {p.type ? <span className="ml-1 font-mono text-[10px] text-content-subtle">{p.type}</span> : null}
                  </label>
                  <input
                    id={`p-${p.name}`}
                    value={values[p.name ?? ''] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [p.name ?? '']: e.target.value }))}
                    placeholder={p.default !== undefined ? String(p.default) : ''}
                    className="h-9 w-full rounded-md border border-edge-default bg-surface-raised px-2 font-mono text-xs text-content outline-none placeholder:text-content-subtle focus:ring-2 focus:ring-brand-500/30"
                  />
                  {p.description ? <p className="mt-1 text-[11px] text-content-muted">{p.description}</p> : null}
                </div>
              ))}
            </fieldset>
          ) : (
            <p className="text-[12px] text-content-muted">This pipeline declares no parameters — it runs as-is.</p>
          )}
          {workspaces.length ? (
            <p className="text-[11px] text-content-subtle">
              Workspaces: {workspaces.map((w) => w.name).join(', ')} — bound to emptyDir.
            </p>
          ) : null}
          {runMut.isError ? (
            <div className="rounded-lg border border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10 px-3 py-2 text-[12px] text-rose-800 dark:text-rose-300" role="alert">
              <div className="font-semibold">Run failed</div>
              <div className="mt-0.5 break-words font-mono text-[11px]">{describeErr(runMut.error, 'apply failed')}</div>
            </div>
          ) : null}
        </form>
        <footer className="flex items-center justify-end gap-2 border-t border-edge-default bg-surface-raised px-5 py-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={runMut.isPending}>
            Cancel
          </Button>
          <Button size="sm" disabled={runMut.isPending} onClick={() => runMut.mutate()}>
            {runMut.isPending ? 'Starting…' : 'Start run'}
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

/* ─────────── Tasks tab ─────────── */

export function TektonTasks({ namespace }: { namespace?: string }) {
  const q = useGeneric(TASKS_GVR, namespace)
  const clusterTasksQ = useGeneric(CLUSTERTASKS_GVR)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<TektonTaskObj | null>(null)

  const is404 = q.isError && (q.error as { status?: number })?.status === 404
  const nsTasks = (q.data ?? []) as unknown as TektonTaskObj[]
  const clusterTasks = ((clusterTasksQ.data ?? []) as unknown as TektonTaskObj[]).map((t) => ({ ...t, __cluster: true } as TektonTaskObj & { __cluster?: boolean }))
  const all = [...nsTasks, ...clusterTasks]
  const rows = useMemo(
    () => all.filter((t) => matchesSearch(t.metadata?.name, search)).slice().sort(newestFirst),
    [all, search],
  )

  if (is404) {
    return (
      <EmptyState
        title="Tekton Tasks not installed"
        description="The tekton.dev/v1 Tasks API isn't registered on this cluster. Install Tekton Pipelines to define reusable tasks."
      />
    )
  }

  return (
    <>
      <ListShell
        title="Tasks"
        total={all.length}
        visible={rows.length}
        loading={q.isLoading}
        isFetching={q.isFetching && !q.isLoading}
        onRefresh={() => { q.refetch(); clusterTasksQ.refetch() }}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search tasks…"
      >
        <DataTable
          loading={q.isLoading}
          onRowClick={(t) => setSelected(t)}
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (t) => (
                <div className="flex items-center gap-2">
                  <span className="font-medium text-content">{t.metadata?.name}</span>
                  {(t as { __cluster?: boolean }).__cluster ? (
                    <span className="rounded bg-surface-sunken px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-content-subtle">cluster</span>
                  ) : null}
                </div>
              ),
            },
            { key: 'ns', header: 'Namespace', cell: (t) => t.metadata?.namespace ?? 'cluster-scoped' },
            { key: 'steps', header: 'Steps', cell: (t) => <span className="font-mono text-xs text-content-muted">{t.spec?.steps?.length ?? 0}</span> },
            {
              key: 'stepnames',
              header: 'Step names',
              cell: (t) => (
                <span className="truncate text-xs text-content-muted">
                  {(t.spec?.steps ?? []).map((s) => s.name).filter(Boolean).join(' → ') || '—'}
                </span>
              ),
            },
            { key: 'age', header: 'Age', cell: (t) => age(t.metadata?.creationTimestamp) },
          ]}
          rows={rows}
          rowKey={(t) => t.metadata?.uid ?? `${t.metadata?.namespace ?? '-'}/${t.metadata?.name}`}
          empty={<EmptyState title="No tasks" description="Tekton Tasks defined in this scope will appear here." />}
        />
      </ListShell>
      {selected ? <TaskDrawer task={selected} onClose={() => setSelected(null)} /> : null}
    </>
  )
}

function TaskDrawer({ task, onClose }: { task: TektonTaskObj; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const spec = task.spec
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wider text-content-subtle">Task · {task.metadata?.namespace ?? 'cluster'}</div>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-content">{task.metadata?.name}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content">
            <IconClose />
          </button>
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {spec?.description ? <p className="text-sm text-content-muted">{spec.description}</p> : null}
          <DrawerSection title={`Steps (${spec?.steps?.length ?? 0})`}>
            {spec?.steps?.length ? (
              <ol className="space-y-2">
                {spec.steps.map((s, i) => (
                  <li key={s.name ?? i} className="rounded-lg border border-edge-default bg-surface-raised px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-content">{s.name ?? `step-${i + 1}`}</span>
                      <code className="truncate text-[11px] text-content-subtle">{s.image ?? '—'}</code>
                    </div>
                    {s.script ? (
                      <pre className="mt-2 max-h-40 overflow-auto rounded bg-slate-950 p-2 font-mono text-[10px] leading-relaxed text-slate-100">{s.script}</pre>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState compact title="No steps" />
            )}
          </DrawerSection>
          <DrawerSection title={`Parameters (${spec?.params?.length ?? 0})`}>
            {spec?.params?.length ? (
              <div className="divide-y divide-edge-subtle text-sm">
                {spec.params.map((p, i) => (
                  <Row key={p.name ?? i} label={p.name ?? '—'} value={<code className="font-mono text-xs">{p.type ?? 'string'}</code>} />
                ))}
              </div>
            ) : (
              <EmptyState compact title="No parameters" />
            )}
          </DrawerSection>
          <DrawerSection title={`Results (${spec?.results?.length ?? 0})`}>
            {spec?.results?.length ? (
              <div className="divide-y divide-edge-subtle text-sm">
                {spec.results.map((r, i) => (
                  <Row key={r.name ?? i} label={r.name ?? '—'} value={r.description ?? '—'} />
                ))}
              </div>
            ) : (
              <EmptyState compact title="No results" />
            )}
          </DrawerSection>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

/* ─────────── Triggers tab ─────────── */

interface EventListenerObj extends KubeObject {
  spec?: {
    triggers?: Array<{
      name?: string
      bindings?: Array<{ ref?: string; name?: string; kind?: string }>
      template?: { ref?: string; name?: string }
      interceptors?: Array<{ ref?: { name?: string }; name?: string }>
    }>
    serviceAccountName?: string
  }
  status?: { conditions?: TektonCondition[]; configuration?: { generatedName?: string } }
}

export function TektonTriggers({ namespace }: { namespace?: string }) {
  const elQ = useGeneric(EVENTLISTENERS_GVR, namespace)
  const ttQ = useGeneric(TRIGGERTEMPLATES_GVR, namespace)
  const tbQ = useGeneric(TRIGGERBINDINGS_GVR, namespace)

  const is404 = elQ.isError && (elQ.error as { status?: number })?.status === 404
  const eventListeners = (elQ.data ?? []) as unknown as EventListenerObj[]
  const templates = (ttQ.data ?? []) as unknown as KubeObject[]
  const bindings = (tbQ.data ?? []) as unknown as KubeObject[]

  if (is404) {
    return (
      <EmptyState
        title="Tekton Triggers not installed"
        description="The triggers.tekton.dev API isn't registered on this cluster. Install Tekton Triggers to wire event sources (push, PR, cron) to PipelineRuns."
      />
    )
  }

  const loading = elQ.isLoading || ttQ.isLoading || tbQ.isLoading

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-content">EventListeners</div>
            <span className="font-mono text-[11px] text-content-subtle">{eventListeners.length}</span>
          </div>
        </CardHeader>
        <CardBody>
          {loading ? (
            <div className="flex items-center gap-2 text-[12px] text-content-muted">
              <Spinner size={14} /> Loading triggers…
            </div>
          ) : !eventListeners.length ? (
            <EmptyState compact title="No EventListeners" description="EventListeners receive webhooks and fan out to triggers → templates → PipelineRuns." />
          ) : (
            <div className="space-y-4">
              {eventListeners.map((el) => (
                <EventListenerCard key={el.metadata?.uid ?? el.metadata?.name} el={el} />
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <div className="grid gap-5 md:grid-cols-2">
        <RefListCard title="TriggerTemplates" items={templates} />
        <RefListCard title="TriggerBindings" items={bindings} />
      </div>
    </div>
  )
}

function EventListenerCard({ el }: { el: EventListenerObj }) {
  const cond = tektonCondition(el.status?.conditions)
  const triggers = el.spec?.triggers ?? []
  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-content">{el.metadata?.name}</span>
          <code className="text-[11px] text-content-subtle">{el.metadata?.namespace}</code>
        </div>
        <StatusBadge kind={el.status?.conditions?.length ? tektonKind(cond) : 'unknown'}>
          {el.status?.conditions?.length ? tektonLabel(cond) : 'Unknown'}
        </StatusBadge>
      </div>
      {/* Service map: push → EventListener → trigger → bindings/template → PipelineRun */}
      {triggers.length ? (
        <ul className="mt-3 space-y-2">
          {triggers.map((t, i) => (
            <li key={t.name ?? i} className="rounded-lg border border-edge-subtle bg-surface-app px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className="rounded bg-sky-50 px-1.5 py-0.5 font-medium text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">
                  {t.name ?? `trigger-${i + 1}`}
                </span>
                <span className="text-content-subtle">→</span>
                {(t.bindings ?? []).map((b, bi) => (
                  <code key={bi} className="rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] text-content-muted">
                    binding: {b.ref ?? b.name ?? '—'}
                  </code>
                ))}
                <span className="text-content-subtle">→</span>
                <code className="rounded bg-violet-50 px-1.5 py-0.5 text-[11px] text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">
                  template: {t.template?.ref ?? t.template?.name ?? '—'}
                </code>
                {(t.interceptors ?? []).length ? (
                  <span className="text-[11px] text-content-subtle">
                    · {(t.interceptors ?? []).map((x) => x.ref?.name ?? x.name).filter(Boolean).join(', ')}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[12px] text-content-muted">No triggers configured on this EventListener.</p>
      )}
    </div>
  )
}

function RefListCard({ title, items }: { title: string; items: KubeObject[] }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-content">{title}</div>
          <span className="font-mono text-[11px] text-content-subtle">{items.length}</span>
        </div>
      </CardHeader>
      <CardBody>
        {!items.length ? (
          <EmptyState compact title={`No ${title}`} />
        ) : (
          <ul className="divide-y divide-edge-subtle">
            {items.map((it) => (
              <li key={it.metadata?.uid ?? it.metadata?.name} className="flex items-center justify-between gap-3 px-1 py-2 text-sm">
                <span className="truncate font-medium text-content">{it.metadata?.name}</span>
                <span className="text-[11px] text-content-subtle">{age(it.metadata?.creationTimestamp)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

/* ─────────── small util ─────────── */

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return '—'
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

function workspaceBinding(w: Record<string, unknown>): string {
  const keys = Object.keys(w).filter((k) => k !== 'name')
  if (!keys.length) return '—'
  const k = keys[0]
  const v = w[k]
  if (v && typeof v === 'object') {
    const inner = v as Record<string, unknown>
    const named = (inner.claimName ?? inner.name ?? inner.secretName ?? inner.configMap) as string | undefined
    return named ? `${k}: ${named}` : k
  }
  return `${k}: ${formatValue(v)}`
}

/** Generate a unique re-run name derived from the source run. */
function rerunName(base: string): string {
  const root = base.replace(/-(rerun|run)-[a-z0-9]+$/i, '').slice(0, 40)
  return `${root}-rerun-${Date.now().toString(36)}`
}

/** Strip status/name-bound fields from a run spec so it can be re-applied fresh. */
function pruneSpec(spec: TektonRunSpec | undefined): TektonRunSpec {
  if (!spec) return {}
  const out: TektonRunSpec = {}
  if (spec.pipelineRef) out.pipelineRef = spec.pipelineRef
  if (spec.pipelineSpec) out.pipelineSpec = spec.pipelineSpec
  if (spec.params) out.params = spec.params
  if (spec.workspaces) out.workspaces = spec.workspaces
  if (spec.serviceAccountName) out.serviceAccountName = spec.serviceAccountName
  if (spec.taskRunTemplate) out.taskRunTemplate = spec.taskRunTemplate
  if (spec.timeouts) out.timeouts = spec.timeouts
  // Deliberately drop spec.status (would create a pre-cancelled run).
  return out
}

function describeErr(e: unknown, prefix: string): string {
  const status = (e as { status?: number } | null)?.status
  if (status === 403) return `${prefix}: not authorized (403).`
  if (status === 404) return `${prefix}: not found (404).`
  return `${prefix}: ${e instanceof Error ? e.message : String(e)}`
}

function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
