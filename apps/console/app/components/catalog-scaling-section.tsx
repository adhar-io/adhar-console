import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  CONSOLE_PERMISSIONS,
  consoleCheck,
  Input,
  Modal,
  Spinner,
  useAccessReview,
  useToast,
  useToolPublicUrl,
} from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { KObj } from '~/data/catalog-composition-model.ts'
import type { EnvRow } from '~/data/catalog-deployment-model.ts'
import { ago } from '~/data/catalog-deployment-model.ts'
import { pickWorkload, type WorkloadStatus } from '~/data/catalog-deployment-delivery.ts'
import { useKargoPromotions } from '~/data/catalog-deployment.ts'
import {
  AUTO_PRESETS,
  changeWarnings,
  currentIntent,
  DEFAULT_CPU_TARGET,
  declaredDrift,
  deriveOp,
  describeChange,
  describeIntent,
  describeScaleEvent,
  FIXED_PRESETS,
  type HpaView,
  hpaView,
  instances,
  isProductionEnv,
  lineDiff,
  type LiveScaling,
  MAX_INSTANCES,
  MAX_TARGET,
  MIN_TARGET,
  type OpState,
  sameIntent,
  scaledObjectFor,
  scalerFor,
  scalerLimit,
  scalerProblem,
  type ScalingIntent,
  type ScalingOp,
  validateIntent,
} from '~/data/catalog-scaling-model.ts'
import {
  applyScaling,
  clearScalingOp,
  patchScalingOp,
  planScaling,
  type ScalingError,
  type ScalingPlan,
  type ScalingState,
  setScalingOp,
  settleScaling,
  useScaleEvent,
  useScalers,
  useScalingOp,
  useScalingState,
} from '~/data/catalog-scaling.ts'

/**
 * The catalog drawer's Scaling section: per environment, how many instances
 * run, whether an autoscaler decides that, and the controls to change either.
 *
 * Every change is committed to the application's kustomize overlay and rolled
 * out by a Kargo promotion (see `data/catalog-scaling-model.ts` for why a live
 * patch would be undone by Argo CD). The row then follows the change to the
 * pods: committed → promoted → applied by Argo CD → running, from the live
 * watches, so closing and reopening the drawer tells the same story.
 */

export interface ScalingSectionProps {
  /** The application's name on the platform (the XR's). */
  appName: string
  rows: EnvRow[]
  workloads: readonly KObj[]
  kargoProject?: string
  repoRef?: { org: string; repo: string }
}

interface ScalableEnv {
  row: EnvRow
  namespace: string
  workload: WorkloadStatus
}

export function ScalingSection({ appName, rows, workloads, kargoProject, repoRef }: ScalingSectionProps) {
  const envs = useMemo(
    () =>
      rows.flatMap((row): ScalableEnv[] => {
        if (!row.namespace) return []
        const w = pickWorkload(workloads, appName, row.namespace)
        return w ? [{ row, namespace: row.namespace, workload: w }] : []
      }),
    [rows, workloads, appName],
  )
  const namespaces = useMemo(() => [...new Set(envs.map((e) => e.namespace))], [envs])
  const scalers = useScalers(namespaces, envs.length > 0)
  const promotions = useKargoPromotions(kargoProject, envs.length > 0)
  if (!envs.length) return null
  return (
    <section className="min-w-0 rounded-xl border border-edge-default bg-surface-raised px-4 py-4 sm:px-5" aria-labelledby="scaling-title">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h3 id="scaling-title" className="text-[10px] font-semibold uppercase tracking-[0.12em] text-content-subtle">
          Scaling<span className="ml-1.5 tabular-nums text-content-muted">· {envs.length}</span>
        </h3>
      </header>
      {scalers.isError && !scalers.data ? (
        <p className="mb-3 rounded-md border border-dashed border-edge-default px-3 py-2 text-[11px] text-content-muted">
          The autoscalers in {namespaces.join(', ')} could not be read, so whether autoscaling is on is unknown — not off.
        </p>
      ) : null}
      <ol className="space-y-3">
        {envs.map((e, i) => (
          <li key={e.row.key}>
            <ScalingRow
              appName={appName}
              env={e}
              step={i + 1}
              hpas={scalers.data?.hpas}
              scaledObjects={scalers.data?.scaledObjects ?? []}
              scalersLoading={scalers.isLoading}
              promotions={promotions.data}
              repoRef={repoRef}
            />
          </li>
        ))}
      </ol>
      <p className="mt-2.5 text-[11px] leading-relaxed text-content-subtle">
        Scaling is declared in Git, in each environment's overlay. A change is committed there and rolled out by re-promoting the release already running,
        so Argo CD applies it — and never puts back what was there before. A change made directly on the cluster would be.
      </p>
    </section>
  )
}

/* ─────────── one environment ─────────── */

interface RowProps {
  appName: string
  env: ScalableEnv
  step: number
  hpas: readonly KObj[] | undefined
  scaledObjects: readonly KObj[]
  scalersLoading: boolean
  promotions: ReadonlyArray<{ name: string; phase: string; message?: string }> | undefined
  repoRef?: { org: string; repo: string }
}

type DialogIntent = { initial: ScalingIntent; title: string } | null

