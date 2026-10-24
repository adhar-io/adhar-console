import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  Badge,
  Button,
  canResource,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
  StatusBadge,
  useCan,
  useOverlayDismiss,
  useToast,
  type StatusKind,
} from '@adhar/shell-ui'
import { cn, formatRelative, podRegexFromPods } from '@adhar/utils'
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
import { CHAOS_NAMESPACE, isLive, modeLabel, resultNameFor, type TargetMode } from '../data/chaos-kinds.ts'
import {
  type ChaosWorkflow,
  createGameDay,
  deleteGameDay,
  stopGameDay,
  useChaosCluster,
  useChaosResult,
  useChaosWorkflow,
  useChaosWorkflows,
  useGameDayEngines,
  useTargetNamespaces,
  WORKFLOWS_GVR,
} from '../data/chaos.ts'
import { gameDayInputFrom, gameDayRun, type GameDayPhase, orderSteps, rerunName, workflowPhase } from '../data/chaos-live.ts'
import { useProbeTimeline, useTargetPods } from '../data/chaos-live-hooks.ts'
import { isProtectedNamespace, launchAllowed, MAX_GAMEDAY_SECONDS, reviewLaunch } from '../data/chaos-safety.ts'
import { ChaosDrawer, LiveMetricsPanel, Panel, ProbePanel, runBadge, RunHero, StepList, TargetPodsPanel, useNow } from './chaos-run-canvas.tsx'
import { BLAST_TONE, GuardRow } from './chaos-launch.tsx'

/**
 * Game days — a whole sequence of experiments as one automated run.
 *
 * A single fault answers a single question. The failures that actually take
 * production down are the ones nobody rehearses, so the catalogue is the
 * product here: pick the scenarios, point them at a workload, and an Argo
 * Workflow runs them as Litmus ChaosEngines in order, with recovery time
 * between each and a probe on every engine watching the system throughout.
 *
 * Serial with pauses is the default because simultaneous faults tell you the
 * system broke without telling you which one broke it.
 */
export function ChaosGameDays({ namespace, onNew, onOpen }: { namespace?: string; onNew?(): void; onOpen(o: { namespace: string; name: string }): void }) {
  const workflows = useChaosWorkflows(namespace)
  // A game day is an Argo Workflow created beside the Litmus operator.
  const canCreate = useCan(canResource(WORKFLOWS_GVR, 'create', { namespace: CHAOS_NAMESPACE }))
  const list = workflows.data ?? []

  if (workflows.notInstalled) {
    return (
      <EmptyState
        title="Game days need Argo Workflows"
        description="A game day runs as an Argo Workflow, and Argo Workflows is an optional package on this platform that is not installed on this cluster. Enable the argo-workflows package and game days can be built and run from here; single experiments work without it."
      />
    )
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-content">Game days</h2>
          <p className="text-[12px] text-content-muted">
            A sequence of experiments, run automatically with recovery time between each and a steady-state probe that fails a scenario — and stops the run — if the system stops serving.
          </p>
        </div>
      </div>
      {workflows.error ? (
        <EmptyState compact title="Game days could not be read" description={(workflows.error as Error).message} action={<Button onClick={() => void workflows.refetch()}>Try again</Button>} />
      ) : workflows.isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} height={58} />)}</div>
      ) : list.length === 0 ? (
        <EmptyState
          title="No game days yet"
          description={canCreate
            ? 'Start with availability and network — one replica failing, then the network getting slow. Those two cover most of what actually happens.'
            : 'Ask a platform admin to schedule one, or for permission to create Argo Workflows in the chaos namespace.'}
          action={canCreate && onNew ? <Button variant="primary" onClick={onNew}>New game day</Button> : undefined}
        />
      ) : (
        <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
          {list.map((w) => <GameDayRow key={`${w.metadata.namespace}/${w.metadata.name}`} wf={w} onOpen={onOpen} />)}
        </ul>
      )}
    </section>
  )
}

/* ─────────────────────────── status ─────────────────────────── */

export { workflowPhase }

export const GD_PHASE_KIND: Record<GameDayPhase, StatusKind> = {
  pending: 'unknown',
  running: 'progressing',
  stopping: 'paused',
  accomplished: 'healthy',
  aborted: 'failed',
  stopped: 'paused',
}

