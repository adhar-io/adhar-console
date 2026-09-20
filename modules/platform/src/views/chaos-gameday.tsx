import { useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  StatusBadge,
  useCan,
  useToast,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { cn, formatRelative } from '@adhar-console/utils'
import {
  buildGameDay,
  CATEGORY_BLURB,
  CATEGORY_LABEL,
  type ChaosTarget,
  formatSeconds,
  type Scenario,
  type ScenarioCategory,
  SCENARIOS,
  scenarioById,
  totalSeconds,
} from '../data/chaos-scenarios.ts'
import {
  type ChaosWorkflow,
  type ChaosWorkflowNode,
  createGameDay,
  deleteGameDay,
  useChaosWorkflow,
  useChaosWorkflowNodes,
  useChaosWorkflows,
  useTargetNamespaces,
} from '../data/chaos.ts'

/**
 * Game days — a whole sequence of experiments as one automated run.
 *
 * A single fault answers a single question. The failures that actually take
 * production down are the ones nobody rehearses, so the catalogue is the
 * product here: pick the scenarios, point them at a workload, and Chaos Mesh
 * runs them in order with recovery time between each and a probe watching the
 * system throughout.
 *
 * Serial with pauses is the default because simultaneous faults tell you the
 * system broke without telling you which one broke it.
 */
export function ChaosGameDays({ namespace }: { namespace?: string }) {
  const workflows = useChaosWorkflows(namespace)
  const [building, setBuilding] = useState(false)
  const [open, setOpen] = useState<{ namespace: string; name: string } | null>(null)
  const canManage = useCan('platform.manage')

  const list = workflows.data ?? []

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <div>
              <div className="text-sm font-semibold text-content">Game days</div>
              <div className="text-[12px] text-content-muted">
                A sequence of experiments, run automatically with recovery time between each and a steady-state
                probe that aborts the run if the system stops serving.
              </div>
            </div>
            {canManage ? <Button className="ml-auto" onClick={() => setBuilding(true)}>New game day</Button> : null}
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {workflows.isLoading
            ? <div className="flex justify-center py-8"><Spinner /></div>
            : list.length === 0
            ? (
              <div className="p-6">
                <EmptyState
                  compact
                  title="No game days yet"
                  description="Start with availability and network — one replica failing, then the network getting slow. Those two cover most of what actually happens."
                />
              </div>
            )
            : (
              <ul className="divide-y divide-edge-subtle">
                {list.map((w) => <GameDayRow key={`${w.metadata.namespace}/${w.metadata.name}`} wf={w} onOpen={setOpen} />)}
              </ul>
            )}
        </CardBody>
      </Card>

      {open ? <GameDayDrawer namespace={open.namespace} name={open.name} onClose={() => setOpen(null)} /> : null}
      {building ? <GameDayBuilder onClose={() => setBuilding(false)} onCreated={setOpen} /> : null}
    </div>
  )
}

/* ─────────────────────────── status ─────────────────────────── */

/**
 * A workflow's state, read from its conditions.
 *
 * Chaos Mesh reports `Accomplished` when every branch finished, and
 * `WorkflowAborted` when a steady-state check stopped it. Aborted is NOT a
 * failure of the tool — it means the system stopped meeting its steady state,
 * which is the experiment producing its most important answer.
 */
export function workflowPhase(wf: ChaosWorkflow): 'running' | 'accomplished' | 'aborted' | 'pending' {
  const on = (type: string) => wf.status?.conditions?.find((c) => c.type === type)?.status === 'True'
  if (on('WorkflowAborted')) return 'aborted'
  if (on('WorkflowAccomplished')) return 'accomplished'
  if (wf.status?.startTime) return 'running'
  return 'pending'
}

const PHASE_KIND: Record<ReturnType<typeof workflowPhase>, StatusKind> = {
  running: 'progressing',
  accomplished: 'healthy',
  aborted: 'failed',
  pending: 'unknown',
}

const PHASE_LABEL: Record<ReturnType<typeof workflowPhase>, string> = {
  running: 'running',
  accomplished: 'completed',
  aborted: 'aborted — steady state lost',
  pending: 'pending',
}

