import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addEdge,
  Background,
  type Connection,
  Controls,
  type Edge,
  Handle,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Badge,
  Button,
  Card,
  CardBody,
  Field,
  Input,
  Select,
  Textarea,
  useCan,
  useToast,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import {
  CRON_PRESETS,
  CRON_RE,
  cronForDate,
  describeCron,
  findCycle,
  layoutGraph,
  normaliseStepName,
  type Schedule,
  type ScheduleMode,
  stepDepths,
  type StepNode,
  toArgoSpec,
  uniqueStepName,
  validateGraph,
  type WorkflowGraph,
} from '../data/wf-model.ts'
import { STARTERS } from '../data/wf-starters.ts'
import { presetById, STEP_PRESETS, type StepPreset, stepFromPreset } from '../data/wf-presets.ts'
import { submitWorkflow, upsertCronWorkflow, upsertWorkflowTemplate } from '../data/workflows.ts'

/**
 * The workflow designer — a pipeline canvas on top of Argo Workflows.
 *
 * Three panes, the way a CI editor reads: a palette of step kinds on the
 * left that are dragged onto the canvas, the canvas itself in the middle
 * laid out as stages (one column per dependency depth, left to right, the
 * same shape as the Tekton pipeline view), and an inspector on the right
 * for the selected step or — when nothing is selected — the workflow's own
 * settings, including WHEN it runs.
 *
 * "When" is the part a designer usually leaves out. Here it is a first-class
 * setting with three answers: run now (a Workflow), run once at a time (a
 * CronWorkflow with a stop strategy so it fires exactly once), or run on a
 * schedule (a CronWorkflow). The same graph produces all three; only the
 * wrapper differs, so a workflow designed for a one-off can be made nightly
 * without rebuilding it.
 *
 * The graph is the single source of truth and the spec is generated from it
 * on every save. Nothing about the canvas is stored except node positions
 * and stage names, which ride in annotations Argo ignores, so a workflow
 * edited by hand in git still opens here.
 */

type StepData = {
  step: StepNode
  selected: boolean
  problem: boolean
  stage: number
  stageName?: string
}

const GLYPH_TONE: Record<StepPreset['tone'], string> = {
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300',
  orange: 'bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
  sky: 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  emerald: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  violet: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  amber: 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  rose: 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  indigo: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
  cyan: 'bg-cyan-50 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300',
}

/** The preset a step most looks like, by image — for its glyph only. */
function presetFor(step: StepNode): StepPreset | undefined {
  const img = step.image.split(':')[0]
  return STEP_PRESETS.find((p) => p.image.split(':')[0] === img)
}

