import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, EmptyState, Skeleton, useCan, useOverlayDismiss, useToast, DrawerWidenButton, useDrawerWidth } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import { useAbortRollout, usePromoteRollout, useRetryRollout } from '../data/delivery.ts'
import { rolloutControlChecks } from '../data/access.ts'
import { attentionNote, envLabel, type RolloutApp, type RolloutEnv } from '../data/rollout-apps.ts'
import {
  type ArgoHistoryLike,
  canUndoInConsole,
  deriveHistory,
  formatDuration,
  type HistoryEntry,
  type RolloutLike,
  undoCommand,
} from '../data/rollout-history.ts'
import {
  errorStatus,
  useCanPatchRollout,
  useRolloutHistorySources,
  useUndoRollout,
} from '../data/rollout-queries.ts'
import {
  AnalysisPill,
  ConfirmDialog,
  IconChevron,
  IconClose,
  IconCopy,
  IconRollback,
  Note,
  OutcomePill,
  PhasePill,
  ReplicaBar,
  StepLadder,
  strategyLabel,
  TrafficSplit,
} from './rollouts-parts.tsx'

/**
 * One application's rollouts: an environment switcher, the CURRENT rollout of
 * the chosen environment in full (step ladder, traffic, replicas, analysis,
 * actions), and every earlier revision as a compact timeline below it.
 */

export interface ArgoAppHistory {
  name: string
  history: ArgoHistoryLike[]
}

export function RolloutDetail({
  app,
  env,
  argoApps,
  onEnv,
  onClose,
}: {
  app: RolloutApp
  env: RolloutEnv
  argoApps: ArgoAppHistory[]
  onEnv(env: RolloutEnv): void
  onClose(): void
}) {
  const width = useDrawerWidth('deliver.rollout', { base: 'max-w-3xl' })
  useOverlayDismiss(true, onClose)
  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label={`${app.app} rollouts`}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" onClick={onClose} />
      <aside className={cn('relative flex h-full w-full min-w-0 flex-col overflow-hidden border-l border-edge-default bg-surface-canvas shadow-2xl', width.className)}>
        <header className="border-b border-edge-default bg-surface-raised px-4 pt-4 sm:px-6">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
                Rollouts · {app.scope}
              </div>
              <h2 className="mt-1 truncate text-lg font-semibold tracking-tight text-content">{app.app}</h2>
              <div className="mt-0.5 text-[12px] text-content-muted">
                {strategyLabel(app.strategy)} · {app.envs.length} environment{app.envs.length === 1 ? '' : 's'}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <DrawerWidenButton wide={width.wide} onToggle={width.toggle} />
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
              >
                <IconClose className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Environment switcher — dev → test → prod, each with its state. */}
          <div role="tablist" aria-label="Environment" className="-mx-1 mt-3 flex gap-1 overflow-x-auto px-1">
            {app.envs.map((e) => {
              const active = e.id === env.id
              return (
                <button
                  key={e.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => onEnv(e)}
                  className={cn(
                    'flex shrink-0 items-center gap-2 border-b-2 px-3 pb-2.5 pt-1.5 text-[13px] font-medium transition-colors',
                    active
                      ? 'border-brand-600 text-content dark:border-brand-400'
                      : 'border-transparent text-content-muted hover:text-content',
                  )}
                >
                  {envLabel(app, e)}
                  <PhasePill phase={e.view.phase} aborted={e.view.aborted} className="px-1.5 text-[11px]" />
                </button>
              )
            })}
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
          <CurrentRollout key={env.id} env={env} />
          <History env={env} argoApps={argoApps} />
        </div>
      </aside>
    </div>,
    document.body,
  )
}

/* ─────────── current ─────────── */

type Pending = 'promote-full' | 'abort' | null