function GameDayRow({ wf, onOpen }: { wf: ChaosWorkflow; onOpen(o: { namespace: string; name: string }): void }) {
  const phase = workflowPhase(wf)
  const steps = (wf.spec?.templates ?? []).filter((t) =>
    typeof t.templateType === 'string' && !['Serial', 'Parallel', 'Suspend', 'StatusCheck'].includes(t.templateType)
  ).length

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen({ namespace: wf.metadata.namespace ?? '', name: wf.metadata.name })}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-sunken"
      >
        <StatusBadge kind={PHASE_KIND[phase]} pulse={phase === 'running'}>{PHASE_LABEL[phase]}</StatusBadge>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-content">{wf.metadata.name}</div>
          <div className="truncate text-[11px] text-content-subtle">
            {wf.metadata.namespace} · {steps} scenario{steps === 1 ? '' : 's'}
            {wf.metadata.creationTimestamp ? ` · ${formatRelative(wf.metadata.creationTimestamp)}` : ''}
          </div>
        </div>
      </button>
    </li>
  )
}

/* ─────────────────────────── builder ─────────────────────────── */

const MODES: ChaosTarget['mode'][] = ['one', 'fixed', 'fixed-percent', 'random-max-percent', 'all']

function GameDayBuilder({
  onClose,
  onCreated,
}: {
  onClose(): void
  onCreated(o: { namespace: string; name: string }): void
}) {
  const toast = useToast()
  const namespaces = useTargetNamespaces()
  const [name, setName] = useState('')
  const [namespace, setNamespace] = useState('')
  const [selector, setSelector] = useState('')
  const [mode, setMode] = useState<ChaosTarget['mode']>('one')
  const [value, setValue] = useState('1')
  const [picked, setPicked] = useState<string[]>(['pod-failure-one'])
  const [strategy, setStrategy] = useState<'serial' | 'parallel'>('serial')
  const [recovery, setRecovery] = useState(30)
  const [probeUrl, setProbeUrl] = useState('')
  const [busy, setBusy] = useState(false)

  const chosen = picked.map(scenarioById).filter((s): s is Scenario => Boolean(s))
  const duration = totalSeconds(chosen, { strategy, recoverySeconds: recovery })
  const highBlast = chosen.filter((s) => s.blast === 'high')
  const ready = name.trim() && namespace && picked.length > 0

  const byCategory = useMemo(() => {
    const out = new Map<ScenarioCategory, Scenario[]>()
    for (const s of SCENARIOS) {
      const list = out.get(s.category)
      if (list) list.push(s)
      else out.set(s.category, [s])
    }
    return [...out.entries()]
  }, [])

  const toggle = (id: string) => setPicked((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id])

  const launch = async () => {
    setBusy(true)
    try {
      const manifest = buildGameDay({
        name: name.trim(),
        namespace,
        target: { namespace, selector, mode, value: mode === 'one' || mode === 'all' ? undefined : value },
        scenarios: picked,
        strategy,
        recoverySeconds: recovery,
        ...(probeUrl.trim()
          ? { steadyState: { url: probeUrl.trim(), statusCode: '200', intervalSeconds: 5, failureThreshold: 3 } }
          : {}),
      })
      const created = await createGameDay(manifest)
      toast.success(`${created.metadata.name} started`)
      onCreated({ namespace: created.metadata.namespace ?? namespace, name: created.metadata.name })
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/50" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-2xl">
        <div className="border-b border-edge-default px-5 py-3">
          <div className="text-sm font-semibold text-content">New game day</div>
          <div className="text-[11px] text-content-subtle">
            Chaos Mesh runs these as one workflow. Everything is bounded and reversible.
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 lg:grid-cols-[1fr_320px]">
          <div className="space-y-4">
            {byCategory.map(([category, list]) => (
              <div key={category}>
                <div className="flex items-baseline gap-2">
                  <div className="text-[12px] font-semibold text-content">{CATEGORY_LABEL[category]}</div>
                  <div className="text-[11px] text-content-muted">{CATEGORY_BLURB[category]}</div>
                </div>
                <div className="mt-1.5 space-y-1.5">
                  {list.map((s) => (
                    <ScenarioCard key={s.id} scenario={s} on={picked.includes(s.id)} onToggle={() => toggle(s.id)} />
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-3">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="friday-gameday" />
            </Field>
            <Field label="Namespace" hint="Both the workflow and its targets.">
              <Select
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
                options={[
                  { value: '', label: namespaces.isLoading ? 'Loading…' : 'Choose a namespace…' },
                  ...(namespaces.data ?? []).map((n) => ({ value: n, label: n })),
                ]}
              />
            </Field>
            <Field label="Label selector" hint="Narrows the blast radius. Empty targets every pod in the namespace.">
              <Input value={selector} onChange={(e) => setSelector(e.target.value)} placeholder="app=checkout" />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Mode">
                <Select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as ChaosTarget['mode'])}
                  options={MODES.map((m) => ({ value: m, label: m }))}
                />
              </Field>
              {mode !== 'one' && mode !== 'all'
                ? (
                  <Field label="Value">
                    <Input value={value} onChange={(e) => setValue(e.target.value)} />
                  </Field>
                )
                : <div />}
            </div>

            <Field label="Order" hint="Serial isolates cause; parallel is a worst-case storm.">
              <Select
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as 'serial' | 'parallel')}
                options={[
                  { value: 'serial', label: 'One at a time, with recovery' },
                  { value: 'parallel', label: 'All at once' },
                ]}
              />
            </Field>
            {strategy === 'serial'
              ? (
                <Field label="Recovery between scenarios" hint="Seconds of quiet, so recovery is observable.">
                  <Input
                    type="number"
                    min={0}
                    value={String(recovery)}
                    onChange={(e) => setRecovery(Math.max(0, Number(e.target.value) || 0))}
                  />
                </Field>
              )
              : null}

            <Field
              label="Steady-state probe"
              hint="Polled throughout. Three consecutive failures abort the run — this is what keeps an experiment from becoming an outage."
            >
              <Input
                value={probeUrl}
                onChange={(e) => setProbeUrl(e.target.value)}
                placeholder="http://checkout.payments.svc.cluster.local/health"
              />
            </Field>

            <div className="rounded-lg border border-edge-default bg-surface-sunken p-3 text-[12px]">
              <div className="font-medium text-content">
                {picked.length} scenario{picked.length === 1 ? '' : 's'} · about {formatSeconds(duration)}
              </div>
              {!probeUrl.trim()
                ? (
                  <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                    With no probe the run continues even if the system stops serving.
                  </div>
                )
                : null}
              {highBlast.length
                ? (
                  <div className="mt-1 text-[11px] text-rose-700 dark:text-rose-400">
                    {highBlast.length} high-blast scenario{highBlast.length === 1 ? '' : 's'}:{' '}
                    {highBlast.map((s) => s.title.toLowerCase()).join(', ')}.
                  </div>
                )
                : null}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-edge-default px-5 py-3">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={!ready || busy} onClick={launch}>
            {busy ? 'Starting…' : 'Start game day'}
          </Button>
        </div>
      </div>
    </div>
  )
}

const BLAST_TONE: Record<Scenario['blast'], string> = {
  low: 'text-emerald-700 dark:text-emerald-400',
  medium: 'text-amber-700 dark:text-amber-400',
  high: 'text-rose-700 dark:text-rose-400',
}

function ScenarioCard({ scenario, on, onToggle }: { scenario: Scenario; on: boolean; onToggle(): void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'block w-full rounded-lg border px-3 py-2 text-left transition-colors',
        on ? 'border-brand-400 bg-brand-50/60 dark:bg-brand-500/10' : 'border-edge-default hover:bg-surface-sunken',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('h-3.5 w-3.5 shrink-0 rounded border', on ? 'border-brand-500 bg-brand-600' : 'border-edge-strong')} />
        <span className="text-[12.5px] font-medium text-content">{scenario.title}</span>
        <span className={cn('ml-auto text-[10px] font-medium uppercase', BLAST_TONE[scenario.blast])}>
          {scenario.blast}
        </span>
        <span className="text-[10px] text-content-subtle">{scenario.duration}</span>
      </div>
      {/* The hypothesis is the experiment. Without it this is just breakage. */}
      <div className="mt-1 pl-5.5 text-[11px] text-content-muted">
        <span className="font-medium text-content-subtle">Expect:</span> {scenario.hypothesis}
      </div>
      <div className="pl-5.5 text-[11px] text-content-subtle">{scenario.rationale}</div>
    </button>
  )
}

/* ─────────────────────────── drawer ─────────────────────────── */

function GameDayDrawer({ namespace, name, onClose }: { namespace: string; name: string; onClose(): void }) {
  const wf = useChaosWorkflow(namespace, name)
  const nodes = useChaosWorkflowNodes(namespace, name)
  const toast = useToast()
  const canManage = useCan('platform.manage')

  const phase = wf.data ? workflowPhase(wf.data) : 'pending'
  const steps = useMemo(() => orderSteps(wf.data, nodes.data ?? []), [wf.data, nodes.data])

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/50" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-2xl flex-col border-l border-edge-default bg-surface-raised shadow-2xl">
        <div className="flex shrink-0 items-start gap-3 border-b border-edge-default px-5 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <StatusBadge kind={PHASE_KIND[phase]} pulse={phase === 'running'}>{PHASE_LABEL[phase]}</StatusBadge>
              <span className="truncate text-sm font-semibold text-content">{name}</span>
            </div>
            <div className="mt-0.5 text-[11px] text-content-subtle">
              {namespace}
              {wf.data?.status?.startTime ? ` · started ${formatRelative(wf.data.status.startTime)}` : ''}
            </div>
          </div>
          {canManage
            ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  try {
                    await deleteGameDay(namespace, name)
                    toast.success('Game day deleted')
                    onClose()
                  } catch (e) {
                    toast.error((e as Error).message)
                  }
                }}
              >
                Delete
              </Button>
            )
            : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md px-2 py-1 text-content-subtle hover:bg-surface-sunken hover:text-content"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {phase === 'aborted'
            ? (
              <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-[12px] text-rose-800 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200">
                The steady-state probe failed and Chaos Mesh stopped the run. That is the experiment's most
                valuable result: the system stopped serving under a fault it was expected to survive.
              </div>
            )
            : null}

          {wf.isLoading
            ? <div className="flex justify-center py-12"><Spinner /></div>
            : !steps.length
            ? <EmptyState compact title="No steps yet" description="Chaos Mesh creates a node per step as the workflow starts." />
            : <Timeline steps={steps} />}
        </div>
      </aside>
    </div>
  )
}