function ScalingRow({ appName, env, step, hpas, scaledObjects, scalersLoading, promotions, repoRef }: RowProps) {
  const { row, namespace, workload } = env
  const toast = useToast()
  const qc = useQueryClient()
  const gitea = useToolPublicUrl('gitea')
  const target = { kind: workload.kind, name: workload.name, namespace }
  const hpaObj = hpas ? scalerFor(hpas, target) : undefined
  const hpa = hpaObj ? hpaView(hpaObj) : undefined
  const keda = scaledObjectFor(scaledObjects, target)?.metadata.name ?? hpa?.keda
  const event = useScaleEvent(hpa)
  const stateQ = useScalingState(appName, row.key, repoRef)
  const state = stateQ.data?.state
  const refusal = stateQ.data?.refusal
  const access = useAccessReview(consoleCheck(CONSOLE_PERMISSIONS.appScale, namespace))
  const op = useScalingOp(appName, row.key)
  const prod = isProductionEnv(row.key)

  const live: LiveScaling = {
    workload: { desired: workload.replicas.desired, ready: workload.replicas.ready, available: workload.replicas.available },
    ...(hpa ? { hpa } : {}),
    ...(op?.promotion ? { promotion: promotions?.find((p) => p.name === op.promotion) } : {}),
    ...(row.app ? { argo: { sync: row.app.status.sync.status, operation: row.app.status.operationState?.phase } } : {}),
  }
  // The clock only matters for the 15-minute "stuck" verdict; every other
  // step moves on a watch event.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!op) return
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [op])
  const opState = op ? deriveOp(op, live, Math.max(now, op.startedAt)) : undefined
  const current = currentIntent(workload.replicas.desired, hpa)
  const busy = Boolean(op && opState && !['done', 'failed', 'deferred'].includes(opState.phase))

  // Why the controls are not offered, when they are not.
  const blocked: string | undefined = keda
    ? `Scaled by KEDA (ScaledObject ${keda}) — change its triggers and bounds in the overlay.`
    : refusal
      ? refusal.message
      : state && state.overlay !== 'ok'
        ? state.overlayProblem ?? 'The overlay cannot be managed from the console.'
        : stateQ.isError && !stateQ.data
          ? 'The overlay could not be read from Gitea, so changes are unavailable until it answers.'
          : undefined
  const permissionDenied = !access.loading && !access.allowed && !access.unknown
  const controllable = Boolean(state && state.overlay === 'ok' && !blocked && access.allowed && !scalersLoading)

  const [dialog, setDialog] = useState<DialogIntent>(null)
  const [draft, setDraft] = useState<number | null>(null)
  useEffect(() => setDraft(null), [workload.replicas.desired, Boolean(hpa)])

  // Follow the change: toasts on the way out, the settle step on the way through.
  const announced = useRef<string>('')
  useEffect(() => {
    if (!op || !opState) return
    const key = `${op.startedAt}:${opState.phase}`
    if (announced.current === key) return
    announced.current = key
    if (opState.phase === 'done') {
      toast.success(`${appName} · ${row.label}: ${describeIntent(op.target)} — rolled out`)
      void qc.invalidateQueries({ queryKey: ['catalog', 'scaling', 'state', appName, row.key] })
      return
    }
    if (opState.phase === 'failed') toast.error(`${appName} · ${row.label}: ${opState.detail}`)
    if (opState.needsSettle && !op.settleRequested && access.allowed) {
      patchScalingOp(appName, row.key, { settleRequested: true })
      settleScaling(appName, row.key).catch((e: ScalingError) => {
        if (e.status !== 409) toast.error(`Setting ${op.target.mode === 'fixed' ? instances(op.target.replicas) : 'the count'} in ${row.label} failed: ${e.message}`)
        // 409: not rendered / Argo CD busy — try again on the next change of state.
        else patchScalingOp(appName, row.key, { settleRequested: false })
      })
    }
  }, [op, opState?.phase, opState?.needsSettle]) // eslint-disable-line react-hooks/exhaustive-deps
  // A finished change stays on screen for a moment, then the row is just the row.
  const doneAt = opState?.phase === 'done' ? op?.startedAt : undefined
  useEffect(() => {
    if (doneAt === undefined) return
    const t = setTimeout(() => clearScalingOp(appName, row.key), 4_000)
    return () => clearTimeout(t)
  }, [doneAt, appName, row.key])

  const drift = !op ? declaredDrift(state?.declared, live) : undefined
  const [settling, setSettling] = useState(false)
  const settleNow = async () => {
    setSettling(true)
    try {
      const r = await settleScaling(appName, row.key)
      toast.success(r.noop ? `${row.label} already runs ${instances(r.replicas)}` : `${row.label}: set to ${instances(r.replicas)}, as the overlay declares`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSettling(false)
    }
  }

  const openFixed = (replicas: number, title: string) => setDialog({ initial: { mode: 'fixed', replicas }, title })
  const autoDefaults = (): ScalingIntent => {
    const min = Math.max(1, Math.min(MAX_INSTANCES, workload.replicas.desired || 1))
    return { mode: 'auto', min, max: Math.min(MAX_INSTANCES, Math.max(min + 2, min * 2)), cpu: DEFAULT_CPU_TARGET }
  }
  const toggle = (on: boolean) => {
    if (on) setDialog({ initial: autoDefaults(), title: 'Turn on autoscaling' })
    else openFixed(hpa?.current ?? workload.replicas.desired, 'Turn off autoscaling')
  }
  const shown = draft ?? workload.replicas.desired
  const dirty = draft !== null && draft !== workload.replicas.desired
  const switchId = useId()

  return (
    <div className="overflow-hidden rounded-lg border border-edge-default bg-surface-raised">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-3.5 pt-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-[9px] font-bold text-content-muted ring-1 ring-edge-default">{step}</span>
            <span className="truncate text-[13px] font-semibold text-content">{row.label}</span>
            {prod ? <span className="rounded bg-amber-50 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-800 ring-1 ring-inset ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/30">prod</span> : null}
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-content-subtle" title={`${workload.kind} ${namespace}/${workload.name}`}>
            ns {namespace} · {workload.kind}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <label htmlFor={switchId} className={cn('text-[11px] font-medium', controllable && !busy ? 'cursor-pointer text-content-muted' : 'text-content-subtle')}>
            Autoscale
          </label>
          {scalersLoading ? <Spinner size={12} /> : (
            <Switch
              id={switchId}
              checked={Boolean(hpa)}
              disabled={!controllable || busy}
              title={!controllable ? blocked ?? (permissionDenied ? 'You can view scaling, not change it' : undefined) : busy ? 'A change is rolling out' : hpa ? 'Turn off autoscaling…' : 'Turn on autoscaling…'}
              onChange={toggle}
            />
          )}
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-x-5 gap-y-3 px-3.5 pb-3 pt-2.5 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
        <InstancesBlock workload={workload} hpa={hpa} />
        <div className="min-w-0">
          {hpa ? (
            <AutoBlock
              hpa={hpa}
              event={event.data ?? undefined}
              controllable={controllable && !busy}
              onEdit={() => setDialog({ initial: current ?? autoDefaults(), title: 'Autoscaling limits' })}
              onTurnOff={() => toggle(false)}
              desired={workload.replicas.desired}
            />
          ) : (
            <FixedBlock
              value={shown}
              controllable={controllable && !busy}
              dirty={dirty}
              preview={dirty ? describeChange(current, { mode: 'fixed', replicas: shown }) : undefined}
              onChange={setDraft}
              onCancel={() => setDraft(null)}
              onReview={() => openFixed(shown, 'Change instances')}
            />
          )}
        </div>
      </div>

      {op && opState ? (
        <OpProgress op={op} state={opState} gitea={gitea} repo={state?.repo ?? (repoRef ? { ...repoRef, branch: '', dir: '' } : undefined)} onDismiss={() => clearScalingOp(appName, row.key)} />
      ) : drift !== undefined ? (
        <div className="mx-3.5 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          <span className="min-w-0">
            The overlay declares {instances(drift)}, but {workload.replicas.desired} run: Argo CD ignores the count the autoscaler set before it was turned off.
          </span>
          {access.allowed ? <Button size="xs" variant="secondary" loading={settling} onClick={() => void settleNow()}>Set {drift} now</Button> : null}
        </div>
      ) : null}

      <footer className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-edge-subtle bg-surface-sunken/40 px-3.5 py-1.5 text-[11px] text-content-subtle">
        <Provenance state={state} loading={stateQ.isLoading} blocked={blocked} denied={permissionDenied} namespace={namespace} />
      </footer>

      {dialog ? (
        <ScaleDialog
          app={appName}
          env={row.key}
          envLabel={row.label}
          current={current}
          initial={dialog.initial}
          title={dialog.title}
          onClose={() => setDialog(null)}
          onApplied={(res, plan) => {
            setDialog(null)
            setDraft(null)
            if (res.noop) {
              toast.info(`${row.label} already runs ${describeIntent(plan.target)}`)
              return
            }
            setScalingOp({
              app: appName,
              env: row.key,
              ...(current ? { from: current } : {}),
              target: plan.target,
              startedAt: Date.now(),
              ...(res.commit ? { commit: res.commit } : {}),
              ...(res.promotion ? { promotion: res.promotion } : {}),
              rollout: res.rollout,
              ...(res.rolloutReason ? { deferredReason: res.rolloutReason } : {}),
            })
            void qc.invalidateQueries({ queryKey: ['catalog', 'scaling', 'state', appName, row.key] })
            void qc.invalidateQueries({ queryKey: ['catalog', 'kargo', 'promotions'] })
            if (res.rollout === 'deferred') toast.warning(`Committed ${res.summary.toLowerCase()} — ${res.rolloutReason ?? 'it applies with the next promotion'}`)
            else toast.success(`${row.label}: ${res.summary} — committed${res.commit ? ` ${res.commit.slice(0, 7)}` : ''}, rolling out`)
          }}
        />
      ) : null}
    </div>
  )
}