function CurrentRollout({ env }: { env: RolloutEnv }) {
  const r = env.view
  const toast = useToast()
  const promote = usePromoteRollout()
  const abort = useAbortRollout()
  const retry = useRetryRollout()
  const [confirm, setConfirm] = useState<Pending>(null)
  const target = { namespace: env.namespace, name: env.name }

  const run = (label: string, p: Promise<unknown>, done: string) =>
    p.then(
      () => toast.success(done),
      (e) => toast.error(`${label} failed`, { description: e instanceof Error ? e.message : String(e) }),
    ).finally(() => setConfirm(null))

  const busy = promote.isPending || abort.isPending || retry.isPending
  // RBAC: the controls patch the Rollout and its status — hidden without both.
  const canControl = useCan(rolloutControlChecks(env.namespace, env.name))
  // Open the conditions only when they are the explanation: a degraded rollout.
  const failing = r.phase === 'Degraded' ? env.conditions.filter((c) => c.status !== 'True' && c.message) : []

  return (
    <section aria-label="Current rollout" className="rounded-xl border border-edge-default bg-surface-raised shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-edge-subtle px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-content">Current rollout</h3>
            <PhasePill phase={r.phase} aborted={r.aborted} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-content-subtle">
            {env.tag ? <span className="max-w-56 truncate font-mono text-content" title={env.images[0]?.image}>{env.tag}</span> : null}
            {env.revision ? <span>· rev {env.revision}</span> : null}
            <span>· {env.namespace}/{env.name}</span>
            {attentionNote(env) ? <span className="text-content-muted">· {attentionNote(env)}</span> : null}
          </div>
        </div>
        {/* Only the actions that can do something — rules in rollout-state.ts. */}
        {canControl ? (
        <div className="flex flex-wrap items-center gap-2">
          {r.canPromote ? (
            <Button
              size="sm"
              variant="primary"
              loading={promote.isPending && !promote.variables?.full}
              disabled={busy}
              onClick={() => run('Promote', promote.mutateAsync({ ...target, full: false }), r.strategy === 'blueGreen' ? 'Promoted' : 'Promoted to the next step')}
            >
              {r.strategy === 'blueGreen' ? 'Promote' : 'Promote next'}
            </Button>
          ) : null}
          {r.canPromoteFull ? (
            <Button size="sm" disabled={busy} onClick={() => setConfirm('promote-full')}>Promote full</Button>
          ) : null}
          {r.canRetry ? (
            <Button
              size="sm"
              variant="primary"
              loading={retry.isPending}
              disabled={busy}
              onClick={() => run('Retry', retry.mutateAsync(target), 'Rollout restarted')}
            >
              Retry
            </Button>
          ) : null}
          {r.canAbort ? (
            <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirm('abort')}>Abort</Button>
          ) : null}
        </div>
        ) : null}
      </div>

      <div className="space-y-4 px-4 py-4">
        <ReplicaBar replicas={r.replicas} />
        {r.weights ? <TrafficSplit weights={r.weights} /> : null}

        {r.strategy === 'canary'
          ? r.totalSteps
            ? <StepLadder rollout={r} />
            : <Note>This canary has no steps configured, so it rolls out in one move.</Note>
          : r.strategy === 'blueGreen'
          ? <Note>Blue/green — the new version runs on the preview service until it is promoted to take live traffic.</Note>
          : <Note>No canary or blue/green strategy is set on this Rollout.</Note>}

        {env.analysis.length ? (
          <div>
            <div className="text-[11px] font-semibold text-content-subtle">Analysis</div>
            <ul className="mt-1.5 space-y-1.5">
              {env.analysis.map((a) => (
                <li key={a.name} className="flex flex-wrap items-center gap-2 text-[12px]">
                  <AnalysisPill phase={a.status} />
                  <span className="min-w-0 truncate font-mono text-content">{a.name}</span>
                  <span className="text-content-subtle">{a.kind}</span>
                  {a.message ? <span className="w-full text-[11px] text-content-muted">{a.message}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {r.pausedReason ? <Note tone="warn">{pauseText(r.pausedReason)}</Note> : null}
        {r.message && r.message !== r.pausedReason ? <Note tone={r.phase === 'Degraded' || r.aborted ? 'error' : 'neutral'}>{r.message}</Note> : null}

        {env.conditions.length ? (
          <details className="group text-[12px]" open={failing.length > 0}>
            <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] font-semibold text-content-subtle hover:text-content">
              <IconChevron className="h-3 w-3 transition-transform group-open:rotate-90" />
              Conditions ({env.conditions.length})
            </summary>
            <ul className="mt-2 divide-y divide-edge-subtle rounded-md border border-edge-subtle">
              {env.conditions.map((c) => (
                <li key={c.type} className="flex flex-wrap items-baseline gap-x-2 px-3 py-1.5">
                  <span className={cn('font-medium', c.status === 'True' ? 'text-content' : 'text-amber-700 dark:text-amber-300')}>{c.type}</span>
                  <span className="font-mono text-[11px] text-content-subtle">{c.status}{c.reason ? ` · ${c.reason}` : ''}</span>
                  {c.lastTransitionTime ? <span className="ml-auto text-[11px] text-content-subtle">{formatRelative(c.lastTransitionTime)}</span> : null}
                  {c.message ? <span className="w-full text-[11px] text-content-muted">{c.message}</span> : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirm === 'promote-full'}
        title={`Promote ${env.name} fully?`}
        confirmLabel="Promote full"
        busy={promote.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => run('Promote full', promote.mutateAsync({ ...target, full: true }), 'Promoted to 100%')}
      >
        <p>
          Skips every remaining step and analysis in <span className="font-mono text-content">{env.env}</span> and sends all traffic to
          {env.tag ? <> <span className="font-mono text-content">{env.tag}</span></> : ' the new version'} now.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'abort'}
        title={`Abort ${env.name}?`}
        confirmLabel="Abort rollout"
        danger
        busy={abort.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => run('Abort', abort.mutateAsync(target), 'Rollout aborted — traffic is back on stable')}
      >
        <p>
          Traffic in <span className="font-mono text-content">{env.env}</span> goes back to the stable version and the canary is scaled down.
          Retry restarts it from the first step.
        </p>
      </ConfirmDialog>
    </section>
  )
}

/** Argo's pause reasons, in words. */
function pauseText(reason: string): string {
  switch (reason) {
    case 'CanaryPauseStep':
      return 'Paused at a pause step — waiting to be promoted.'
    case 'BlueGreenPause':
      return 'The new version is on the preview service — waiting to be promoted.'
    case 'InconclusiveAnalysisRun':
    case 'InconclusiveAnalysis':
      return 'Paused: analysis was inconclusive — promote to continue or abort.'
    case 'PausedByUser':
    case 'RolloutPausedByUser':
      return 'Paused by a user.'
    default:
      return `Paused: ${reason}`
  }
}

/* ─────────── history ─────────── */

function History({ env, argoApps }: { env: RolloutEnv; argoApps: ArgoAppHistory[] }) {
  const src = useRolloutHistorySources(env.namespace)
  const argoHistory = useMemo(
    () => argoApps.find((a) => a.name === env.argoApp)?.history ?? [],
    [argoApps, env.argoApp],
  )
  const entries = useMemo(
    () =>
      deriveHistory({
        rollout: env.raw as unknown as RolloutLike,
        replicaSets: src.replicaSets,
        analysisRuns: src.analysisRuns,
        argoHistory,
      }),
    [env.raw, src.replicaSets, src.analysisRuns, argoHistory],
  )
  const [open, setOpen] = useState<string | null>(null)

  return (
    <section aria-label="History">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-content">History</h3>
        {entries.length ? (
          <span className="text-[11px] text-content-subtle">{entries.length} revision{entries.length === 1 ? '' : 's'} kept by the cluster</span>
        ) : null}
      </div>

      {src.loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => <Skeleton key={i} height={52} className="block w-full" />)}
        </div>
      ) : src.error ? (
        <Note tone={errorStatus(src.error) === 403 ? 'warn' : 'error'}>
          {errorStatus(src.error) === 403
            ? `You don't have permission to list ReplicaSets in ${env.namespace}, so this rollout's history can't be read.`
            : `Couldn't read ReplicaSets in ${env.namespace}: ${src.error instanceof Error ? src.error.message : String(src.error)}`}
        </Note>
      ) : entries.length === 0 ? (
        <EmptyState compact title="No revisions recorded" description="The cluster keeps no ReplicaSets for this Rollout yet." />
      ) : (
        <>
          {src.analysisUnavailable !== undefined ? (
            <div className="mb-2">
              <Note>
                {src.analysisUnavailable === 403
                  ? 'AnalysisRuns are hidden — you lack permission to list them here.'
                  : 'AnalysisRuns could not be read, so analysis results are not shown.'}
              </Note>
            </div>
          ) : null}
          <ol className="relative space-y-2">
            {entries.map((e) => (
              <HistoryRow
                key={e.replicaSet}
                env={env}
                entry={e}
                open={open === e.replicaSet}
                onToggle={() => setOpen((cur) => (cur === e.replicaSet ? null : e.replicaSet))}
              />
            ))}
          </ol>
        </>
      )}
    </section>
  )
}

const OUTCOME_RAIL: Record<HistoryEntry['outcome'], string> = {
  live: 'bg-emerald-500',
  'in-flight': 'bg-indigo-500',
  stable: 'bg-sky-500',
  superseded: 'bg-edge-strong',
  aborted: 'bg-rose-500',
  degraded: 'bg-rose-400',
}

function HistoryRow({ env, entry: e, open, onToggle }: { env: RolloutEnv; entry: HistoryEntry; open: boolean; onToggle(): void }) {
  const primary = e.images[0]
  const timing = e.current
    ? e.rolledOutMs !== undefined ? `rolled out in ${formatDuration(e.rolledOutMs)}` : undefined
    : e.servedMs !== undefined
    ? `served ${formatDuration(e.servedMs)}`
    : e.rolledOutMs !== undefined
    ? `rolled out in ${formatDuration(e.rolledOutMs)}`
    : undefined
  const failed = e.analyses.filter((a) => a.phase === 'Failed' || a.phase === 'Error').length

  return (
    <li className="relative overflow-hidden rounded-lg border border-edge-default bg-surface-raised">
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-1', OUTCOME_RAIL[e.outcome])} />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 py-2.5 pl-4 pr-3 text-left hover:bg-surface-sunken/40"
      >
        <span className="w-12 shrink-0 font-mono text-[12px] font-semibold text-content">rev {e.revision}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
          <span className="flex flex-wrap items-center gap-1.5">
            <OutcomePill outcome={e.outcome} />
            {e.current ? <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">current</span> : null}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] text-content-subtle">
            {primary ? <span className="max-w-48 truncate font-mono text-content-muted" title={primary.image}>{primary.tag}</span> : null}
            {e.createdAt ? <span title={new Date(e.createdAt).toLocaleString()}>{formatRelative(e.createdAt)}</span> : null}
            {timing ? <span>· {timing}</span> : null}
            {e.analyses.length ? (
              <span className={failed ? 'text-rose-600 dark:text-rose-300' : undefined}>
                · {e.analyses.length} {e.analyses.length === 1 ? 'analysis' : 'analyses'}{failed ? `, ${failed} failed` : ''}
              </span>
            ) : null}
          </span>
        </span>
        <IconChevron className={cn('h-4 w-4 text-content-subtle transition-transform', open && 'rotate-90')} />
      </button>
      {open ? <HistoryDetail env={env} entry={e} /> : null}
    </li>
  )
}

function HistoryDetail({ env, entry: e }: { env: RolloutEnv; entry: HistoryEntry }) {
  const toast = useToast()
  const undo = useUndoRollout()
  const canUndo = canUndoInConsole(env.raw as unknown as RolloutLike, e)
  const access = useCanPatchRollout(canUndo ? env.namespace : undefined, env.name)
  const [confirm, setConfirm] = useState(false)
  const cmd = undoCommand(env.namespace, env.name, e.revision)

  const copy = (text: string) =>
    navigator.clipboard?.writeText(text).then(() => toast.success('Command copied'), () => toast.error('Could not copy'))

  const rollback = () =>
    undo.mutateAsync({ namespace: env.namespace, name: env.name, template: e.template! }).then(
      () => toast.success(`Rolling back ${env.env} to rev ${e.revision}`, { description: 'A new revision starts with this template.' }),
      (err) => toast.error('Rollback failed', { description: err instanceof Error ? err.message : String(err) }),
    ).finally(() => setConfirm(false))

  const facts: Array<[string, React.ReactNode]> = [
    ['Pod-template hash', e.hash ? <span key="hash" className="font-mono">{e.hash}</span> : '—'],
    ['ReplicaSet', <span key="rs" className="break-all font-mono">{e.replicaSet}</span>],
    ['Created', e.createdAt ? new Date(e.createdAt).toLocaleString() : '—'],
    ['Replicas', `${e.replicas.available}/${e.replicas.desired} available`],
  ]
  // Only a revision that reached stable was "rolled out"; say so when the cluster did not date it.
  if (e.outcome === 'live' || e.outcome === 'stable' || e.outcome === 'superseded') {
    facts.push(['Rolled out in', formatDuration(e.rolledOutMs) ?? 'not recorded'])
  }
  if (e.replacedAt) facts.push(['Replaced', `${formatRelative(e.replacedAt)}${e.servedMs !== undefined ? ` · after ${formatDuration(e.servedMs)}` : ''}`])
  if (e.trigger) {
    facts.push([
      'Triggered by',
      <span key="trigger">
        <span className="font-mono">{e.trigger.shortRevision}</span>
        {e.trigger.by ? ` · ${e.trigger.by}` : e.trigger.automated ? ' · auto-sync' : ''}
      </span>,
    ])
  }
  if (e.reusedFrom.length) facts.push(['Earlier as', e.reusedFrom.map((n) => `rev ${n}`).join(', ')])

  return (
    <div className="space-y-3 border-t border-edge-subtle py-3 pl-4 pr-3 text-[12px]">
      <p className="text-content-muted">{e.outcomeReason}</p>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {facts.map(([k, v]) => (
          <div key={k} className="flex min-w-0 gap-2">
            <dt className="w-28 shrink-0 text-content-subtle">{k}</dt>
            <dd className="min-w-0 text-content">{v}</dd>
          </div>
        ))}
      </dl>

      <div>
        <div className="text-[11px] font-semibold text-content-subtle">Images</div>
        <ul className="mt-1 space-y-0.5">
          {e.images.map((i) => (
            <li key={i.container} className="flex min-w-0 gap-2">
              <span className="shrink-0 text-content-subtle">{i.container}</span>
              <span className="min-w-0 break-all font-mono text-content">{i.image}</span>
            </li>
          ))}
        </ul>
        {!e.current ? (
          <div className="mt-1.5 text-[11px] text-content-muted">
            {e.diff.length === 0
              ? 'Same images as the current revision — only the pod spec differs.'
              : (
                <span>
                  vs current:{' '}
                  {e.diff.map((d, n) => (
                    <span key={d.container}>
                      {n ? '; ' : ''}
                      {d.container}{' '}
                      <span className="font-mono">{d.entry?.tag ?? 'absent'}</span>
                      {' → current '}
                      <span className="font-mono">{d.current?.tag ?? 'absent'}</span>
                    </span>
                  ))}
                </span>
              )}
          </div>
        ) : null}
      </div>

      {e.analyses.length ? (
        <div>
          <div className="text-[11px] font-semibold text-content-subtle">Analysis runs</div>
          <ul className="mt-1.5 space-y-2">
            {e.analyses.map((a) => (
              <li key={a.name} className="rounded-md border border-edge-subtle p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <AnalysisPill phase={a.phase} />
                  <span className="min-w-0 break-all font-mono text-content">{a.name}</span>
                  <span className="text-[11px] text-content-subtle">
                    {[a.type, a.step !== undefined ? `step ${a.step + 1}` : undefined].filter(Boolean).join(' · ')}
                  </span>
                  {a.finishedAt ? <span className="ml-auto text-[11px] text-content-subtle">{formatRelative(a.finishedAt)}</span> : null}
                </div>
                {a.message ? <div className="mt-1 text-[11px] text-content-muted">{a.message}</div> : null}
                {a.metrics.length ? (
                  <ul className="mt-2 divide-y divide-edge-subtle">
                    {a.metrics.map((m) => (
                      <li key={m.name} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1">
                        <span className="min-w-0 flex-1 truncate font-medium text-content">{m.name}</span>
                        <span className="font-mono text-[11px] tabular-nums text-content-muted">
                          {m.successful}✓ {m.failed}✗{m.inconclusive ? ` ${m.inconclusive}?` : ''}{m.error ? ` ${m.error} err` : ''}
                        </span>
                        {m.lastValue ? <span className="max-w-40 truncate font-mono text-[11px] text-content-subtle" title={m.lastValue}>last {m.lastValue}</span> : null}
                        <AnalysisPill phase={m.phase} />
                        {m.message ? <span className="w-full text-[11px] text-content-muted">{m.message}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!e.current ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-edge-subtle pt-3">
          {canUndo && access.data ? (
            <Button size="sm" leading={<IconRollback />} onClick={() => setConfirm(true)}>
              Roll back to rev {e.revision}
            </Button>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-edge-subtle bg-surface-sunken/60 px-2 py-1.5 font-mono text-[11px] text-content" title={cmd}>
                {cmd}
              </code>
              <Button size="sm" variant="ghost" leading={<IconCopy />} onClick={() => copy(cmd)} aria-label="Copy rollback command">
                <span className="hidden sm:inline">Copy</span>
              </Button>
            </div>
          )}
          {!(canUndo && access.data) && !access.isLoading ? (
            <span className="w-full text-[11px] text-content-subtle">
              {canUndo ? 'You can\'t patch this Rollout — run the command with access that can.' : 'Roll back from a terminal.'}
            </span>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirm}
        title={`Roll ${env.env} back to rev ${e.revision}?`}
        confirmLabel="Roll back"
        danger
        busy={undo.isPending}
        onClose={() => setConfirm(false)}
        onConfirm={rollback}
      >
        <p>
          Puts the pod template of rev {e.revision}
          {e.images[0] ? <> (<span className="font-mono text-content">{e.images[0].tag}</span>)</> : null} back on{' '}
          <span className="font-mono text-content">{env.namespace}/{env.name}</span>. It rolls out as a new revision through the
          same steps and analysis.
        </p>
        {env.argoApp ? (
          <p className="text-amber-700 dark:text-amber-300">
            {env.argoApp} is managed by Argo CD: with self-heal on, the next sync reverts this. Promote the earlier freight or revert in Git
            to make it stick.
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}