export interface Step {
  /** Template name, e.g. `2-net-latency`. */
  template: string
  templateType: string
  deadline?: string
  scenario?: Scenario
  phase: 'done' | 'running' | 'pending' | 'failed'
  startedAt?: string
}

/**
 * The declared steps, in declaration order, joined to whatever nodes exist.
 *
 * Driving the timeline off the SPEC rather than off the nodes matters: nodes
 * are created as the workflow reaches them, so a node-driven list would show
 * a game day as having only the steps it has already run, and the operator
 * could not see what is still coming.
 */
export function orderSteps(wf: ChaosWorkflow | undefined, nodes: ChaosWorkflowNode[]): Step[] {
  if (!wf?.spec?.templates) return []
  const structural = new Set(['Serial', 'Parallel'])
  const declared = wf.spec.templates.filter((t) =>
    typeof t.templateType === 'string' && !structural.has(t.templateType)
  )

  const nodeFor = (template: string) =>
    nodes.find((n) => n.spec?.name === template || n.metadata.name.startsWith(`${template}-`))

  return declared.map((t) => {
    const template = String(t.name ?? '')
    const node = nodeFor(template)
    const cond = (type: string) => node?.status?.conditions?.find((c) => c.type === type)?.status === 'True'
    const phase: Step['phase'] = !node
      ? 'pending'
      : cond('Accomplished')
      ? 'done'
      : cond('Aborted') || cond('Failed')
      ? 'failed'
      : 'running'
    // Template names are `<index>-<scenario id>`; recover the scenario for
    // its hypothesis, which is what makes the timeline readable.
    const scenarioId = template.replace(/^\d+-/, '')
    return {
      template,
      templateType: String(t.templateType ?? ''),
      deadline: typeof t.deadline === 'string' ? t.deadline : undefined,
      scenario: scenarioById(scenarioId),
      phase,
      startedAt: node?.metadata.creationTimestamp,
    }
  })
}