/* ─────────── building blocks ─────────── */

function Switch({ id, checked, disabled, onChange, title }: { id: string; checked: boolean; disabled?: boolean; onChange(next: boolean): void; title?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-brand-600' : 'bg-slate-300 dark:bg-slate-600',
      )}
    >
      <span aria-hidden className={cn('inline-block size-4 rounded-full bg-white shadow-sm transition-transform', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
    </button>
  )
}

/** The big number, and a dot per instance: ready, starting, or on its way out. */
function InstancesBlock({ workload, hpa }: { workload: WorkloadStatus; hpa?: HpaView }) {
  const { desired, ready, available } = workload.replicas
  const total = Math.max(desired, ready)
  const shown = Math.min(total, 12)
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tabular-nums leading-none text-content">{desired}</span>
        <span className="text-[12px] text-content-muted">{desired === 1 ? 'instance' : 'instances'}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1" aria-hidden>
        {Array.from({ length: shown }, (_, i) => (
          <span
            key={i}
            className={cn(
              'size-2.5 rounded-full',
              i < Math.min(ready, desired)
                ? 'bg-emerald-500'
                : i < desired
                  ? 'bg-transparent ring-2 ring-inset ring-amber-400'
                  : 'bg-slate-300 dark:bg-slate-600',
            )}
          />
        ))}
        {total > shown ? <span className="text-[10px] tabular-nums text-content-subtle">+{total - shown}</span> : null}
        {desired === 0 ? <span className="text-[11px] font-medium text-rose-700 dark:text-rose-300">offline</span> : null}
      </div>
      <p className="mt-1.5 text-[11px] tabular-nums text-content-muted">
        {ready} ready · {available} available
        {ready > desired ? <span className="text-content-subtle"> · {ready - desired} stopping</span> : null}
      </p>
      {hpa?.desired !== undefined && hpa.desired !== desired ? (
        <p className="text-[11px] text-brand-700 dark:text-brand-300">autoscaler wants {hpa.desired}</p>
      ) : null}
    </div>
  )
}

