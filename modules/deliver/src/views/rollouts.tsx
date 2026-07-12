import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import type { argoRollouts } from '@adhar-console/api-clients'
import {
  useAbortRollout,
  usePromoteRollout,
  useRollouts,
} from '../data/delivery.ts'

const PHASE_KIND: Record<string, StatusKind> = {
  Healthy: 'healthy',
  Progressing: 'progressing',
  Degraded: 'degraded',
  Paused: 'paused',
}

/**
 * Argo Rollouts — canary/blue-green progress with promote / abort actions
 * surfaced inline. Each card shows the strategy, the step ladder, and the
 * pause reason if any.
 */
export function Rollouts() {
  const q = useRollouts()
  const promote = usePromoteRollout()
  const abort = useAbortRollout()

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading rollouts…
      </div>
    )
  }
  if (q.isError) {
    return <EmptyState title="Couldn't reach Argo Rollouts" />
  }

  const list = (q.data ?? []) as argoRollouts.Rollout[]
  if (list.length === 0) {
    return <EmptyState title="No Argo Rollouts" description="No Rollout resources in any namespace yet." />
  }

  const paused = list.filter((r) => r.status.phase === 'Paused').length
  const progressing = list.filter((r) => r.status.phase === 'Progressing').length

  return (
    <div className="space-y-4">
      <div className="text-[11px] text-content-muted">
        {list.length} rollouts · {progressing} progressing · {paused} paused
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {list.map((r) => (
          <RolloutCard
            key={`${r.metadata.namespace}/${r.metadata.name}`}
            rollout={r}
            onPromote={(full) =>
              promote.mutate({
                namespace: r.metadata.namespace,
                name: r.metadata.name,
                full,
              })
            }
            onAbort={() => abort.mutate({ namespace: r.metadata.namespace, name: r.metadata.name })}
            promoteBusy={
              promote.isPending && promote.variables?.name === r.metadata.name
            }
            abortBusy={abort.isPending && abort.variables?.name === r.metadata.name}
          />
        ))}
      </div>
    </div>
  )
}

function RolloutCard({
  rollout: r,
  onPromote,
  onAbort,
  promoteBusy,
  abortBusy,
}: {
  rollout: argoRollouts.Rollout
  onPromote(full?: boolean): void
  onAbort(): void
  promoteBusy: boolean
  abortBusy: boolean
}) {
  const phase = r.status.phase ?? 'Unknown'
  const tone = PHASE_KIND[phase] ?? 'unknown'
  const isCanary = !!r.spec.strategy?.canary
  const steps = (r.spec.strategy?.canary?.steps ?? []) as Array<Record<string, unknown>>
  const cur = r.status.currentStepIndex ?? 0
  const isPaused = phase === 'Paused'

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-content">{r.metadata.name}</div>
            <div className="text-[11px] text-content-subtle">
              {r.metadata.namespace} · {isCanary ? 'canary' : r.spec.strategy?.blueGreen ? 'blue/green' : '—'}
            </div>
          </div>
          <StatusBadge kind={tone}>{phase}</StatusBadge>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        {isCanary ? (
          <StepLadder steps={steps} current={cur} paused={isPaused} />
        ) : (
          <div className="rounded-md border border-edge-subtle bg-surface-sunken/40 p-3 text-[11px] text-content-muted">
            Blue/green deployment — preview service awaiting cutover.
          </div>
        )}

        {r.status.message ? (
          <div className="rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-[11px] text-amber-900">
            {r.status.message}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => onPromote(false)}
            disabled={!isPaused && phase !== 'Progressing'}
            loading={promoteBusy}
          >
            Promote next
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onPromote(true)}
            disabled={!isCanary}
            loading={promoteBusy}
          >
            Promote full
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={onAbort}
            loading={abortBusy}
            disabled={phase === 'Healthy' && cur >= steps.length}
          >
            Abort
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}

function StepLadder({
  steps,
  current,
  paused,
}: {
  steps: Array<Record<string, unknown>>
  current: number
  paused: boolean
}) {
  if (steps.length === 0) {
    return (
      <div className="rounded-md border border-edge-subtle bg-surface-sunken/40 p-3 text-[11px] text-content-muted">
        Strategy has no canary steps configured.
      </div>
    )
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="font-semibold text-content-subtle">Canary steps</span>
        <span className="font-mono tabular-nums text-content-muted">
          {Math.min(current + 1, steps.length)} / {steps.length}
        </span>
      </div>
      <ol className="grid gap-1" style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }}>
        {steps.map((s, i) => {
          const cleared = i < current
          const live = i === current
          const label = describeStep(s)
          return (
            <li
              key={i}
              className={
                live
                  ? `flex flex-col rounded-md border ${paused ? 'border-amber-300 bg-amber-50' : 'border-brand-400 bg-brand-50'} p-2`
                  : cleared
                    ? 'flex flex-col rounded-md border border-emerald-200 bg-emerald-50/40 p-2'
                    : 'flex flex-col rounded-md border border-edge-subtle bg-surface-sunken/40 p-2'
              }
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  live ? (paused ? 'bg-amber-500' : 'bg-brand-500') : cleared ? 'bg-emerald-500' : 'bg-content-subtle'
                }`}
              />
              <span className="mt-1 text-[10px] font-mono text-content-subtle">step {i + 1}</span>
              <span className="text-[11px] font-medium text-content">{label}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function describeStep(s: Record<string, unknown>): string {
  if ('setWeight' in s) return `setWeight ${s.setWeight}%`
  if ('pause' in s) {
    const p = s.pause as { duration?: string } | null
    return p?.duration ? `pause ${p.duration}` : 'pause ∞'
  }
  if ('analysis' in s) return 'analysis'
  if ('experiment' in s) return 'experiment'
  if ('setCanaryScale' in s) return 'scale canary'
  if ('plugin' in s) return 'plugin'
  return Object.keys(s)[0] ?? '—'
}

export default Rollouts