export const GD_PHASE_LABEL: Record<GameDayPhase, string> = {
  pending: 'pending',
  running: 'running',
  stopping: 'stopping — reverting',
  accomplished: 'every hypothesis held',
  aborted: 'a hypothesis failed',
  stopped: 'stopped',
}

function GameDayRow({ wf, onOpen }: { wf: ChaosWorkflow; onOpen(o: { namespace: string; name: string }): void }) {
  const phase = workflowPhase(wf)
  const steps = orderSteps(wf).filter((s) => s.kind === 'scenario')
  const done = steps.filter((s) => s.phase === 'done' || s.phase === 'failed').length
  const live = phase === 'running' || phase === 'stopping'
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen({ namespace: wf.metadata.namespace ?? CHAOS_NAMESPACE, name: wf.metadata.name })}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-left hover:bg-surface-sunken"
      >
        <StatusBadge kind={GD_PHASE_KIND[phase]} pulse={live}>{GD_PHASE_LABEL[phase]}</StatusBadge>
        <div className="min-w-0 flex-1 basis-48">
          <div className="truncate text-[13px] font-medium text-content">{wf.metadata.name}</div>
          <div className="truncate text-[11px] text-content-subtle">
            {wf.metadata.labels?.['adhar.io/chaos-target'] ?? wf.metadata.namespace} · {steps.length} scenario{steps.length === 1 ? '' : 's'}
            {wf.metadata.creationTimestamp ? ` · ${formatRelative(wf.metadata.creationTimestamp)}` : ''}
          </div>
        </div>
        {/* One segment per scenario: the run's progress at a glance. */}
        <div className="flex w-full items-center gap-1 sm:w-48" aria-label={`${done} of ${steps.length} scenarios finished`}>
          {steps.map((s) => (
            <span
              key={s.template}
              title={`${s.scenario?.title ?? s.template}: ${s.phase}`}
              className={cn('h-1.5 flex-1 rounded-full', s.phase === 'done' ? 'bg-emerald-500' : s.phase === 'failed' ? 'bg-rose-500' : s.phase === 'running' ? 'animate-pulse bg-brand-500' : 'bg-surface-sunken')}
            />
          ))}
        </div>
      </button>
    </li>
  )
}

/* ─────────────────────────── builder ─────────────────────────── */

const MODES: TargetMode[] = ['one', 'percent', 'all']

