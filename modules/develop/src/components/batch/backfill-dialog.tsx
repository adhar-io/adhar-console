import { useEffect, useMemo, useState } from 'react'
import { Button, canResource, Field, Input, Modal, Spinner, StatusBadge, useAccessReview, useToast } from '@adhar/shell-ui'
import { useRunTemplate } from '../../data/batch.ts'
import { type BatchJobXR, displayParam, JOBS_GVR, PHASE_BADGE, PHASE_LABEL, type RunRow } from '../../data/batch-model.ts'
import { BackfillReleaseError, useCreateBackfill, useReleaseBackfillRuns } from '../../data/batch-history.ts'
import {
  backfillDates,
  type BackfillItem,
  backfillPlan,
  backfillProgress,
  backfillState,
  businessDateField,
  MAX_BACKFILL_DATES,
  RELEASE_LOOP_START,
  type ReleaseLoop,
  releaseRetried,
  releaseSent,
  releaseSettled,
  releaseStep,
} from '../../data/batch-history-model.ts'
import { Note } from '../../views/function-bits.tsx'
import { type DialogFrame, ParamInput } from './dialogs.tsx'
import { TABLE, TD, TH } from './bits.tsx'

/**
 * Backfill (design 0025 §8.1, A3.3): one run per business date in a range, each
 * named for its identity like any run, so a backfill asked for twice finds its
 * runs and starts nothing twice. The plan, the queue and the release rule are
 * `adhar batch backfill`'s (`batch-history-model.ts`).
 *
 * How many run at once is this dialog's to enforce on the native path and the
 * queue's on Volcano's:
 *
 *   - native: every date's Job is created SUSPENDED and released in date order,
 *     never more than "at once" in flight. Releasing happens while this dialog is
 *     open; closed part way, the rest stay suspended, and the same backfill
 *     asked again (here or from the CLI) releases them.
 *   - Volcano: every run is created as it is and the job's queue decides.
 */

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const ACTION_LABEL: Record<BackfillItem['action'], string> = {
  create: 'will start',
  restart: 'will restart',
  exists: 'already there',
  completed: 'completed',
  stopped: 'stopped by someone',
}