function Stepper({ value, onChange, min, max, disabled, label }: { value: number; onChange(n: number): void; min: number; max: number; disabled?: boolean; label: string }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const set = (n: number) => onChange(Math.min(max, Math.max(min, n)))
  const btn = 'inline-flex size-8 items-center justify-center text-content-muted transition-colors hover:bg-surface-sunken hover:text-content focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent pointer-coarse:size-11'
  return (
    <div className={cn('inline-flex items-stretch overflow-hidden rounded-md border border-edge-default bg-surface-raised shadow-xs', disabled && 'opacity-60')}>
      <button type="button" className={btn} disabled={disabled || value <= min} onClick={() => set(value - 1)} aria-label={`${label}: one fewer`}>
        <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden><path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </button>
      <input
        type="number"
        inputMode="numeric"
        aria-label={label}
        min={min}
        max={max}
        disabled={disabled}
        value={text}
        onChange={(e) => {
          setText(e.currentTarget.value)
          const n = Number(e.currentTarget.value)
          if (e.currentTarget.value !== '' && Number.isInteger(n)) set(n)
        }}
        onBlur={() => setText(String(value))}
        className="w-12 border-x border-edge-default bg-transparent text-center text-[14px] font-semibold tabular-nums text-content [appearance:textfield] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500/50 disabled:cursor-not-allowed [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button type="button" className={btn} disabled={disabled || value >= max} onClick={() => set(value + 1)} aria-label={`${label}: one more`}>
        <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden><path d="M3.5 8h9M8 3.5v9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </button>
    </div>
  )
}

function Chip({ active, onClick, children, disabled, title }: { active?: boolean; onClick(): void; children: React.ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-7 items-center rounded-md border px-2 text-[12px] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11',
        active
          ? 'border-brand-300 bg-brand-50 text-brand-800 dark:border-brand-500/40 dark:bg-brand-500/15 dark:text-brand-200'
          : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

function FixedBlock({ value, controllable, dirty, preview, onChange, onCancel, onReview }: {
  value: number
  controllable: boolean
  dirty: boolean
  preview?: string
  onChange(n: number): void
  onCancel(): void
  onReview(): void
}) {
  if (!controllable) {
    return (
      <div className="text-[12px] leading-relaxed text-content-muted">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-content-subtle">Fixed count</div>
        <p className="mt-1">Runs {instances(value)}; no autoscaler.</p>
      </div>
    )
  }
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-content-subtle">Instances</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <Stepper value={value} onChange={onChange} min={0} max={MAX_INSTANCES} label="Instances" />
        <div className="flex flex-wrap gap-1" role="group" aria-label="Presets">
          {FIXED_PRESETS.map((n) => <Chip key={n} active={value === n} onClick={() => onChange(n)}>{n}</Chip>)}
        </div>
      </div>
      {dirty && preview ? (
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-md bg-brand-50/70 px-2.5 py-1.5 ring-1 ring-inset ring-brand-200/70 dark:bg-brand-500/10 dark:ring-brand-500/25">
          <span className={cn('text-[12px] font-semibold tabular-nums', value === 0 ? 'text-rose-700 dark:text-rose-300' : 'text-brand-800 dark:text-brand-200')}>
            {preview}
            {value === 0 ? <span className="font-normal"> · takes the app offline</span> : null}
          </span>
          <span className="flex items-center gap-1.5">
            <Button size="xs" variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button size="xs" variant="primary" onClick={onReview}>Review change</Button>
          </span>
        </div>
      ) : (
        <p className="mt-1.5 text-[11px] text-content-subtle">Fixed count — turn on Autoscale to follow load instead.</p>
      )}
    </div>
  )
}

function AutoBlock({ hpa, event, controllable, onEdit, onTurnOff, desired }: {
  hpa: HpaView
  event?: { reason: string; message: string; at?: string; type?: string }
  controllable: boolean
  onEdit(): void
  onTurnOff(): void
  desired: number
}) {
  const problem = scalerProblem(hpa)
  const limit = scalerLimit(hpa)
  return (
    <div className="min-w-0 space-y-2.5">
      <RangeBar min={hpa.min} max={hpa.max} current={desired} />
      {hpa.cpuTarget !== undefined ? <Meter label="CPU" now={hpa.cpuNow} target={hpa.cpuTarget} /> : null}
      {hpa.memoryTarget !== undefined ? <Meter label="Memory" now={hpa.memoryNow} target={hpa.memoryTarget} /> : null}
      {hpa.otherMetrics.length ? <p className="text-[11px] text-content-muted">Also follows {hpa.otherMetrics.join(', ')}</p> : null}
      {problem ? (
        <p className="rounded-md bg-rose-50 px-2 py-1.5 text-[11px] leading-relaxed text-rose-800 dark:bg-rose-500/10 dark:text-rose-200" title={problem.message}>
          Cannot scale: {problem.message ?? problem.reason}
        </p>
      ) : limit ? (
        <p className={cn('text-[11px]', limit.atMax ? 'text-amber-800 dark:text-amber-200' : 'text-content-muted')}>Autoscaler {limit.text}</p>
      ) : null}
      {event ? (
        <p className={cn('truncate text-[11px]', event.type === 'Warning' ? 'text-amber-800 dark:text-amber-200' : 'text-content-muted')} title={`${event.reason}: ${event.message}`}>
          {describeScaleEvent(event.reason, event.message)}
          {event.at ? <span className="text-content-subtle"> · {ago(event.at)}</span> : null}
        </p>
      ) : hpa.lastScaleTime ? (
        <p className="text-[11px] text-content-muted">Last scaled {ago(hpa.lastScaleTime)}</p>
      ) : (
        <p className="text-[11px] text-content-subtle">Has not scaled since it was created.</p>
      )}
      {controllable ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-edge-subtle pt-2.5">
          <Stepper value={desired} onChange={() => {}} min={0} max={MAX_INSTANCES} disabled label="Instances (set by the autoscaler)" />
          <span className="order-last w-full text-[11px] leading-snug text-content-subtle sm:order-none sm:w-auto sm:min-w-0 sm:flex-1">
            Set by the autoscaler.{' '}
            <button type="button" onClick={onTurnOff} className="rounded-sm text-left font-medium text-brand-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 dark:text-brand-300">
              Turn off autoscaling to set a fixed count
            </button>
          </span>
          <Button size="xs" variant="secondary" className="ml-auto" onClick={onEdit}>Edit limits</Button>
        </div>
      ) : null}
    </div>
  )
}