export function GameDayBuilder({
  initialScenarios,
  taken = [],
  onClose,
  onCreated,
}: {
  initialScenarios?: string[]
  /** Workflow names that exist already. */
  taken?: string[]
  onClose(): void
  onCreated(o: { namespace: string; name: string }): void
}) {
  const toast = useToast()
  const qc = useQueryClient()
  const { cluster } = useChaosCluster()
  const panelRef = useRef<HTMLDivElement>(null)
  useOverlayDismiss(true, onClose, { focusRef: panelRef })
  const namespaces = useTargetNamespaces()
  const [name, setName] = useState('')
  const [namespace, setNamespace] = useState('')
  const [selector, setSelector] = useState('')
  const [mode, setMode] = useState<TargetMode>('one')
  const [value, setValue] = useState('50')
  const [picked, setPicked] = useState<string[]>(initialScenarios?.length ? initialScenarios : ['pod-delete-one'])
  const [strategy, setStrategy] = useState<'serial' | 'parallel'>('serial')
  const [recovery, setRecovery] = useState(30)
  const [probeUrl, setProbeUrl] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)

  const chosen = picked.map(scenarioById).filter((s): s is Scenario => Boolean(s))
  const duration = totalSeconds(chosen, { strategy, recoverySeconds: recovery })
  const highBlast = chosen.filter((s) => s.blast === 'high')
  const nsLabels = namespaces.data?.find((n) => n.name === namespace)?.labels
  const guards = useMemo(() => {
    const g = reviewLaunch({
      name: name.trim(),
      namespace: namespace || undefined,
      namespaceLabels: nsLabels,
      label: selector,
      mode,
      percent: value,
      blast: highBlast.length ? 'high' : chosen.some((s) => s.blast === 'medium') ? 'medium' : 'low',
      seconds: duration,
      maxSeconds: MAX_GAMEDAY_SECONDS,
      hasProbe: !!probeUrl.trim(),
      taken,
    })
    return chosen.length ? g : [{ level: 'block' as const, message: 'Pick at least one scenario.' }, ...g]
  }, [name, namespace, nsLabels, selector, mode, value, highBlast.length, chosen, duration, probeUrl, taken])
  const allowed = launchAllowed(guards, confirm, name.trim())
  const needsConfirm = guards.some((g) => g.level === 'confirm') && !guards.some((g) => g.level === 'block')

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
      const target: ChaosTarget = { namespace, label: selector.trim(), mode, percent: mode === 'percent' ? value : undefined }
      const manifest = buildGameDay({
        name: name.trim(),
        target,
        scenarios: picked,
        strategy,
        recoverySeconds: recovery,
        ...(probeUrl.trim() ? { steadyState: { url: probeUrl.trim(), statusCode: 200, intervalSeconds: 5 } } : {}),
      })
      const created = await createGameDay(manifest, cluster)
      toast.success(`${created.metadata.name} started`)
      void qc.invalidateQueries({ queryKey: ['chaos'] })
      onCreated({ namespace: created.metadata.namespace ?? CHAOS_NAMESPACE, name: created.metadata.name })
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-2 sm:p-4" role="dialog" aria-modal="true" aria-label="New game day">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/50" onClick={onClose} />
      <div ref={panelRef} className="relative flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-2xl">
        <div className="border-b border-edge-default px-5 py-3">
          <div className="text-sm font-semibold text-content">New game day</div>
          <div className="text-[11px] text-content-subtle">Litmus runs these as one Argo workflow (an optional package). Everything is bounded and reversible.</div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 sm:p-5 lg:grid-cols-[1fr_340px]">
          <div className="space-y-4">
            {byCategory.map(([category, list]) => (
              <div key={category}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <div className="text-[12px] font-semibold text-content">{CATEGORY_LABEL[category]}</div>
                  <div className="text-[11px] text-content-muted">{CATEGORY_BLURB[category]}</div>
                </div>
                <div className="mt-1.5 space-y-1.5">
                  {list.map((s) => <ScenarioCard key={s.id} scenario={s} order={picked.indexOf(s.id)} onToggle={() => toggle(s.id)} />)}
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-3 lg:sticky lg:top-0 lg:self-start">
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="friday-gameday" /></Field>
            <Field label="Target namespace" hint="Where the pods being broken live. Platform namespaces are not offered.">
              <Select
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
                options={[
                  { value: '', label: namespaces.isLoading ? 'Loading…' : 'Choose a namespace…' },
                  ...(namespaces.data ?? []).filter((n) => !isProtectedNamespace(n.name)).map((n) => ({ value: n.name, label: n.name })),
                ]}
              />
            </Field>
            <Field label="App label" hint="One label, e.g. app=checkout. Empty targets every pod in the namespace.">
              <Input value={selector} onChange={(e) => setSelector(e.target.value)} placeholder="app=checkout" />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Mode">
                <Select value={mode} onChange={(e) => setMode(e.target.value as TargetMode)} options={MODES.map((m) => ({ value: m, label: modeLabel(m, value) }))} />
              </Field>
              {mode === 'percent' ? <Field label="Percent"><Input value={value} onChange={(e) => setValue(e.target.value)} /></Field> : <div />}
            </div>
            <Field label="Order" hint="Serial isolates cause; parallel is a worst-case storm.">
              <Select
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as 'serial' | 'parallel')}
                options={[{ value: 'serial', label: 'One at a time, with recovery' }, { value: 'parallel', label: 'All at once' }]}
              />
            </Field>
            {strategy === 'serial' ? (
              <Field label="Recovery between scenarios" hint="Seconds of quiet, so recovery is observable.">
                <Input type="number" min={0} value={String(recovery)} onChange={(e) => setRecovery(Math.max(0, Number(e.target.value) || 0))} />
              </Field>
            ) : null}
            <Field label="Steady-state probe" hint="Polled every 5s throughout each fault. One failed poll fails that scenario and stops the run.">
              <Input value={probeUrl} onChange={(e) => setProbeUrl(e.target.value)} placeholder="http://checkout.payments.svc.cluster.local/health" />
            </Field>

            <div className="rounded-lg border border-edge-default bg-surface-sunken p-3 text-[12px]">
              <div className="font-medium text-content">{picked.length} scenario{picked.length === 1 ? '' : 's'} · about {formatSeconds(duration)}</div>
              {chosen.length ? <div className="mt-1 text-[11px] text-content-muted">{chosen.map((s, i) => `${i + 1}. ${s.title}`).join(' → ')}</div> : null}
            </div>
            {guards.length ? <ul className="space-y-1.5">{guards.map((g, i) => <GuardRow key={i} g={g} />)}</ul> : null}
            {needsConfirm ? (
              <Field label="Confirm" hint={`Type ${name.trim() || 'the name'} to confirm.`}>
                <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={name.trim()} />
              </Field>
            ) : null}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-edge-default px-5 py-3">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={!allowed || busy} onClick={() => void launch()}>{busy ? 'Starting…' : 'Start game day'}</Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function ScenarioCard({ scenario, order, onToggle }: { scenario: Scenario; order: number; onToggle(): void }) {
  const on = order >= 0
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      className={cn('block w-full rounded-lg border px-3 py-2 text-left transition-colors', on ? 'border-brand-400 bg-brand-50/60 dark:bg-brand-500/10' : 'border-edge-default hover:bg-surface-sunken')}
    >
      <div className="flex items-center gap-2">
        <span className={cn('flex size-4 shrink-0 items-center justify-center rounded border text-[9px] font-bold', on ? 'border-brand-500 bg-brand-600 text-white' : 'border-edge-strong')}>{on ? order + 1 : ''}</span>
        <span className="min-w-0 text-[12px] font-medium text-content">{scenario.title}</span>
        <Badge tone={BLAST_TONE[scenario.blast]} className="ml-auto">{scenario.blast}</Badge>
        <span className="text-[10px] text-content-subtle">{formatSeconds(scenario.seconds)}</span>
      </div>
      {/* The hypothesis is the experiment. Without it this is just breakage. */}
      <div className="mt-1 pl-6 text-[11px] text-content-muted"><span className="font-medium text-content-subtle">Expect:</span> {scenario.hypothesis}</div>
      <div className="pl-6 text-[11px] text-content-subtle">{scenario.rationale}</div>
    </button>
  )
}

