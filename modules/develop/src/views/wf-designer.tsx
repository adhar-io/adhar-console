import { useCallback, useEffect, useMemo, useState } from 'react'
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
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Select,
  Textarea,
  useCan,
  useToast,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import {
  findCycle,
  layoutGraph,
  normaliseStepName,
  type StepNode,
  toArgoSpec,
  uniqueStepName,
  validateGraph,
  type WorkflowGraph,
} from '../data/wf-model.ts'
import { STARTERS, starterById } from '../data/wf-starters.ts'
import { submitWorkflow, upsertWorkflowTemplate } from '../data/workflows.ts'

/**
 * The workflow designer.
 *
 * A canvas of steps and the edges between them, which is exactly an Argo DAG:
 * a node is a task with a container, an edge is a dependency. Drawing it is
 * worth doing because real pipelines branch — build and test both follow
 * checkout and rejoin at publish — and that shape is invisible in YAML until
 * you have read all of it.
 *
 * The graph is the single source of truth and the spec is generated from it
 * on every save. Nothing about the canvas is stored except node positions,
 * which ride in an annotation Argo ignores, so a workflow edited by hand in
 * git still opens here.
 */

type StepData = {
  step: StepNode
  selected: boolean
  problem: boolean
}

/** One step on the canvas. */
function StepNodeView({ data }: NodeProps<Node<StepData>>) {
  const { step, problem } = data
  return (
    <div
      className={cn(
        'w-[210px] rounded-lg border-2 bg-surface-raised px-3 py-2 shadow-sm transition-colors',
        problem ? 'border-rose-400' : 'border-edge-default',
      )}
    >
      {/* Top handle takes incoming dependencies, bottom creates them. */}
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-brand-500" />
      <div className="truncate text-[12.5px] font-semibold text-content">{step.label || step.id}</div>
      <div className="truncate font-mono text-[10px] text-content-subtle">{step.image || 'no image'}</div>
      <div className="mt-1 truncate font-mono text-[10px] text-content-muted">{step.command || 'no command'}</div>
      {step.when ? <div className="mt-1 truncate text-[10px] text-amber-700 dark:text-amber-400">when {step.when}</div> : null}
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !bg-brand-500" />
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
  const [dark, setDark] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  )
  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    const sync = () => setDark(root.classList.contains('dark'))
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

export function WorkflowDesigner({ namespace, onClose }: { namespace: string; onClose?(): void }) {
  return (
    <ReactFlowProvider>
      <Designer namespace={namespace} onClose={onClose} />
    </ReactFlowProvider>
  )
}

function Designer({ namespace, onClose }: { namespace: string; onClose?(): void }) {
  const toast = useToast()
  const canEdit = useCan('develop')
  const isDark = useIsDark()
  const [graph, setGraph] = useState<WorkflowGraph | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<StepData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const problems = useMemo(() => (graph ? validateGraph(graph) : []), [graph])
  const problemSteps = useMemo(() => new Set(problems.map((p) => p.step).filter(Boolean) as string[]), [problems])

  /* Graph → canvas. The canvas is a projection; the graph is the truth. */
  useEffect(() => {
    if (!graph) return
    setNodes(graph.steps.map((s) => ({
      id: s.id,
      type: 'step',
      position: { x: s.x, y: s.y },
      data: { step: s, selected: s.id === selectedId, problem: problemSteps.has(s.id) },
    })))
    setEdges(graph.steps.flatMap((s) =>
      s.dependsOn.map((d) => ({ id: `${d}->${s.id}`, source: d, target: s.id, animated: false }))
    ))
  }, [graph, selectedId, problemSteps, setNodes, setEdges])

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

  const addStep = () => {
    setGraph((g) => {
      if (!g) return g
      const id = uniqueStepName('step', g.steps.map((s) => s.id))
      const maxY = g.steps.reduce((m, s) => Math.max(m, s.y), 0)
      const next: StepNode = { id, label: id, image: 'alpine:3.20', command: 'echo hello', dependsOn: [], x: 400, y: maxY + 130 }
      setSelectedId(id)
      return { ...g, steps: [...g.steps, next] }
    })
  }

  const selected = graph?.steps.find((s) => s.id === selectedId) ?? null

  if (!graph) return <StarterPicker namespace={namespace} onPick={setGraph} onClose={onClose} />

  const save = async (kind: 'Workflow' | 'WorkflowTemplate') => {
    if (problems.length) {
      toast.error('Fix the problems first', { description: problems[0].message })
      return
    }
    setBusy(true)
    try {
      const spec = toArgoSpec(graph, { kind, generateName: kind === 'Workflow' })
      const created = kind === 'Workflow' ? await submitWorkflow(spec) : await upsertWorkflowTemplate(spec)
      toast.success(kind === 'Workflow' ? `Submitted ${created.metadata.name}` : `Saved template ${created.metadata.name}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-content">{graph.name}</div>
              <div className="text-[11px] text-content-subtle">
                {graph.namespace} · {graph.steps.length} step{graph.steps.length === 1 ? '' : 's'}
                {problems.length ? ` · ${problems.length} problem${problems.length === 1 ? '' : 's'}` : ''}
              </div>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              {canEdit ? <Button variant="ghost" size="sm" onClick={addStep}>Add step</Button> : null}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setGraph((g) => g ? { ...g, steps: layoutGraph(g.steps) } : g)}
              >
                Tidy
              </Button>
              {canEdit
                ? (
                  <>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => save('WorkflowTemplate')}>
                      Save as template
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => save('Workflow')}>
                      {busy ? 'Submitting…' : 'Run'}
                    </Button>
                  </>
                )
                : null}
              {onClose ? <Button variant="ghost" size="sm" onClick={onClose}>Close</Button> : null}
            </div>
          </div>
        </CardHeader>
      </Card>

      {problems.length
        ? (
          <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 dark:border-rose-500/40 dark:bg-rose-500/10">
            <ul className="space-y-0.5 text-[12px] text-rose-800 dark:text-rose-200">
              {problems.slice(0, 4).map((p, i) => (
                <li key={i}>{p.step ? <span className="font-medium">{p.step}: </span> : null}{p.message}</li>
              ))}
            </ul>
          </div>
        )
        : null}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_330px]">
        <Card className="overflow-hidden">
          <CardBody className="p-0">
            <div className="h-[560px] w-full">
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
                onNodeDragStop={(_, n) => patchStep(n.id, { x: n.position.x, y: n.position.y })}
                nodesDraggable={canEdit}
                nodesConnectable={canEdit}
                elementsSelectable
                fitView
                colorMode={isDark ? 'dark' : 'light'}
                proOptions={{ hideAttribution: false }}
              >
                <Background />
                <Controls showInteractive={false} />
                <MiniMap pannable zoomable />
              </ReactFlow>
            </div>
          </CardBody>
        </Card>

        <Inspector
          graph={graph}
          step={selected}
          readOnly={!canEdit}
          onGraph={setGraph}
          onStep={(patch) => selected && patchStep(selected.id, patch)}
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
        />
      </div>
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
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <div>
            <div className="text-sm font-semibold text-content">Start a workflow</div>
            <div className="text-[12px] text-content-muted">
              Each of these is wired to the tools this platform actually runs, and branches the way a real
              pipeline does. Edit anything after you pick.
            </div>
          </div>
          {onClose ? <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose}>Close</Button> : null}
        </div>
      </CardHeader>
      <CardBody className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {STARTERS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onPick(starterById(s.id)!.build(namespace))}
            className="rounded-lg border border-edge-default px-3 py-2.5 text-left transition-colors hover:border-brand-400 hover:bg-surface-sunken"
          >
            <div className="text-[13px] font-semibold text-content">{s.title}</div>
            <div className="mt-0.5 text-[11.5px] leading-snug text-content-muted">{s.blurb}</div>
            <div className="mt-1 text-[11px] text-content-subtle">
              <span className="font-medium">Needs:</span> {s.requires}
            </div>
          </button>
        ))}
      </CardBody>
    </Card>
  )
}

/* ─────────────────────────── inspector ─────────────────────────── */

function Inspector({
  graph,
  step,
  readOnly,
  onGraph,
  onStep,
  onRename,
}: {
  graph: WorkflowGraph
  step: StepNode | null
  readOnly: boolean
  onGraph(update: (g: WorkflowGraph | null) => WorkflowGraph | null): void
  onStep(patch: Partial<StepNode>): void
  onRename(next: string): void
}) {
  const [nameDraft, setNameDraft] = useState(step?.id ?? '')
  useEffect(() => setNameDraft(step?.id ?? ''), [step?.id])

  return (
    <Card className="max-h-[560px] overflow-y-auto">
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
              <Params graph={graph} readOnly={readOnly} onGraph={onGraph} />
              <div className="rounded-lg border border-edge-default bg-surface-sunken px-3 py-2 text-[11px] text-content-muted">
                Click a step to edit it. Drag from the dot under a step to the dot above another to make it wait
                for the first.
              </div>
            </>
          )
          : (
            <>
              <div className="flex items-center gap-2">
                <div className="text-[12px] font-semibold text-content">Step</div>
                <Badge>{step.dependsOn.length ? `after ${step.dependsOn.join(', ')}` : 'starts immediately'}</Badge>
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
              onChange={(e) =>
                onGraph((g) =>
                  g ? { ...g, params: g.params.map((x, j) => j === i ? { ...x, name: e.target.value } : x) } : g
                )}
            />
            <Input
              className="flex-1"
              value={p.value}
              disabled={readOnly}
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