/** min … max on a track, with where it runs now. */
function RangeBar({ min, max, current }: { min: number; max: number; current: number }) {
  const top = Math.max(max, current, 1)
  const pct = (v: number) => `${(Math.min(v, top) / top) * 100}%`
  return (
    <div className="min-w-0" aria-label={`Autoscales between ${min} and ${max}; ${current} now`}>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="font-medium text-content">Between {min} and {max}</span>
        <span className="tabular-nums text-content-subtle">{current} now</span>
      </div>
      <div className="relative mt-1.5 h-1.5 rounded-full bg-surface-sunken ring-1 ring-inset ring-edge-subtle">
        <div className="absolute inset-y-0 min-w-1.5 rounded-full bg-brand-200 dark:bg-brand-500/40" style={{ left: pct(min), right: `calc(100% - ${pct(max)})` }} />
        <div className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface-raised bg-brand-600 shadow-sm" style={{ left: pct(Math.max(current, 0.0001)) }} />
      </div>
    </div>
  )
}

/** Utilisation now against the autoscaler's target. */
function Meter({ label, now, target }: { label: string; now?: number; target: number }) {
  const scale = Math.max(100, target * 1.5, now ?? 0)
  const tone = now === undefined ? 'bg-slate-300 dark:bg-slate-600' : now > target ? 'bg-amber-500' : 'bg-emerald-500'
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-content-muted">{label}</span>
        <span className="tabular-nums text-content-subtle">
          {now === undefined ? 'no reading' : <span className={cn('font-medium', now > target ? 'text-amber-800 dark:text-amber-200' : 'text-content')}>{now}%</span>} · target {target}%
        </span>
      </div>
      <div className="relative mt-1 h-1.5 rounded-full bg-surface-sunken ring-1 ring-inset ring-edge-subtle" role="meter" aria-label={`${label} utilisation`} aria-valuenow={now ?? 0} aria-valuemin={0} aria-valuemax={Math.round(scale)}>
        <div className={cn('absolute inset-y-0 left-0 rounded-full', tone)} style={{ width: `${((now ?? 0) / scale) * 100}%` }} />
        <div className="absolute -inset-y-0.5 w-0.5 rounded bg-content-muted" style={{ left: `${(target / scale) * 100}%` }} title={`target ${target}%`} />
      </div>
    </div>
  )
}

/** Where the numbers come from — and why the controls are missing, when they are. */
function Provenance({ state, loading, blocked, denied, namespace }: { state?: ScalingState; loading: boolean; blocked?: string; denied: boolean; namespace: string }) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Spinner size={10} /> Reading the overlay…
      </span>
    )
  }
  if (blocked) return <span className="min-w-0 break-words text-amber-800 dark:text-amber-200">{blocked}</span>
  if (!state) return null
  const where = `${state.repo.org}/${state.repo.repo} · ${state.repo.dir}${state.managed ? '/scaling.yaml' : ''}`
  return (
    <>
      <span className="min-w-0 max-w-full truncate" title={`${where} on ${state.repo.branch}`}>
        <span className="text-content-muted">{state.managed ? 'Declared in' : 'Set by the overlay'}</span> <span className="font-mono">{where}</span>
      </span>
      <span aria-hidden className="hidden sm:inline">·</span>
      <span className="basis-full sm:basis-auto">{state.delivery === 'kargo' ? `rolls out via Kargo (${state.kargo?.project}/${state.kargo?.stage})` : 'rolls out via Argo CD'}</span>
      {denied ? (
        <span className="basis-full text-content-muted">
          View only — changing it needs <code className="font-mono">update application-scaling.console.adhar.io</code> in {namespace}.
        </span>
      ) : null}
    </>
  )
}