/* ─────────────────────────── drawer ─────────────────────────── */

export function GameDayDrawer({ namespace, name, taken = [], onClose, onOpen }: { namespace: string; name: string; taken?: string[]; onClose(): void; onOpen(o: { namespace: string; name: string }): void }) {
  const wfq = useChaosWorkflow(namespace, name)
  const wf = wfq.data
  const toast = useToast()
  const qc = useQueryClient()
  const { cluster } = useChaosCluster()
  const canDelete = useCan(canResource(WORKFLOWS_GVR, 'delete', { namespace, name }))
  const canStop = useCan(canResource(WORKFLOWS_GVR, 'patch', { namespace, name }))
  const canCreate = useCan(canResource(WORKFLOWS_GVR, 'create', { namespace }))
  const [busy, setBusy] = useState<string | null>(null)

  const phase = wf ? workflowPhase(wf) : 'pending'
  const run = useMemo(() => (wf ? gameDayRun(wf) : undefined), [wf])
  const now = useNow(!!run?.active)
  const input = useMemo(() => (wf ? gameDayInputFrom(wf, name) : undefined), [wf, name])
  const engines = useGameDayEngines(name, !!run?.active)
  const current = (engines.data ?? []).find(isLive) ?? (engines.data ?? [])[0]
  const result = useChaosResult(current?.metadata.namespace, current ? resultNameFor(current) : undefined, !!run?.active)
  const probes = useProbeTimeline(result.data ?? undefined, current?.metadata.name)
  const targetNs = input?.target.namespace ?? wf?.metadata.labels?.['adhar.io/chaos-target']
  const pods = useTargetPods({ namespace: targetNs, selector: input?.target.label || undefined, live: !!run?.active })
  const regexRef = useRef<string | undefined>(undefined)
  if (!regexRef.current && pods.data?.raw.length) {
    regexRef.current = podRegexFromPods(pods.data.raw.map((p) => ({ name: p.metadata.name, templateHash: p.metadata.labels?.['pod-template-hash'] })))
  }

  const act = async (what: string, f: () => Promise<unknown>, ok: string) => {
    setBusy(what)
    try {
      await f()
      toast.success(ok)
      void qc.invalidateQueries({ queryKey: ['chaos'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  const running = phase === 'running' || phase === 'pending' || phase === 'stopping'

  const actions = wf ? (
    <>
      {canStop && (phase === 'running' || phase === 'pending') ? (
        <Button size="sm" variant="danger" disabled={busy !== null} title="Stop after the current step; the revert step still runs and removes every engine" onClick={() => void act('stop', () => stopGameDay(namespace, name, cluster), 'Stopping — the revert step will recover every fault')}>
          Stop
        </Button>
      ) : null}
      {canCreate && input ? (
        <Button
          size="sm"
          disabled={busy !== null || running}
          title={running ? 'Wait for this game day to finish, or stop it, before running it again' : 'Run the same scenarios against the same target again'}
          onClick={() => {
            const next = rerunName(name, taken)
            void act('rerun', async () => {
              const created = await createGameDay(buildGameDay({ ...input, name: next }), cluster)
              onOpen({ namespace: created.metadata.namespace ?? CHAOS_NAMESPACE, name: created.metadata.name })
            }, `${next} started`)
          }}
        >
          Re-run
        </Button>
      ) : null}
      {canDelete ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null || running}
          title={running ? 'A running game day owns live engines — stop it or let it finish' : undefined}
          onClick={() => void act('delete', async () => {
            await deleteGameDay(namespace, name, cluster)
            onClose()
          }, 'Game day deleted')}
        >
          Delete
        </Button>
      ) : null}
    </>
  ) : null

  return (
    <ChaosDrawer widthKey="platform.gameday" eyebrow={`Game day · targets ${targetNs ?? '—'}`} title={name} badge={run ? runBadge(run) : null} actions={actions} onClose={onClose}>
      {wfq.isLoading ? (
        <div className="space-y-3 p-5"><Skeleton height={120} /><Skeleton height={200} /></div>
      ) : wfq.gone ? (
        <div className="p-5"><EmptyState title="This game day no longer exists" description="Its workflow was deleted. The engines it created were removed by its revert step." action={<Button variant="primary" onClick={onClose}>Close</Button>} /></div>
      ) : wfq.error ? (
        <div className="p-5"><EmptyState title="The game day could not be read" description={(wfq.error as Error).message} action={<Button onClick={() => void wfq.refetch()}>Try again</Button>} /></div>
      ) : wf && run ? (
        <div className="space-y-4 p-4 sm:p-5">
          <RunHero run={run} now={now} target={pods.data ? { ready: pods.data.ready, total: pods.data.total } : undefined} />
          {phase === 'aborted' ? (
            <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-[12px] text-rose-800 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200">
              A hypothesis did not hold and the run stopped; the revert step recovered the fault. That is the experiment&apos;s most valuable result: the system stopped serving under a fault it was expected to survive.
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Panel title="Scenarios" sub={wf.metadata.annotations?.['adhar.io/chaos-strategy'] === 'parallel' ? 'all at once' : 'one at a time, with recovery'}>
              {run.steps.length ? <StepList steps={run.steps} now={now} /> : <div className="text-[12px] text-content-subtle">Argo creates a node per step as the workflow starts.</div>}
            </Panel>
            <div className="space-y-4">
              <TargetPodsPanel title={`${targetNs ?? ''}${input?.target.label ? ` · ${input.target.label}` : ''}`} rows={pods.data?.rows} loading={pods.isLoading} error={pods.error as Error | null} />
              <ProbePanel
                samples={probes}
                url={input?.steadyState?.url}
                finalPct={(() => {
                  const n = Number(result.data?.status?.experimentStatus?.probeSuccessPercentage)
                  return Number.isFinite(n) && result.data?.status?.experimentStatus?.probeSuccessPercentage !== '' ? n : undefined
                })()}
                active={run.active}
                now={now}
              />
            </div>
          </div>
          <LiveMetricsPanel namespace={targetNs} podRegex={regexRef.current} start={run.startedAt} end={run.finishedAt} active={run.active} windows={run.windows} now={now} />
        </div>
      ) : null}
    </ChaosDrawer>
  )
}