/** A backfill under way: each date's run as it stands, and what is still queued. Rendered from data alone. */
export function BackfillProgressView({
  items,
  runs,
  parallel,
  volcano,
  released,
  onOpenRun,
}: {
  items: readonly BackfillItem[]
  runs: readonly RunRow[]
  parallel: number
  volcano: boolean
  released?: ReadonlySet<string>
  onOpenRun?(name: string): void
}) {
  const by = useMemo(() => new Map(runs.map((r) => [r.name, r])), [runs])
  const p = backfillProgress(items.map((i) => i.run), runs, parallel, volcano, released)
  return (
    <div className='space-y-3'>
      <p className='text-[13px] text-content' role='status'>
        {p.done} of {items.length} ended · {p.inFlight} in flight · {p.queued} queued{p.stopped ? ` · ${p.stopped} stopped` : ''}
        {p.gone ? ` · ${p.gone} no longer in the cluster` : ''}
      </p>
      {volcano ? <Note>This job runs on Volcano: every run was created at once and its queue decides how many start.</Note> : p.queued > 0
        ? (
          <Note>
            Queued runs are released here, in date order, at most {parallel}{' '}
            at a time. Close this and the rest stay suspended until the same backfill is asked again, here or with{' '}
            <span className='font-mono'>adhar batch backfill</span>.
          </Note>
        )
        : null}
      <div className='max-h-72 overflow-auto rounded-xl border border-edge-default bg-surface-raised'>
        <table className={TABLE}>
          <thead className='bg-surface-muted'>
            <tr>
              <th className={TH}>Business date</th>
              <th className={TH}>Run</th>
              <th className={TH}>Status</th>
            </tr>
          </thead>
          <tbody className='divide-y divide-edge-subtle'>
            {items.map((it) => {
              const r = by.get(it.run)
              const queued = r ? backfillState(r) === 'queued' && !released?.has(it.run) : false
              return (
                <tr key={it.businessDate}>
                  <td className={`${TD} font-mono`}>{it.businessDate}</td>
                  <td className={TD}>
                    {r && onOpenRun
                      ? (
                        <button type='button' className='font-mono text-brand-700 hover:underline dark:text-brand-300' onClick={() => onOpenRun(it.run)}>
                          {it.run}
                        </button>
                      )
                      : <span className='font-mono'>{it.run}</span>}
                  </td>
                  <td className={TD}>
                    {!r
                      ? <span className='text-content-subtle'>not in the cluster</span>
                      : queued
                      ? <StatusBadge kind='paused'>Queued</StatusBadge>
                      : <StatusBadge kind={PHASE_BADGE[r.phase]}>{PHASE_LABEL[r.phase]}</StatusBadge>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function BackfillDialog({
  job,
  runs,
  initial,
  onClose,
  onOpenRun,
  Frame = Modal,
}: {
  job: BatchJobXR
  /** The runs of this job the cluster holds, live: the plan and the release loop both read them. */
  runs: readonly RunRow[]
  /** The range the form opens on, when the caller already knows it. */
  initial?: { from?: string; to?: string; parallel?: number }
  onClose(): void
  onOpenRun?(name: string): void
  Frame?: DialogFrame
}) {
  const namespace = job.metadata.namespace ?? ''
  const name = job.metadata.name
  const read = useRunTemplate(namespace, name, job.status?.runTemplate)
  const template = read.data?.state === 'ok' ? read.data.template : undefined
  const dateField = template ? businessDateField(template.fields) : undefined
  const others = useMemo(() => (template?.fields ?? []).filter((f) => f.name !== dateField?.name), [template, dateField?.name])

  const [from, setFrom] = useState(initial?.from ?? '')
  const [to, setTo] = useState(initial?.to ?? '')
  const [parallelText, setParallelText] = useState(String(initial?.parallel ?? 1))
  const [extra, setExtra] = useState<Record<string, string>>({})
  const [started, setStarted] = useState<{ items: BackfillItem[]; volcano: boolean } | null>(null)
  const parallel = /^[1-9]\d{0,2}$/.test(parallelText) ? Number(parallelText) : 0

  const range = useMemo(() => (from && to ? backfillDates(from, to) : undefined), [from, to])
  const given = useMemo(() => Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== '')), [extra])
  const plan = useMemo(
    () => (template && range && 'dates' in range ? backfillPlan({ namespace, job: name }, template, range.dates, given, runs) : undefined),
    [template, range, given, runs, namespace, name],
  )
  const ready = plan && 'items' in plan ? plan : undefined
  const toStart = ready ? ready.items.filter((i) => i.action === 'create' || i.action === 'restart').length : 0
  const leftQueued = ready ? ready.items.some((i) => i.action === 'exists') : false

  // Releasing is a patch on each run; creating them does not prove the caller may.
  // Only a definite no blocks: an answer still on its way must not flash the warning in.
  const release = useAccessReview(canResource(JOBS_GVR, 'patch', { namespace }))
  const cannotRelease = Boolean(ready && !ready.volcano && release.results[0] === false)

  const create = useCreateBackfill()
  const releasing = useReleaseBackfillRuns()
  const toast = useToast()
  const [loop, setLoop] = useState<ReleaseLoop>(RELEASE_LOOP_START)

  // The release loop. It runs on every change of what `releaseStep` hands it
  // while the dialog is open, and only ever releases that; the rules (a failed
  // release frees its slot and halts, nothing while one is on its way) are the
  // model's, so they are tested without a renderer that runs effects.
  const batch = started ? releaseStep(started.items.map((i) => i.run), runs, parallel || 1, started.volcano, loop) : []
  const next = batch.map((r) => r.name).join(',')
  useEffect(() => {
    if (!batch.length) return
    const names = batch.map((r) => r.name)
    setLoop((l) => releaseSent(l, names))
    releasing.mutateAsync(batch).then(
      () => setLoop((l) => releaseSettled(l, {})),
      (e) => {
        setLoop((l) => releaseSettled(l, { error: errorText(e), releasedBefore: e instanceof BackfillReleaseError ? e.releasedBefore : [] }))
        toast.error('Could not release the next runs', { description: errorText(e) })
      },
    )
  }, [next])

  const submit = async () => {
    if (!template || !ready) return
    try {
      await create.mutateAsync({ namespace, template, items: ready.items, volcano: ready.volcano })
      toast.success(`Backfill of ${name}: ${toStart} ${toStart === 1 ? 'run' : 'runs'} created`)
      setStarted({ items: ready.items, volcano: ready.volcano })
    } catch (e) {
      toast.error(`Could not backfill ${name}`, { description: errorText(e) })
    }
  }

  return (
    <Frame
      open
      onClose={onClose}
      title={`Backfill ${name}`}
      description={`In ${namespace}: one run per business date, from the deployed run template.`}
      width='lg'
      footer={
        <div className='flex w-full items-center justify-between gap-2'>
          <span className='min-w-0 truncate text-[11px] text-content-subtle'>
            {started ? null : ready ? <>{ready.items.length} {ready.items.length === 1 ? 'date' : 'dates'} · {toStart} to start</> : null}
          </span>
          <div className='flex gap-2'>
            <Button variant='ghost' onClick={onClose}>{started ? 'Close' : 'Cancel'}</Button>
            {started ? null : (
              <Button
                variant='primary'
                onClick={submit}
                loading={create.isPending}
                disabled={!ready || !parallel || cannotRelease || (toStart === 0 && !leftQueued)}
              >
                {toStart === 0 && leftQueued ? 'Continue backfill' : 'Start backfill'}
              </Button>
            )}
          </div>
        </div>
      }
    >
      {read.isLoading
        ? (
          <div className='flex items-center gap-2 py-4 text-[13px] text-content-subtle' role='status'>
            <Spinner size={12} /> Reading the run template…
          </div>
        )
        : read.isError
        ? <Note tone='warn'>{errorText(read.error)}</Note>
        : read.data && read.data.state !== 'ok'
        ? <Note tone='warn'>{read.data.message}</Note>
        : started
        ? (
          <div className='space-y-3'>
            {loop.halted !== undefined
              ? (
                <Note tone='warn'>
                  Releasing stopped after a refusal ({loop.halted}). The runs not released stay queued until it is tried again.{' '}
                  <Button
                    size='sm'
                    variant='secondary'
                    onClick={() => setLoop(releaseRetried)}
                  >
                    Try again
                  </Button>
                </Note>
              )
              : null}
            <BackfillProgressView
              items={started.items}
              runs={runs}
              parallel={parallel || 1}
              volcano={started.volcano}
              released={loop.released}
              onOpenRun={onOpenRun}
            />
          </div>
        )
        : template && !dateField
        ? (
          <Note tone='warn'>
            {name}{' '}
            declares no business-date parameter (<span className='font-mono'>businessDate</span>, or a date its schedule supplies), so there is nothing to
            backfill by.
          </Note>
        )
        : template
        ? (
          <div className='space-y-4'>
            {template.paramsError ? <Note tone='warn'>{template.paramsError}</Note> : null}
            <div className='grid grid-cols-1 gap-3 sm:grid-cols-3'>
              <Field
                label='First business date *'
                hint={
                  <>
                    goes into <span className='font-mono'>{dateField?.name}</span>
                  </>
                }
              >
                <Input type='date' value={from} onChange={(e) => setFrom(e.target.value)} className='font-mono' />
              </Field>
              <Field label='Last business date *' hint='inclusive'>
                <Input type='date' value={to} onChange={(e) => setTo(e.target.value)} className='font-mono' />
              </Field>
              <Field label='At once' hint='runs in flight at a time' error={parallel ? undefined : 'A whole number, 1 or more.'}>
                <Input value={parallelText} onChange={(e) => setParallelText(e.target.value)} inputMode='numeric' className='font-mono' />
              </Field>
            </div>
            {others.length
              ? (
                <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
                  {others.map((f) => (
                    <Field
                      key={f.name}
                      label={
                        <span>
                          <span className='font-mono'>{f.name}</span>
                          {f.required ? ' *' : ''}
                        </span>
                      }
                      hint={[f.description, 'the same for every date', f.default !== undefined ? `default ${displayParam(f, f.default || '""')}` : null].filter(
                        Boolean,
                      ).join(' · ')}
                    >
                      <ParamInput
                        field={f}
                        value={extra[f.name] ?? ''}
                        onChange={(v) => setExtra((cur) => ({ ...cur, [f.name]: v }))}
                      />
                    </Field>
                  ))}
                </div>
              )
              : null}
            {range?.error ? <Note tone='warn'>{range.error}</Note> : null}
            {plan?.error ? <Note tone='warn'>{plan.error}</Note> : null}
            {!from || !to
              ? <Note>Up to {MAX_BACKFILL_DATES} dates. A date that already completed is left alone, and one that failed is restarted.</Note>
              : null}
            {ready ? <BackfillPreview items={ready.items} volcano={ready.volcano} parallel={parallel} /> : null}
            {cannotRelease
              ? (
                <Note tone='warn'>
                  Each run is created suspended and then released, which needs <span className='font-mono'>patch jobs</span> in{' '}
                  {namespace}. Your role does not cover that, so the runs would never start.
                </Note>
              )
              : null}
            {create.isError
              ? (
                <Note tone='warn'>
                  {errorText(create.error)} Runs created before this are in the cluster, suspended; asking for the same backfill again continues it.
                </Note>
              )
              : null}
          </div>
        )
        : null}
    </Frame>
  )
}

/** What a backfill is about to do, before anything is created. */
export function BackfillPreview({ items, volcano, parallel }: { items: readonly BackfillItem[]; volcano: boolean; parallel: number }) {
  const count = (a: BackfillItem['action']) => items.filter((i) => i.action === a).length
  const parts = [
    [count('create'), 'to start'],
    [count('restart'), 'to restart (failed before)'],
    [count('completed'), 'already completed'],
    [count('exists'), 'already there'],
    [count('stopped'), 'stopped by someone, left alone'],
  ].filter(([n]) => (n as number) > 0).map(([n, what]) => `${n} ${what}`)
  return (
    <div className='space-y-2'>
      <p className='text-[13px] text-content'>{items.length} {items.length === 1 ? 'date' : 'dates'}: {parts.join(' · ')}.</p>
      {volcano && parallel > 1
        ? <Note>This job runs on Volcano: every run is created now and its queue decides how many start. “At once” is not applied.</Note>
        : null}
      <div className='max-h-56 overflow-auto rounded-xl border border-edge-default bg-surface-raised'>
        <table className={TABLE}>
          <thead className='bg-surface-muted'>
            <tr>
              <th className={TH}>Business date</th>
              <th className={TH}>Run</th>
              <th className={TH}>This backfill</th>
            </tr>
          </thead>
          <tbody className='divide-y divide-edge-subtle'>
            {items.map((it) => (
              <tr key={it.businessDate}>
                <td className={`${TD} font-mono`}>{it.businessDate}</td>
                <td className={`${TD} font-mono`}>{it.run}</td>
                <td className={TD}>
                  {ACTION_LABEL[it.action]}
                  {it.restartOf ? <span className='text-content-subtle'>{` (continues ${it.restartOf})`}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