const STEP_KIND: Record<Step['phase'], StatusKind> = {
  done: 'healthy',
  running: 'progressing',
  pending: 'unknown',
  failed: 'failed',
}

function Timeline({ steps }: { steps: Step[] }) {
  return (
    <ol className="space-y-2">
      {steps.map((s) => {
        const isPause = s.templateType === 'Suspend'
        const isProbe = s.templateType === 'StatusCheck'
        return (
          <li
            key={s.template}
            className={cn(
              'rounded-lg border px-3 py-2',
              isPause || isProbe ? 'border-dashed border-edge-default' : 'border-edge-default',
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge kind={STEP_KIND[s.phase]} pulse={s.phase === 'running'}>{s.phase}</StatusBadge>
              <span className="text-[12.5px] font-medium text-content">
                {s.scenario?.title ?? (isPause ? 'Recovery pause' : isProbe ? 'Steady-state probe' : s.template)}
              </span>
              {!isPause && !isProbe ? <Badge>{s.templateType}</Badge> : null}
              {s.deadline ? <span className="ml-auto text-[11px] text-content-subtle">{s.deadline}</span> : null}
            </div>
            {s.scenario
              ? (
                <div className="mt-1 text-[11px] text-content-muted">
                  <span className="font-medium text-content-subtle">Expect:</span> {s.scenario.hypothesis}
                </div>
              )
              : isPause
              ? <div className="mt-1 text-[11px] text-content-subtle">Quiet time, so recovery is observable.</div>
              : isProbe
              ? <div className="mt-1 text-[11px] text-content-subtle">Polling throughout; three failures abort the run.</div>
              : null}
          </li>
        )
      })}
    </ol>
  )
}