/* ─────────── following a change ─────────── */

function OpProgress({ op, state, gitea, repo, onDismiss }: {
  op: ScalingOp
  state: OpState
  gitea: string
  repo?: { org: string; repo: string }
  onDismiss(): void
}) {
  if (state.phase === 'deferred') {
    return (
      <div className="mx-3.5 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-900 dark:bg-amber-500/10 dark:text-amber-200" role="status">
        <span className="min-w-0">
          <span className="font-semibold">Committed {describeIntent(op.target)}.</span> {state.detail}
        </span>
        <Button size="xs" variant="ghost" onClick={onDismiss}>Dismiss</Button>
      </div>
    )
  }
  const viaKargo = op.rollout === 'promotion'
  const steps = viaKargo ? ['Committed', 'Promoted', 'Applied', 'Running'] : ['Committed', 'Applied', 'Running']
  // The step in progress (or where it stopped); everything before it is done.
  const failed = state.phase === 'failed'
  const at = state.phase === 'done'
    ? steps.length
    : failed
      ? (viaKargo ? [1, 2, 2, 3] : [1, 1, 1, 2])[state.step]
      : ({ promoting: 1, syncing: viaKargo ? 2 : 1, settling: viaKargo ? 2 : 1, scaling: viaKargo ? 3 : 2 } as Record<string, number>)[state.phase] ?? 1
  const commitHref = op.commit && gitea && repo ? `${gitea.replace(/\/$/, '')}/${repo.org}/${repo.repo}/commit/${op.commit}` : undefined
  return (
    <div className="mx-3.5 mb-3 rounded-md border border-edge-subtle bg-surface-sunken/50 px-2.5 py-2" role="status" aria-live="polite">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px]">
        {steps.map((s, i) => {
          const done = i < at
          const active = i === at
          return (
            <li key={s} className="flex items-center gap-1.5">
              {i > 0 ? <span aria-hidden className={cn('h-px w-3 sm:w-5', i <= at ? 'bg-emerald-500' : 'bg-edge-default')} /> : null}
              <span
                className={cn(
                  'inline-flex items-center gap-1 font-medium',
                  done ? 'text-emerald-700 dark:text-emerald-300' : active ? (failed ? 'text-rose-700 dark:text-rose-300' : 'text-brand-700 dark:text-brand-300') : 'text-content-subtle',
                )}
              >
                {done ? (
                  <svg viewBox="0 0 16 16" className="size-3" aria-hidden><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                ) : active && !failed ? <Spinner size={10} /> : active ? <span aria-hidden>✕</span> : <span aria-hidden className="size-1.5 rounded-full bg-current opacity-50" />}
                {s}
                {i === 0 && op.commit ? (
                  commitHref ? <a href={commitHref} target="_blank" rel="noreferrer" className="font-mono text-content-muted hover:underline">{op.commit.slice(0, 7)}</a> : <span className="font-mono text-content-muted">{op.commit.slice(0, 7)}</span>
                ) : null}
              </span>
            </li>
          )
        })}
      </ol>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
        <span className={cn('min-w-0 truncate', failed ? 'text-rose-700 dark:text-rose-300' : 'text-content-muted')} title={state.detail}>
          {describeIntent(op.target)} · {state.detail}
        </span>
        {failed || state.phase === 'done' ? <Button size="xs" variant="ghost" onClick={onDismiss}>Dismiss</Button> : null}
      </div>
    </div>
  )
}

/* ─────────── the review dialog ─────────── */

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  const key = JSON.stringify(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms])
  return v
}

interface DialogProps {
  app: string
  env: string
  envLabel: string
  current?: ScalingIntent
  initial: ScalingIntent
  title: string
  onClose(): void
  onApplied(res: Awaited<ReturnType<typeof applyScaling>>, plan: ScalingPlan): void
}

