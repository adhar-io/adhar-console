import { useMemo, useState } from 'react'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  SearchInput,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { cn, formatRelative } from '@adhar-console/utils'
import type { argoRollouts } from '@adhar-console/api-clients'
import {
  useAbortRollout,
  usePromoteRollout,
  useRetryRollout,
  useRollouts,
} from '../data/delivery.ts'
import {
  byAttention,
  readRollout,
  summariseRollouts,
  type RolloutPhase,
  type RolloutView,
} from '../data/rollout-state.ts'

/**
 * Argo Rollouts — progressive delivery, and the controls to steer it.
 *
 * The card showed a step ladder and three buttons, and ignored most of what a
 * Rollout reports: how many replicas are actually updated and ready, how much
 * traffic the canary is taking, whether the rollout was aborted. Retry was
 * never offered at all, so an aborted rollout could be watched from the
 * console but only recovered from a terminal.
 *
 * Which actions are offered is decided in `rollout-state.ts`, under test.
 */

const PHASE_KIND: Record<RolloutPhase, StatusKind> = {
  Healthy: 'healthy',
  Progressing: 'progressing',
  Degraded: 'degraded',
  Paused: 'paused',
  Unknown: 'unknown',
}

export function Rollouts() {
  const q = useRollouts()
  const promote = usePromoteRollout()
  const abort = useAbortRollout()
  const retry = useRetryRollout()

  const [search, setSearch] = useState('')
  const [phase, setPhase] = useState<RolloutPhase | null>(null)

  const list = useMemo(
    () => ((q.data ?? []) as argoRollouts.Rollout[]).map(readRollout).sort(byAttention),
    [q.data],
  )
  const summary = useMemo(() => summariseRollouts(list), [list])

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading rollouts…
      </div>
    )
  }
  if (q.isError) {
    return (
      <EmptyState
        title="Couldn't reach Argo Rollouts"
        description={q.error instanceof Error
          ? q.error.message
          : 'The Rollout CRD could not be read from this cluster.'}
      />
    )
  }
  if (list.length === 0) {
    return (
      <EmptyState
        title="No Argo Rollouts"
        description="Nothing in this cluster uses a Rollout yet. A Rollout replaces a Deployment to get canary or blue/green delivery with analysis between the steps."
      />
    )
  }

  const visible = list.filter((r) => {
    if (phase && r.phase !== phase) return false
    const query = search.trim().toLowerCase()
    return !query || `${r.name} ${r.namespace}`.toLowerCase().includes(query)
  })

  const busy = (r: RolloutView) =>
    (promote.isPending && promote.variables?.name === r.name) ||
    (abort.isPending && abort.variables?.name === r.name) ||
    (retry.isPending && retry.variables?.name === r.name)

  const togglePhase = (p: RolloutPhase) => setPhase((cur) => (cur === p ? null : p))

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="Rollouts" value={summary.total} hint="in this cluster" />
        <Stat
          label="Degraded"
          value={summary.degraded}
          tone={summary.degraded ? 'failed' : undefined}
          hint="need a human"
          active={phase === 'Degraded'}
          onClick={() => togglePhase('Degraded')}
        />
        <Stat
          label="Paused"
          value={summary.paused}
          tone={summary.paused ? 'paused' : undefined}
          hint="waiting to be promoted"
          active={phase === 'Paused'}
          onClick={() => togglePhase('Paused')}
        />
        <Stat
          label="Progressing"
          value={summary.progressing}
          tone={summary.progressing ? 'progressing' : undefined}
          hint="mid-rollout"
          active={phase === 'Progressing'}
          onClick={() => togglePhase('Progressing')}
        />
        <Stat
          label="Healthy"
          value={summary.healthy}
          tone={summary.healthy ? 'healthy' : undefined}
          hint={summary.aborted ? `${summary.aborted} aborted` : 'fully rolled out'}
          active={phase === 'Healthy'}
          onClick={() => togglePhase('Healthy')}
        />
      </div>

      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Search rollout or namespace…"
        label="Search rollouts"
      />

      {visible.length === 0 ? (
        <EmptyState compact title="No matching rollouts" description="Relax the filters or the search." />
      ) : (
        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
          {visible.map((r) => (
            <RolloutCard
              key={r.key}
              rollout={r}
              busy={busy(r)}
              onPromote={(full) => promote.mutate({ namespace: r.namespace, name: r.name, full })}
              onAbort={() => abort.mutate({ namespace: r.namespace, name: r.name })}
              onRetry={() => retry.mutate({ namespace: r.namespace, name: r.name })}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function RolloutCard({
  rollout: r,
  busy,
  onPromote,
  onAbort,
  onRetry,
}: {
  rollout: RolloutView
  busy: boolean
  onPromote(full?: boolean): void
  onAbort(): void
  onRetry(): void
}) {
  const strategyLabel = r.strategy === 'canary'
    ? 'canary'
    : r.strategy === 'blueGreen'
    ? 'blue/green'
    : 'no strategy'

  return (
    <Card className={cn(r.aborted && 'border-rose-200/70 dark:border-rose-500/30')}>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold text-content">{r.name}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-content-subtle">
              <span>{r.namespace}</span>
              <span>· {strategyLabel}</span>
              {r.createdAt ? <span>· {formatRelative(r.createdAt)}</span> : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* An abort is the reason the phase says what it says, so it is
                stated rather than left to be inferred from Degraded. */}
            {r.aborted ? <StatusBadge kind="failed">Aborted</StatusBadge> : null}
            <StatusBadge kind={PHASE_KIND[r.phase]}>{r.phase}</StatusBadge>
          </div>
        </div>
      </CardHeader>

      <CardBody className="space-y-3">
        <ReplicaBar replicas={r.replicas} />

        {r.weights ? <TrafficSplit weights={r.weights} /> : null}

        {r.strategy === 'canary' ? (
          r.totalSteps ? (
            <StepLadder rollout={r} />
          ) : (
            <Note>This canary has no steps configured, so it rolls out in one move.</Note>
          )
        ) : r.strategy === 'blueGreen' ? (
          <Note>
            Blue/green — the new version runs on the preview service until it is promoted to take
            live traffic.
          </Note>
        ) : (
          <Note>No canary or blue/green strategy is set on this Rollout.</Note>
        )}

        {r.pausedReason ? (
          <div className="rounded-md border border-amber-200/70 bg-amber-50/60 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            Paused: {r.pausedReason}
          </div>
        ) : null}

        {r.message ? (
          <div
            className={cn(
              'rounded-md border px-3 py-2 text-[11px]',
              r.phase === 'Degraded'
                ? 'border-rose-200/70 bg-rose-50/60 text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200'
                : 'border-edge-subtle bg-surface-sunken/50 text-content-muted',
            )}
          >
            {r.message}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {/* Only the actions that can actually do something — see
              `rollout-state.ts`, where the rules are under test. */}
          {r.canPromote ? (
            <Button size="sm" onClick={() => onPromote(false)} loading={busy}>
              {r.strategy === 'blueGreen' ? 'Promote' : 'Promote next'}
            </Button>
          ) : null}
          {r.canPromoteFull ? (
            <Button size="sm" variant="secondary" onClick={() => onPromote(true)} loading={busy}>
              Skip to full
            </Button>
          ) : null}
          {r.canRetry ? (
            <Button size="sm" onClick={onRetry} loading={busy}>Retry</Button>
          ) : null}
          {r.canAbort ? (
            <Button size="sm" variant="danger" onClick={onAbort} loading={busy}>Abort</Button>
          ) : null}
          {!r.canPromote && !r.canPromoteFull && !r.canRetry && !r.canAbort ? (
            <span className="text-[11px] text-content-subtle">
              {r.fullyRolledOut ? 'Fully rolled out — nothing to do.' : 'No action available.'}
            </span>
          ) : null}
        </div>
      </CardBody>
    </Card>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-edge-subtle bg-surface-sunken/40 px-3 py-2 text-[11px] leading-relaxed text-content-muted">
      {children}
    </div>
  )
}

/**
 * How far the new version has actually got.
 *
 * A phase of Progressing says nothing about whether two replicas or twenty
 * have been replaced; these are the numbers the card was throwing away.
 */
function ReplicaBar({ replicas: p }: { replicas: RolloutView['replicas'] }) {
  const desired = Math.max(p.desired, p.current, 1)
  const pct = (n: number) => `${Math.min(100, (n / desired) * 100)}%`
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="font-semibold text-content-subtle">Replicas</span>
        <span className="font-mono tabular-nums text-content-muted">
          {p.updated}/{p.desired} updated · {p.available} available
        </span>
      </div>
      <div
        className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-surface-sunken"
        role="img"
        aria-label={`${p.updated} of ${p.desired} replicas updated, ${p.ready} ready, ${p.available} available`}
      >
        <span className="h-full bg-emerald-500" style={{ width: pct(Math.min(p.updated, p.available)) }} />
        <span className="h-full bg-indigo-400" style={{ width: pct(Math.max(0, p.updated - p.available)) }} />
      </div>
    </div>
  )
}

/** The split the canary is actually taking right now. */
function TrafficSplit({ weights }: { weights: { canary: number; stable: number } }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="font-semibold text-content-subtle">Traffic</span>
        <span className="font-mono tabular-nums text-content-muted">
          {weights.canary}% canary · {weights.stable}% stable
        </span>
      </div>
      <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-surface-sunken">
        <span className="h-full bg-brand-500" style={{ width: `${weights.canary}%` }} />
        <span className="h-full bg-slate-300 dark:bg-slate-600" style={{ width: `${weights.stable}%` }} />
      </div>
    </div>
  )
}

function StepLadder({ rollout: r }: { rollout: RolloutView }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="font-semibold text-content-subtle">Canary steps</span>
        <span className="font-mono tabular-nums text-content-muted">
          {Math.min(r.currentStep + 1, r.totalSteps)} / {r.totalSteps}
        </span>
      </div>
      <ol className="mt-1.5 grid gap-1" style={{ gridTemplateColumns: `repeat(${r.totalSteps}, minmax(0, 1fr))` }}>
        {r.steps.map((s, i) => {
          const paused = s.state === 'current' && r.phase === 'Paused'
          return (
            <li
              key={i}
              title={s.label}
              className={cn(
                'flex min-w-0 flex-col rounded-md border p-2',
                s.state === 'current'
                  ? paused
                    ? 'border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10'
                    : 'border-brand-400 bg-brand-50 dark:border-brand-500/40 dark:bg-brand-500/10'
                  : s.state === 'done'
                  ? 'border-emerald-200 bg-emerald-50/40 dark:border-emerald-500/30 dark:bg-emerald-500/10'
                  : 'border-edge-subtle bg-surface-sunken/40',
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  s.state === 'current'
                    ? paused ? 'bg-amber-500' : 'bg-brand-500'
                    : s.state === 'done'
                    ? 'bg-emerald-500'
                    : 'bg-content-subtle',
                )}
              />
              <span className="mt-1 font-mono text-[10px] text-content-subtle">step {i + 1}</span>
              <span className="truncate text-[11px] font-medium text-content">{s.label}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
  tone,
  active,
  onClick,
}: {
  label: string
  value: number | string
  hint?: string
  tone?: StatusKind
  active?: boolean
  onClick?(): void
}) {
  const toneText: Partial<Record<StatusKind, string>> = {
    healthy: 'text-emerald-600 dark:text-emerald-300',
    degraded: 'text-amber-600 dark:text-amber-300',
    failed: 'text-rose-600 dark:text-rose-300',
    paused: 'text-amber-600 dark:text-amber-300',
    progressing: 'text-indigo-600 dark:text-indigo-300',
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-pressed={onClick ? Boolean(active) : undefined}
      className={cn(
        'rounded-xl border px-3.5 py-3 text-left transition-colors',
        active
          ? 'border-brand-300 bg-brand-50/70 dark:border-brand-500/40 dark:bg-brand-500/10'
          : 'border-edge-default bg-surface-raised',
        onClick ? 'hover:border-edge-strong' : 'cursor-default',
      )}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</div>
      <div className={cn('mt-1 text-2xl font-semibold leading-none tabular-nums', tone ? toneText[tone] ?? 'text-content' : 'text-content')}>
        {value}
      </div>
      {hint ? <div className="mt-1 truncate text-[11px] text-content-subtle">{hint}</div> : null}
    </button>
  )
}

export default Rollouts