function glyphOf(step: StepNode): { text: string; cls: string } {
  const p = presetFor(step)
  if (p) return { text: p.glyph, cls: GLYPH_TONE[p.tone] }
  const text = (step.label || step.id).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'ST'
  return { text, cls: 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300' }
}

/** One step on the canvas: a pipeline node with its stage, image and command. */
function StepNodeView({ data }: NodeProps<Node<StepData>>) {
  const { step, problem, stage, stageName } = data
  const g = glyphOf(step)
  return (
    <div
      className={cn(
        'w-[224px] rounded-xl border bg-surface-raised shadow-sm transition-[border-color,box-shadow]',
        problem ? 'border-rose-400 ring-2 ring-rose-400/30' : data.selected ? 'border-brand-400 ring-2 ring-brand-400/30' : 'border-edge-default hover:border-edge-strong hover:shadow-md',
      )}
    >
      {/* Left takes incoming dependencies, right creates them: a pipeline flows left to right. */}
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2 !border-surface-raised !bg-brand-500" />
      <div className="flex items-center gap-2.5 px-3 pt-2.5">
        <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold', g.cls)}>{g.text}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold text-content">{step.label || step.id}</div>
          <div className="truncate font-mono text-[10px] text-content-subtle">{step.image || 'no image'}</div>
        </div>
      </div>
      <div className="mt-1.5 truncate px-3 font-mono text-[10px] text-content-muted">{step.command || 'no command'}</div>
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-edge-subtle px-3 py-1.5 text-[10px]">
        <span className="truncate text-content-subtle" title={stageName ? `Stage ${stage + 1} · ${stageName}` : `Stage ${stage + 1}`}>
          {stageName || `Stage ${stage + 1}`}
        </span>
        {step.when ? <span className="shrink-0 rounded bg-amber-50 px-1 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">when</span> : null}
        {step.dependsOn.length ? <span className="shrink-0 text-content-subtle">after {step.dependsOn.length}</span> : <span className="shrink-0 text-content-subtle">starts first</span>}
      </div>
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-surface-raised !bg-brand-500" />
    </div>
  )
}

const NODE_TYPES = { step: StepNodeView }

/**
 * Whether the console is currently in dark mode.
 *
 * React Flow ships its own stylesheet for the minimap, the zoom controls and
 * the attribution, and none of it uses our tokens — left alone those render
 * as white panels on a dark page. Its `colorMode` prop themes them properly,
 * but it has to be TOLD: the console themes off a `.dark` class on <html>,
 * not off `prefers-color-scheme`, so reading the media query would be wrong
 * whenever the two disagree. Observing the class is the only correct source.
 */
function useIsDark(): boolean {
  const read = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  const [dark, setDark] = useState(read)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const obs = new MutationObserver(() => setDark(read()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return dark
}

export interface WorkflowDesignerProps {
  namespace: string
  /** Open an existing workflow / template / cron in the canvas. */
  initial?: WorkflowGraph
  initialSchedule?: Schedule
  onClose?(): void
  /** A CronWorkflow was created or updated. */
  onScheduled?(name: string): void
  /** A Workflow was submitted. */
  onSubmitted?(name: string): void
}

export function WorkflowDesigner(props: WorkflowDesignerProps) {
  return (
    <ReactFlowProvider>
      <Designer {...props} />
    </ReactFlowProvider>
  )
}

const DROP_MIME = 'application/x-adhar-step'

function Designer({ namespace, initial, initialSchedule, onClose, onScheduled, onSubmitted }: WorkflowDesignerProps) {
  const toast = useToast()
  const canEdit = useCan('develop')
  const isDark = useIsDark()
  const rf = useReactFlow()
  const [graph, setGraph] = useState<WorkflowGraph | null>(initial ?? null)
  const [schedule, setSchedule] = useState<Schedule>(initialSchedule ?? { mode: 'now' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLDivElement>(null)

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<StepData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const problems = useMemo(() => (graph ? validateGraph(graph) : []), [graph])
  const problemSteps = useMemo(() => new Set(problems.map((p) => p.step).filter(Boolean) as string[]), [problems])
  const depths = useMemo(() => (graph ? stepDepths(graph.steps) : new Map<string, number>()), [graph])
  const stageCount = useMemo(() => (graph?.steps.length ? Math.max(...[...depths.values()]) + 1 : 0), [graph, depths])

  /* Graph → canvas. The canvas is a projection; the graph is the truth. */
  useEffect(() => {
    if (!graph) return
    setNodes(graph.steps.map((s) => {
      const stage = depths.get(s.id) ?? 0
      return {
        id: s.id,
        type: 'step',
        position: { x: s.x, y: s.y },
        data: { step: s, selected: s.id === selectedId, problem: problemSteps.has(s.id), stage, stageName: graph.stages?.[stage] },
      }
    }))
    setEdges(graph.steps.flatMap((s) =>
      s.dependsOn.map((d) => ({ id: `${d}->${s.id}`, source: d, target: s.id, animated: false }))
    ))
  }, [graph, selectedId, problemSteps, depths, setNodes, setEdges])

  const patchStep = useCallback((id: string, patch: Partial<StepNode>) => {
    setGraph((g) => g ? { ...g, steps: g.steps.map((s) => s.id === id ? { ...s, ...patch } : s) } : g)
  }, [])

  /* An edge is a dependency. Refuse one that would make a cycle: Argo
     accepts a cyclic DAG and then never starts, with nothing explaining it. */
  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return
    setGraph((g) => {
      if (!g) return g
      const target = g.steps.find((s) => s.id === c.target)
      if (!target || target.dependsOn.includes(c.source!)) return g
      const next = {
        ...g,
        steps: g.steps.map((s) => s.id === c.target ? { ...s, dependsOn: [...s.dependsOn, c.source!] } : s),
      }
      if (findCycle(next.steps)) {
        toast.warning('That would create a loop', {
          description: 'Argo accepts a circular DAG and then never starts any step.',
        })
        return g
      }
      return next
    })
    setEdges((e) => addEdge({ ...c, id: `${c.source}->${c.target}` }, e))
  }, [setEdges, toast])

  const onEdgesDelete = useCallback((removed: Edge[]) => {
    setGraph((g) =>
      g
        ? {
          ...g,
          steps: g.steps.map((s) => {
            const gone = removed.filter((e) => e.target === s.id).map((e) => e.source)
            return gone.length ? { ...s, dependsOn: s.dependsOn.filter((d) => !gone.includes(d)) } : s
          }),
        }
        : g
    )
  }, [])

  const onNodesDelete = useCallback((removed: Node[]) => {
    const ids = new Set(removed.map((n) => n.id))
    setGraph((g) =>
      g
        ? {
          ...g,
          steps: g.steps.filter((s) => !ids.has(s.id)).map((s) => ({
            ...s,
            // A dependency on a deleted step would fail validation forever.
            dependsOn: s.dependsOn.filter((d) => !ids.has(d)),
          })),
        }
        : g
    )
    setSelectedId((id) => (id && ids.has(id) ? null : id))
  }, [])

  /** Add a step from a preset — at a dropped position, or after the selected step. */
  const addPreset = useCallback((preset: StepPreset, at?: { x: number; y: number }) => {
    setGraph((g) => {
      if (!g) return g
      const id = uniqueStepName(preset.id, g.steps.map((s) => s.id))
      const anchor = g.steps.find((s) => s.id === selectedId)
      const pos = at ?? (anchor ? { x: anchor.x + 270, y: anchor.y } : { x: 60 + (g.steps.length ? Math.max(...g.steps.map((s) => s.x)) + 270 - 60 : 0), y: 60 })
      const step = stepFromPreset(preset, id, Math.round(pos.x), Math.round(pos.y))
      // Dropped next to a selected step: make it follow that step, which is
      // what "add after" means in a pipeline.
      if (!at && anchor) step.dependsOn = [anchor.id]
      setSelectedId(id)
      return { ...g, steps: [...g.steps, step] }
    })
  }, [selectedId])

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DROP_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    const id = e.dataTransfer.getData(DROP_MIME)
    const preset = id ? presetById(id) : undefined
    if (!preset) return
    e.preventDefault()
    const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    // Centre the node on the cursor rather than hanging it off the corner.
    addPreset(preset, { x: pos.x - 112, y: pos.y - 40 })
  }, [rf, addPreset])

  const selected = graph?.steps.find((s) => s.id === selectedId) ?? null

  if (!graph) {
    return (
      <StarterPicker
        namespace={namespace}
        onPick={(g) => {
          setGraph(g)
          setSelectedId(null)
        }}
        onClose={onClose}
      />
    )
  }

  const runLabel = schedule.mode === 'now' ? 'Run now' : schedule.mode === 'once' ? 'Schedule once' : 'Schedule'

  const run = async () => {
    if (problems.length) {
      toast.error('Fix the problems first', { description: problems[0].message })
      return
    }
    setBusy(true)
    try {
      if (schedule.mode === 'now') {
        const created = await submitWorkflow(toArgoSpec(graph, { kind: 'Workflow', generateName: true }))
        toast.success(`Submitted ${created.metadata.name}`)
        onSubmitted?.(created.metadata.name)
      } else if (schedule.mode === 'once') {
        if (!schedule.at) throw new Error('Pick a date and time.')
        const when = new Date(schedule.at)
        if (Number.isNaN(when.getTime())) throw new Error('That date is not valid.')
        if (when.getTime() < Date.now() - 60_000) throw new Error('That time has already passed.')
        const timezone = schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
        const created = await upsertCronWorkflow(
          toArgoSpec(graph, {
            kind: 'CronWorkflow',
            schedule: { cron: cronForDate(when), timezone, concurrencyPolicy: 'Forbid', suspend: schedule.suspend, oneShot: true },
          }),
        )
        toast.success(`Scheduled ${created.metadata.name}`, { description: `Runs once, ${when.toLocaleString()} ${timezone}` })
        onScheduled?.(created.metadata.name)
      } else {
        const cron = (schedule.cron ?? '').trim()
        if (!CRON_RE.test(cron)) throw new Error('A schedule needs a five-field cron expression, e.g. 0 2 * * *')
        const created = await upsertCronWorkflow(
          toArgoSpec(graph, {
            kind: 'CronWorkflow',
            schedule: { cron, timezone: schedule.timezone || undefined, concurrencyPolicy: schedule.concurrencyPolicy ?? 'Forbid', suspend: schedule.suspend },
          }),
        )
        toast.success(`Scheduled ${created.metadata.name}`, { description: describeCron(cron, schedule.timezone) })
        onScheduled?.(created.metadata.name)
      }
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const saveTemplate = async () => {
    if (problems.length) {
      toast.error('Fix the problems first', { description: problems[0].message })
      return
    }
    setBusy(true)
    try {
      const created = await upsertWorkflowTemplate(toArgoSpec(graph, { kind: 'WorkflowTemplate' }))
      toast.success(`Saved template ${created.metadata.name}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      {/* ── toolbar ── */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-edge-default bg-surface-raised px-4 py-2.5 shadow-sm">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-content">{graph.name}</span>
            <Badge>{graph.namespace}</Badge>
          </div>
          <div className="mt-0.5 text-[11px] text-content-subtle">
            {graph.steps.length} step{graph.steps.length === 1 ? '' : 's'} · {stageCount} stage{stageCount === 1 ? '' : 's'}
            {problems.length ? <span className="text-rose-600 dark:text-rose-300"> · {problems.length} problem{problems.length === 1 ? '' : 's'}</span> : null}
            {' · '}
            <button type="button" onClick={() => setSelectedId(null)} className="text-brand-700 hover:underline dark:text-brand-300">
              {schedule.mode === 'now' ? 'runs immediately' : schedule.mode === 'once' ? `once, ${schedule.at ? new Date(schedule.at).toLocaleString() : 'time not set'}` : describeCron(schedule.cron ?? '', schedule.timezone)}
            </button>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setGraph((g) => g ? { ...g, steps: layoutGraph(g.steps) } : g)} title="Lay the steps out as stages, left to right">
            Tidy
          </Button>
          <Button variant="ghost" size="sm" onClick={() => rf.fitView({ padding: 0.2 })}>
            Fit
          </Button>
          {canEdit ? (
            <>
              <Button variant="secondary" size="sm" disabled={busy} onClick={saveTemplate}>
                Save as template
              </Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={run}>
                {busy ? 'Working…' : runLabel}
              </Button>
            </>
          ) : null}
          {onClose ? <Button variant="ghost" size="sm" onClick={onClose}>Close</Button> : null}
        </div>
      </div>

      {problems.length ? (
        <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 dark:border-rose-500/40 dark:bg-rose-500/10">
          <ul className="space-y-0.5 text-[12px] text-rose-800 dark:text-rose-200">
            {problems.slice(0, 4).map((p, i) => (
              <li key={i}>{p.step ? <span className="font-medium">{p.step}: </span> : null}{p.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[216px_minmax(0,1fr)_340px]">
        {/* ── palette ── */}
        <Palette readOnly={!canEdit} onAdd={(p) => addPreset(p)} />

        {/* ── stages + canvas ── */}
        <div className="min-w-0 space-y-2">
          <StagesStrip
            graph={graph}
            depths={depths}
            stageCount={stageCount}
            readOnly={!canEdit}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRename={(i, name) =>
              setGraph((g) => {
                if (!g) return g
                const stages = [...(g.stages ?? [])]
                while (stages.length < stageCount) stages.push('')
                stages[i] = name
                return { ...g, stages }
              })}
          />
          <Card className="overflow-hidden">
            <CardBody className="p-0">
              <div
                ref={canvasRef}
                className="relative h-[600px] w-full"
                onDragOver={onDragOver}
                onDrop={onDrop}
              >
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={NODE_TYPES}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onEdgesDelete={onEdgesDelete}
                  onNodesDelete={onNodesDelete}
                  onNodeClick={(_, n) => setSelectedId(n.id)}
                  onPaneClick={() => setSelectedId(null)}
                  onNodeDragStop={(_, n) => patchStep(n.id, { x: n.position.x, y: n.position.y })}
                  nodesDraggable={canEdit}
                  nodesConnectable={canEdit}
                  elementsSelectable
                  fitView
                  fitViewOptions={{ padding: 0.2 }}
                  defaultEdgeOptions={{ type: 'smoothstep', style: { strokeWidth: 1.75 } }}
                  colorMode={isDark ? 'dark' : 'light'}
                  proOptions={{ hideAttribution: false }}
                  deleteKeyCode={canEdit ? ['Backspace', 'Delete'] : null}
                >
                  <Background gap={16} size={1} />
                  <Controls showInteractive={false} />
                  <MiniMap pannable zoomable />
                </ReactFlow>
                {graph.steps.length === 0 ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="rounded-xl border border-dashed border-edge-strong bg-surface-raised/90 px-5 py-4 text-center text-[12.5px] text-content-muted shadow-sm">
                      <div className="font-semibold text-content">Empty canvas</div>
                      Drag a step from the palette, or click one to add it.
                    </div>
                  </div>
                ) : null}
              </div>
            </CardBody>
          </Card>
        </div>

        {/* ── inspector ── */}
        <Inspector
          graph={graph}
          step={selected}
          schedule={schedule}
          readOnly={!canEdit}
          onGraph={setGraph}
          onSchedule={setSchedule}
          onStep={(patch) => selected && patchStep(selected.id, patch)}
          onApplyPreset={(p) => selected && patchStep(selected.id, { image: p.image, command: p.command, env: p.env ? { ...p.env } : undefined, label: selected.label === selected.id ? p.title : selected.label })}
          onRename={(next) => {
            if (!selected) return
            const id = uniqueStepName(next, graph.steps.filter((s) => s.id !== selected.id).map((s) => s.id))
            setGraph((g) =>
              g
                ? {
                  ...g,
                  steps: g.steps.map((s) =>
                    s.id === selected.id
                      ? { ...s, id }
                      // Dependencies point at names; rename them too or the
                      // graph silently loses an edge.
                      : { ...s, dependsOn: s.dependsOn.map((d) => d === selected.id ? id : d) }
                  ),
                }
                : g
            )
            setSelectedId(id)
          }}
          onRemove={() => {
            if (!selected) return
            onNodesDelete([{ id: selected.id } as Node])
          }}
        />
      </div>
    </div>
  )
}

/* ─────────────────────────── palette ─────────────────────────── */

function Palette({ readOnly, onAdd }: { readOnly: boolean; onAdd(p: StepPreset): void }) {
  return (
    <Card className="xl:max-h-[calc(600px+2.75rem)] xl:overflow-y-auto">
      <CardBody className="space-y-1.5 p-2">
        <div className="px-1 pb-1 pt-0.5">
          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-content-subtle">Steps</div>
          <div className="text-[10.5px] text-content-subtle">{readOnly ? 'Read-only' : 'Drag onto the canvas, or click to add'}</div>
        </div>
        {STEP_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            draggable={!readOnly}
            disabled={readOnly}
            onDragStart={(e) => {
              e.dataTransfer.setData(DROP_MIME, p.id)
              e.dataTransfer.effectAllowed = 'copy'
            }}
            onClick={() => onAdd(p)}
            title={`${p.blurb}\n${p.image}`}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors',
              readOnly ? 'opacity-60' : 'cursor-grab hover:border-edge-default hover:bg-surface-sunken active:cursor-grabbing',
            )}
          >
            <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-bold', GLYPH_TONE[p.tone])}>{p.glyph}</span>
            <span className="min-w-0">
              <span className="block truncate text-[12px] font-medium text-content">{p.title}</span>
              <span className="block truncate text-[10px] text-content-subtle">{p.blurb}</span>
            </span>
          </button>
        ))}
      </CardBody>
    </Card>
  )
}

/* ─────────────────────────── stages ─────────────────────────── */

/**
 * The pipeline read as stages: one column per dependency depth, with the
 * steps in it. Names are labels on derived columns — renaming one changes
 * nothing about the DAG, and a step moved to another column by adding a
 * dependency simply appears under the other name.
 */
function StagesStrip({
  graph,
  depths,
  stageCount,
  readOnly,
  selectedId,
  onSelect,
  onRename,
}: {
  graph: WorkflowGraph
  depths: Map<string, number>
  stageCount: number
  readOnly: boolean
  selectedId: string | null
  onSelect(id: string): void
  onRename(index: number, name: string): void
}) {
  if (!stageCount) return null
  const cols = Array.from({ length: stageCount }, (_, i) => graph.steps.filter((s) => (depths.get(s.id) ?? 0) === i))
  return (
    <div className="flex items-stretch gap-1 overflow-x-auto rounded-xl border border-edge-default bg-surface-raised px-2 py-2 shadow-sm">
      {cols.map((steps, i) => (
        <div key={i} className="flex min-w-[168px] flex-1 items-stretch gap-1">
          <div className="min-w-0 flex-1 rounded-lg bg-surface-sunken/60 px-2.5 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-brand-600 font-mono text-[9px] font-bold text-white">{i + 1}</span>
              <input
                value={graph.stages?.[i] ?? ''}
                placeholder={`Stage ${i + 1}`}
                readOnly={readOnly}
                onChange={(e) => onRename(i, e.target.value)}
                aria-label={`Name of stage ${i + 1}`}
                className="min-w-0 flex-1 bg-transparent text-[11.5px] font-semibold text-content placeholder:text-content-subtle focus:outline-none"
              />
              <span className="shrink-0 font-mono text-[10px] text-content-subtle">{steps.length}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {steps.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onSelect(s.id)}
                  className={cn(
                    'max-w-full truncate rounded px-1.5 py-0.5 text-[10.5px] transition-colors',
                    s.id === selectedId ? 'bg-brand-600 text-white' : 'bg-surface-raised text-content-muted ring-1 ring-inset ring-edge-subtle hover:text-content',
                  )}
                >
                  {s.label || s.id}
                </button>
              ))}
            </div>
          </div>
          {i < stageCount - 1 ? <span className="flex items-center text-content-subtle" aria-hidden>›</span> : null}
        </div>
      ))}
    </div>
  )
}

/* ─────────────────────────── starters ─────────────────────────── */

function StarterPicker({
  namespace,
  onPick,
  onClose,
}: {
  namespace: string
  onPick(g: WorkflowGraph): void
  onClose?(): void
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[15px] font-semibold text-content">New workflow</div>
          <p className="mt-0.5 max-w-2xl text-[12.5px] text-content-muted">
            Start from a shape that fits, or from nothing. Every starter is an ordinary Argo DAG you can change on the canvas, run once, or put on a schedule.
          </p>
        </div>
        {onClose ? <Button variant="ghost" size="sm" onClick={onClose}>Close</Button> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <button
          type="button"
          onClick={() => onPick({ name: 'new-workflow', namespace, params: [], steps: [], serviceAccountName: 'argo-workflow' })}
          className="flex min-h-36 flex-col items-start justify-between rounded-xl border-2 border-dashed border-edge-strong bg-surface-raised p-4 text-left transition-colors hover:border-brand-400"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-[18px] font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">+</span>
          <span>
            <span className="block text-[13px] font-semibold text-content">Blank canvas</span>
            <span className="mt-0.5 block text-[11.5px] text-content-muted">Drag steps in and wire them yourself.</span>
          </span>
        </button>
        {STARTERS.map((st) => (
          <button
            key={st.id}
            type="button"
            onClick={() => onPick(st.build(namespace))}
            className="flex min-h-36 flex-col rounded-xl border border-edge-default bg-surface-raised p-4 text-left shadow-sm transition-[border-color,box-shadow] hover:border-brand-300 hover:shadow-md"
          >
            <span className="text-[13px] font-semibold text-content">{st.title}</span>
            <span className="mt-1 text-[11.5px] leading-relaxed text-content-muted">{st.blurb}</span>
            <span className="mt-auto pt-3 text-[10.5px] text-content-subtle">Needs: {st.requires}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/* ─────────────────────────── inspector ─────────────────────────── */

function Inspector({
  graph,
  step,
  schedule,
  readOnly,
  onGraph,
  onSchedule,
  onStep,
  onApplyPreset,
  onRename,
  onRemove,
}: {
  graph: WorkflowGraph
  step: StepNode | null
  schedule: Schedule
  readOnly: boolean
  onGraph(update: (g: WorkflowGraph | null) => WorkflowGraph | null): void
  onSchedule(next: Schedule): void
  onStep(patch: Partial<StepNode>): void
  onApplyPreset(p: StepPreset): void
  onRename(next: string): void
  onRemove(): void
}) {
  const [nameDraft, setNameDraft] = useState(step?.id ?? '')
  useEffect(() => setNameDraft(step?.id ?? ''), [step?.id])

  return (
    <Card className="xl:max-h-[calc(600px+2.75rem)] xl:overflow-y-auto">
      <CardBody className="space-y-3">
        {!step
          ? (
            <>
              <div className="text-[12px] font-semibold text-content">Workflow</div>
              <Field label="Name">
                <Input
                  value={graph.name}
                  disabled={readOnly}
                  onChange={(e) => onGraph((g) => g ? { ...g, name: normaliseStepName(e.target.value) } : g)}
                />
              </Field>
              <Field label="Service account" hint="Blank uses the namespace default.">
                <Input
                  value={graph.serviceAccountName ?? ''}
                  disabled={readOnly}
                  onChange={(e) => onGraph((g) => g ? { ...g, serviceAccountName: e.target.value || undefined } : g)}
                />
              </Field>
              <TriggerEditor schedule={schedule} readOnly={readOnly} onChange={onSchedule} />
              <Params graph={graph} readOnly={readOnly} onGraph={onGraph} />
              <div className="rounded-lg border border-edge-default bg-surface-sunken px-3 py-2 text-[11px] text-content-muted">
                Click a step to edit it. Drag from the dot on a step's right edge to the dot on another's left edge to make the second wait for the first.
              </div>
            </>
          )
          : (
            <>
              <div className="flex items-center gap-2">
                <div className="text-[12px] font-semibold text-content">Step</div>
                <Badge>{step.dependsOn.length ? `after ${step.dependsOn.join(', ')}` : 'starts first'}</Badge>
                {!readOnly ? (
                  <button type="button" onClick={onRemove} className="ml-auto text-[11px] text-rose-600 hover:underline dark:text-rose-300">
                    Remove
                  </button>
                ) : null}
              </div>
              <Field label="Name" hint="Also the Argo task name.">
                <Input
                  value={nameDraft}
                  disabled={readOnly}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => nameDraft !== step.id && onRename(nameDraft)}
                />
              </Field>
              <Field label="Label" hint="Shown on the canvas.">
                <Input value={step.label} disabled={readOnly} onChange={(e) => onStep({ label: e.target.value })} />
              </Field>
              {!readOnly ? (
                <Field label="Start from a preset" hint="Replaces image, command and environment.">
                  <Select
                    value=""
                    onChange={(e) => {
                      const p = presetById(e.currentTarget.value)
                      if (p) onApplyPreset(p)
                    }}
                    options={[{ value: '', label: 'Choose…' }, ...STEP_PRESETS.map((p) => ({ value: p.id, label: p.title }))]}
                  />
                </Field>
              ) : null}
              <Field label="Image">
                <Input
                  value={step.image}
                  disabled={readOnly}
                  placeholder="alpine:3.20"
                  onChange={(e) => onStep({ image: e.target.value })}
                />
              </Field>
              <Field label="Command" hint="Run with sh -c, so pipes and && work.">
                <Textarea
                  rows={4}
                  value={step.command}
                  disabled={readOnly}
                  onChange={(e) => onStep({ command: e.target.value })}
                />
              </Field>
              <Field label="Condition" hint="Optional. The step runs only when this is true.">
                <Input
                  value={step.when ?? ''}
                  disabled={readOnly}
                  placeholder="{{workflow.parameters.tag}} != &quot;&quot;"
                  onChange={(e) => onStep({ when: e.target.value || undefined })}
                />
              </Field>
              <KeyValues
                label="Environment"
                value={step.env ?? {}}
                readOnly={readOnly}
                onChange={(env) => onStep({ env: Object.keys(env).length ? env : undefined })}
              />
            </>
          )}
      </CardBody>
    </Card>
  )
}

/* ─────────────────────────── trigger ─────────────────────────── */

const TIMEZONES = ['UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Sao_Paulo']

/**
 * When the workflow runs. Three answers, each stated in words next to the
 * setting so a cron expression is never the only thing on screen.
 */
function TriggerEditor({ schedule, readOnly, onChange }: { schedule: Schedule; readOnly: boolean; onChange(next: Schedule): void }) {
  const localTz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC'
  const modes: Array<{ id: ScheduleMode; label: string; blurb: string }> = [
    { id: 'now', label: 'Run now', blurb: 'Submit immediately as a Workflow.' },
    { id: 'once', label: 'Once, later', blurb: 'At a date and time, then never again.' },
    { id: 'cron', label: 'Recurring', blurb: 'On a schedule, as a CronWorkflow.' },
  ]
  const cronValid = !schedule.cron || CRON_RE.test(schedule.cron.trim())
  const minLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
  return (
    <div className="rounded-lg border border-edge-default p-2.5">
      <div className="text-[12px] font-semibold text-content">When it runs</div>
      <div className="mt-2 grid grid-cols-3 gap-1">
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            disabled={readOnly}
            onClick={() => onChange({ ...schedule, mode: m.id, ...(m.id === 'cron' && !schedule.cron ? { cron: '0 2 * * *' } : {}) })}
            aria-pressed={schedule.mode === m.id}
            title={m.blurb}
            className={cn(
              'rounded-md border px-2 py-1.5 text-[11.5px] font-medium transition-colors',
              schedule.mode === m.id ? 'border-brand-400 bg-brand-50 text-brand-800 dark:bg-brand-500/10 dark:text-brand-200' : 'border-edge-default text-content-muted hover:text-content',
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      {schedule.mode === 'once' ? (
        <div className="mt-2.5 space-y-2">
          <Field label="Date and time" hint={`In ${schedule.timezone || localTz}.`}>
            <Input
              type="datetime-local"
              value={schedule.at ?? ''}
              min={minLocal}
              disabled={readOnly}
              onChange={(e) => onChange({ ...schedule, at: e.target.value })}
            />
          </Field>
          <Field label="Time zone">
            <Input list="wf-timezones" value={schedule.timezone ?? ''} placeholder={localTz} disabled={readOnly} onChange={(e) => onChange({ ...schedule, timezone: e.target.value || undefined })} />
          </Field>
          <p className="text-[11px] leading-relaxed text-content-muted">
            Created as a CronWorkflow for that minute with a stop strategy, so it fires once and then ends (Argo Workflows 3.6 or newer).
          </p>
        </div>
      ) : null}

      {schedule.mode === 'cron' ? (
        <div className="mt-2.5 space-y-2">
          <Field label="Preset">
            <Select
              value={CRON_PRESETS.find((p) => p.cron === schedule.cron)?.cron ?? ''}
              disabled={readOnly}
              onChange={(e) => e.currentTarget.value && onChange({ ...schedule, cron: e.currentTarget.value })}
              options={[{ value: '', label: 'Custom…' }, ...CRON_PRESETS.map((p) => ({ value: p.cron, label: p.label }))]}
            />
          </Field>
          <Field label="Cron expression" hint="minute · hour · day of month · month · day of week">
            <Input
              value={schedule.cron ?? ''}
              disabled={readOnly}
              placeholder="0 2 * * *"
              onChange={(e) => onChange({ ...schedule, cron: e.target.value })}
              className={cn('font-mono', !cronValid && 'border-rose-400')}
            />
          </Field>
          <div className={cn('rounded-md px-2.5 py-1.5 text-[11.5px]', cronValid ? 'bg-surface-sunken text-content' : 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300')}>
            {cronValid ? (schedule.cron ? describeCron(schedule.cron.trim(), schedule.timezone) : 'Pick a preset or type an expression.') : 'Five space-separated fields are needed.'}
          </div>
          <Field label="Time zone" hint="Blank uses the controller's zone (usually UTC).">
            <Input list="wf-timezones" value={schedule.timezone ?? ''} placeholder="UTC" disabled={readOnly} onChange={(e) => onChange({ ...schedule, timezone: e.target.value || undefined })} />
          </Field>
          <Field label="If the previous run is still going">
            <Select
              value={schedule.concurrencyPolicy ?? 'Forbid'}
              disabled={readOnly}
              onChange={(e) => onChange({ ...schedule, concurrencyPolicy: e.currentTarget.value as Schedule['concurrencyPolicy'] })}
              options={[
                { value: 'Forbid', label: 'Skip this run (Forbid)' },
                { value: 'Allow', label: 'Run alongside it (Allow)' },
                { value: 'Replace', label: 'Stop it and start fresh (Replace)' },
              ]}
            />
          </Field>
        </div>
      ) : null}

      {schedule.mode !== 'now' ? (
        <label className="mt-2 flex items-center gap-2 text-[11.5px] text-content-muted">
          <input type="checkbox" checked={Boolean(schedule.suspend)} disabled={readOnly} onChange={(e) => onChange({ ...schedule, suspend: e.target.checked || undefined })} className="accent-brand-600" />
          Create it paused — resume from the Cron tab when ready
        </label>
      ) : null}
      <datalist id="wf-timezones">
        {TIMEZONES.map((tz) => <option key={tz} value={tz} />)}
      </datalist>
    </div>
  )
}

/* ─────────────────────────── params / env ─────────────────────────── */

function Params({
  graph,
  readOnly,
  onGraph,
}: {
  graph: WorkflowGraph
  readOnly: boolean
  onGraph(update: (g: WorkflowGraph | null) => WorkflowGraph | null): void
}) {
  return (
    <div className="rounded-lg border border-edge-default p-2.5">
      <div className="text-[12px] font-semibold text-content">Parameters</div>
      <p className="mt-0.5 text-[11px] text-content-muted">
        Available to every step as <code className="text-[10px]">{'{{workflow.parameters.name}}'}</code>.
      </p>
      <div className="mt-2 space-y-1.5">
        {graph.params.map((p, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              className="flex-1"
              value={p.name}
              disabled={readOnly}
              placeholder="name"
              onChange={(e) =>
                onGraph((g) =>
                  g ? { ...g, params: g.params.map((x, j) => j === i ? { ...x, name: e.target.value } : x) } : g
                )}
            />
            <Input
              className="flex-1"
              value={p.value}
              disabled={readOnly}
              placeholder="value"
              onChange={(e) =>
                onGraph((g) =>
                  g ? { ...g, params: g.params.map((x, j) => j === i ? { ...x, value: e.target.value } : x) } : g
                )}
            />
            {!readOnly
              ? (
                <button
                  type="button"
                  aria-label="Remove parameter"
                  onClick={() => onGraph((g) => g ? { ...g, params: g.params.filter((_, j) => j !== i) } : g)}
                  className="rounded px-1.5 text-content-subtle hover:text-content"
                >
                  ✕
                </button>
              )
              : null}
          </div>
        ))}
        {!readOnly
          ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onGraph((g) => g ? { ...g, params: [...g.params, { name: '', value: '' }] } : g)}
            >
              Add parameter
            </Button>
          )
          : null}
      </div>
    </div>
  )
}

function KeyValues({
  label,
  value,
  readOnly,
  onChange,
}: {
  label: string
  value: Record<string, string>
  readOnly: boolean
  onChange(v: Record<string, string>): void
}) {
  const entries = Object.entries(value)
  return (
    <div className="rounded-lg border border-edge-default p-2.5">
      <div className="text-[12px] font-semibold text-content">{label}</div>
      <div className="mt-2 space-y-1.5">
        {entries.map(([k, v]) => (
          <div key={k} className="flex items-center gap-1.5">
            <Input
              className="flex-1"
              value={k}
              disabled={readOnly}
              onChange={(e) => {
                const out: Record<string, string> = {}
                for (const [ek, ev] of entries) out[ek === k ? e.target.value : ek] = ev
                onChange(out)
              }}
            />
            <Input
              className="flex-1"
              value={v}
              disabled={readOnly}
              onChange={(e) => onChange({ ...value, [k]: e.target.value })}
            />
            {!readOnly
              ? (
                <button
                  type="button"
                  aria-label={`Remove ${k}`}
                  onClick={() => {
                    const { [k]: _drop, ...rest } = value
                    onChange(rest)
                  }}
                  className="rounded px-1.5 text-content-subtle hover:text-content"
                >
                  ✕
                </button>
              )
              : null}
          </div>
        ))}
        {!readOnly
          ? <Button variant="ghost" size="xs" onClick={() => onChange({ ...value, [`VAR_${entries.length + 1}`]: '' })}>Add</Button>
          : null}
      </div>
    </div>
  )
}