function ScaleDialog({ app, env, envLabel, current, initial, title, onClose, onApplied }: DialogProps) {
  const toast = useToast()
  const [mode, setMode] = useState<ScalingIntent['mode']>(initial.mode)
  const [replicas, setReplicas] = useState(initial.mode === 'fixed' ? initial.replicas : current?.mode === 'fixed' ? current.replicas : 1)
  const auto0 = initial.mode === 'auto' ? initial : { min: 2, max: 6, cpu: DEFAULT_CPU_TARGET, memory: undefined as number | undefined }
  const [min, setMin] = useState(auto0.min)
  const [max, setMax] = useState(auto0.max)
  const [cpuOn, setCpuOn] = useState(auto0.cpu !== undefined || auto0.memory === undefined)
  const [cpu, setCpu] = useState(auto0.cpu ?? DEFAULT_CPU_TARGET)
  const [memOn, setMemOn] = useState(auto0.memory !== undefined)
  const [memory, setMemory] = useState(auto0.memory ?? 80)
  const [confirm, setConfirm] = useState('')
  const [applying, setApplying] = useState(false)

  const raw = mode === 'fixed'
    ? { mode, replicas }
    : { mode, min, max, ...(cpuOn ? { cpu } : {}), ...(memOn ? { memory } : {}) }
  const checked = validateIntent(raw)
  const intent = checked.ok ? checked.value : undefined
  const unchanged = intent ? sameIntent(intent, current) : false
  const debounced = useDebounced(intent, 350)
  const plan = useQuery({
    queryKey: ['catalog', 'scaling', 'plan', app, env, JSON.stringify(debounced)],
    queryFn: () => planScaling(app, env, debounced!),
    enabled: Boolean(debounced) && !sameIntent(debounced, current),
    staleTime: 15_000,
    retry: 0,
  })
  const settled = Boolean(intent && debounced && sameIntent(intent, debounced) && plan.data && !plan.isFetching)
  const p = settled ? plan.data : undefined
  const needConfirm = p?.confirm ?? null
  const confirmed = !needConfirm || confirm === app
  const warnings = intent ? changeWarnings(env, current, intent) : []
  const fieldError = (f: string) => (!checked.ok && checked.field === f ? checked.message : undefined)

  const apply = async () => {
    if (!intent || !p) return
    setApplying(true)
    try {
      const res = await applyScaling(app, env, intent, p.fingerprint, needConfirm ? confirm : undefined)
      onApplied(res, p)
    } catch (e) {
      const err = e as ScalingError
      if (err.code === 'stale') {
        toast.warning(err.message)
        void plan.refetch()
      } else toast.error(err.message)
    } finally {
      setApplying(false)
    }
  }

  const offline = intent?.mode === 'fixed' && intent.replicas === 0
  return (
    <Modal
      open
      onClose={onClose}
      width="lg"
      title={`${title} · ${envLabel}`}
      description={<span>Commits the change to <span className="font-mono">{app}</span>'s overlay for {envLabel}, then rolls it out.</span>}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant={offline ? 'danger' : 'primary'}
            onClick={() => void apply()}
            loading={applying}
            disabled={!p || unchanged || !confirmed || applying}
          >
            {offline ? 'Take offline' : 'Apply'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="inline-flex rounded-lg border border-edge-default bg-surface-sunken p-0.5" role="radiogroup" aria-label="How instances are decided">
          {(['fixed', 'auto'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'rounded-md px-3 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 pointer-coarse:py-2.5',
                mode === m ? 'bg-surface-raised text-content shadow-sm ring-1 ring-edge-default' : 'text-content-muted hover:text-content',
              )}
            >
              {m === 'fixed' ? 'Fixed instances' : 'Autoscale'}
            </button>
          ))}
        </div>

        {mode === 'fixed' ? (
          <div>
            <div className="text-[13px] font-medium text-content">Instances</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Stepper value={replicas} onChange={setReplicas} min={0} max={MAX_INSTANCES} label="Instances" />
              <div className="flex flex-wrap gap-1" role="group" aria-label="Presets">
                {FIXED_PRESETS.map((n) => <Chip key={n} active={replicas === n} onClick={() => setReplicas(n)}>{n}</Chip>)}
              </div>
            </div>
            {fieldError('replicas') ? <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-300">{fieldError('replicas')}</p> : null}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Profiles">
              {AUTO_PRESETS.map((pr) => (
                <Chip
                  key={pr.label}
                  active={min === pr.min && max === pr.max && cpuOn && cpu === pr.cpu && !memOn}
                  onClick={() => {
                    setMin(pr.min)
                    setMax(pr.max)
                    setCpuOn(true)
                    setCpu(pr.cpu)
                    setMemOn(false)
                  }}
                  title={pr.hint}
                >
                  {pr.label}<span className="ml-1 font-normal text-content-subtle">{pr.hint.split(' at ')[0]}</span>
                </Chip>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <div className="text-[13px] font-medium text-content">Minimum</div>
                <div className="mt-1"><Stepper value={min} onChange={setMin} min={1} max={MAX_INSTANCES} label="Minimum instances" /></div>
                {fieldError('min') ? <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-300">{fieldError('min')}</p> : <p className="mt-1 text-[11px] text-content-subtle">Never fewer, even idle.</p>}
              </div>
              <div>
                <div className="text-[13px] font-medium text-content">Maximum</div>
                <div className="mt-1"><Stepper value={max} onChange={setMax} min={1} max={MAX_INSTANCES} label="Maximum instances" /></div>
                {fieldError('max') ? <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-300">{fieldError('max')}</p> : <p className="mt-1 text-[11px] text-content-subtle">The ceiling under load (cost cap).</p>}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TargetField label="CPU target" on={cpuOn} setOn={setCpuOn} value={cpu} setValue={setCpu} error={fieldError('cpu')} />
              <TargetField label="Memory target" on={memOn} setOn={setMemOn} value={memory} setValue={setMemory} error={fieldError('memory')} />
            </div>
          </div>
        )}

        {/* The preview: what changes, what it means, where it lands, how it rolls out. */}
        <div className="rounded-lg border border-edge-default bg-surface-sunken/50 px-3.5 py-3">
          {!intent ? (
            <p className="text-[12px] text-content-muted">Fix the values above to see the change.</p>
          ) : unchanged ? (
            <p className="text-[12px] text-content-muted">This is what {envLabel} runs now — {describeIntent(intent)}.</p>
          ) : (
            <>
              <div className={cn('text-[15px] font-semibold tabular-nums', offline ? 'text-rose-700 dark:text-rose-300' : 'text-content')}>{describeChange(current, intent)}</div>
              {warnings.length ? (
                <ul className="mt-2 space-y-1">
                  {warnings.map((w) => (
                    <li key={w} className="flex gap-1.5 text-[12px] leading-relaxed text-amber-900 dark:text-amber-200">
                      <span aria-hidden>⚠</span>
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="mt-2.5 text-[12px] leading-relaxed text-content-muted">
                {plan.isError ? (
                  <p className="rounded-md bg-rose-50 px-2 py-1.5 text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">{(plan.error as Error).message}</p>
                ) : !p ? (
                  <span className="inline-flex items-center gap-1.5"><Spinner size={11} /> Preparing the commit…</span>
                ) : (
                  <>
                    <p>
                      Commits {p.files.length ? <span className="font-mono text-content">{p.files.map((f) => f.path.split('/').pop()).join(', ')}</span> : 'nothing new'} in{' '}
                      <span className="font-mono text-content">{p.repo.org}/{p.repo.repo}</span> · <span className="font-mono">{p.repo.dir}</span> on{' '}
                      <span className="font-mono">{p.repo.branch}</span> (no rebuild: <span className="font-mono">[skip ci]</span>).
                    </p>
                    {p.rollout === 'promotion' ? (
                      <p className="mt-1">Then Kargo re-promotes the release already running in {envLabel} — same image — and Argo CD rolls it out.</p>
                    ) : p.rollout === 'argo' ? (
                      <p className="mt-1">Argo CD syncs the overlay straight from the branch and rolls it out.</p>
                    ) : (
                      <p className="mt-1 rounded-md bg-amber-50 px-2 py-1.5 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">{p.rolloutReason}</p>
                    )}
                    {p.files.length ? <CommitPreview files={p.files} /> : null}
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {needConfirm && !unchanged ? (
          <div className={cn('rounded-lg border px-3.5 py-3', needConfirm === 'offline' ? 'border-rose-200 bg-rose-50/60 dark:border-rose-500/30 dark:bg-rose-500/10' : 'border-amber-200 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/10')}>
            <label className="block text-[12px] font-medium text-content" htmlFor="scale-confirm">
              {needConfirm === 'offline' ? `This takes ${app} offline in ${envLabel}.` : `${envLabel} is production.`} Type <span className="font-mono">{app}</span> to confirm.
            </label>
            <Input
              id="scale-confirm"
              className="mt-2"
              autoComplete="off"
              spellCheck={false}
              value={confirm}
              onChange={(e) => setConfirm(e.currentTarget.value)}
              invalid={confirm.length > 0 && confirm !== app}
              placeholder={app}
            />
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

function TargetField({ label, on, setOn, value, setValue, error }: { label: string; on: boolean; setOn(v: boolean): void; value: number; setValue(v: number): void; error?: string }) {
  const id = useId()
  return (
    <div>
      <label className="flex items-center gap-2 text-[13px] font-medium text-content" htmlFor={id}>
        <input id={id} type="checkbox" checked={on} onChange={(e) => setOn(e.currentTarget.checked)} className="size-4 accent-brand-600 dark:accent-brand-500" />
        {label}
      </label>
      <div className={cn('mt-1 flex items-center gap-2', !on && 'opacity-50')}>
        <Stepper value={value} onChange={setValue} min={MIN_TARGET} max={MAX_TARGET} disabled={!on} label={`${label} percent`} />
        <span className="text-[12px] text-content-muted">% of request</span>
      </div>
      {error ? <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-300">{error}</p> : <p className="mt-1 text-[11px] text-content-subtle">Adds instances above it.</p>}
    </div>
  )
}

function CommitPreview({ files }: { files: ScalingPlan['files'] }) {
  return (
    <details className="group mt-2">
      <summary className="inline-flex cursor-pointer select-none items-center gap-1 rounded-sm text-[12px] font-medium text-brand-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 dark:text-brand-300">
        <svg viewBox="0 0 16 16" className="size-3 transition-transform group-open:rotate-90" aria-hidden><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        Show the commit
      </summary>
      <div className="mt-2 space-y-2">
        {files.map((f) => (
          <div key={f.path} className="overflow-hidden rounded-md border border-edge-default bg-surface-raised">
            <div className="flex items-center justify-between gap-2 border-b border-edge-subtle px-2.5 py-1 text-[11px]">
              <span className="min-w-0 truncate font-mono text-content">{f.path}</span>
              <span className={cn('shrink-0 font-medium', f.before === null ? 'text-emerald-700 dark:text-emerald-300' : f.after === null ? 'text-rose-700 dark:text-rose-300' : 'text-content-subtle')}>
                {f.before === null ? 'new' : f.after === null ? 'deleted' : 'changed'}
              </span>
            </div>
            <pre className="max-h-64 overflow-auto py-1 font-mono text-[11px] leading-[1.55]">
              {lineDiff(f.before, f.after).map((l, i) => (
                <div
                  key={i}
                  className={cn(
                    'whitespace-pre px-2.5',
                    l.op === '+' && 'bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200',
                    l.op === '-' && 'bg-rose-50 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200',
                    l.op === ' ' && 'text-content-muted',
                    l.op === '…' && 'italic text-content-subtle',
                  )}
                >
                  {l.op === '…' ? `  ⋯ ${l.text}` : `${l.op} ${l.text}`}
                </div>
              ))}
            </pre>
          </div>
        ))}
      </div>
    </details>
  )
}
