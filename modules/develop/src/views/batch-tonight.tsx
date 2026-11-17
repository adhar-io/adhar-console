import { type ReactNode, useMemo, useState } from 'react'
import { Button, EmptyState, Modal, Spinner, StatusBadge, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { useBatchGate, useRunTemplate } from '../data/batch.ts'
import { batchRef, type BatchJobXR, dateInZone, PHASE_BADGE, PHASE_LABEL, runKindOfJob, type RunRow } from '../data/batch-model.ts'
import { useBatchHistory, useCalendars, useReplayDeadLetters } from '../data/batch-history.ts'
import {
  type BatchEvent,
  type CalendarRow,
  calendarRows,
  type CalendarVerdict,
  type Chain,
  dependencyChains,
  dlqByJob,
  dlqEntries,
  type DlqEntry,
  type DlqJob,
  durationWords,
  type HistoryRead,
  replayPlan,
  type TonightRow,
  tonightRows,
} from '../data/batch-history-model.ts'
import { TABLE, TD, TH, Until, When } from '../components/batch/bits.tsx'
import type { DialogFrame } from '../components/batch/dialogs.tsx'
import { Note, Section } from './function-bits.tsx'

/**
 * Develop → Batch → Tonight (design 0025 §7.2): what the next 24 hours hold.
 *
 * Four things an operator reads before going home, on one page:
 *
 *   - the FORECAST: every fire of every schedule, with the calendar applied
 *     (a date that is not a business day still starts, and exits 0 as skipped —
 *     D5), its expected end (start + the p90 of its last successes, the batch
 *     observer's percentile) and whether that end is inside `sla.finishBy`;
 *   - the dependency CHAINS: which jobs wait for which, and whether what they
 *     wait for has succeeded;
 *   - the DEAD-LETTER queue: counts per job, as the runs reported them, and a
 *     replay through an ops Job — the Job `adhar batch dlq --replay` creates;
 *   - the CALENDARS those schedules follow.
 *
 * The forecast's history comes from `/api/batch/history`. Without it the page
 * still forecasts from the runs the cluster holds, and says which it used:
 * "no estimate" is never drawn as "on time".
 */

/** How far back the forecast and the dead-letter counts read the event stream. */
const HISTORY_SINCE = '30d'
const HISTORY_LIMIT = 5_000

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const clock = (ms: number, timeZone?: string) => {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}) }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString().slice(11, 16)
  }
}

export function BatchTonight({
  jobs,
  runs,
  envByNamespace,
  now,
  onOpenJob,
  onOpenRun,
}: {
  jobs: readonly BatchJobXR[]
  runs: readonly RunRow[]
  envByNamespace?: ReadonlyMap<string, string>
  now: number
  onOpenJob?(namespace: string, name: string): void
  onOpenRun?(namespace: string, name: string): void
}) {
  const history = useBatchHistory({ since: HISTORY_SINCE, limit: HISTORY_LIMIT })
  const namespaces = useMemo(() => [...new Set(jobs.map((j) => j.metadata.namespace ?? ''))].filter(Boolean).sort(), [jobs])
  const calendars = useCalendars(namespaces)
  const [replay, setReplay] = useState<DlqEntry | null>(null)
  const replayJob = replay ? jobs.find((j) => (j.metadata.namespace ?? '') === replay.namespace && j.metadata.name === replay.job) : undefined
  return (
    <>
      <TonightView
        jobs={jobs}
        runs={runs}
        history={history.data}
        historyError={history.error}
        calendars={calendars.calendars}
        unreadCalendars={calendars.unread}
        envByNamespace={envByNamespace}
        now={now}
        onOpenJob={onOpenJob}
        onOpenRun={onOpenRun}
        replayAction={(entry) => <ReplayButton entry={entry} jobs={jobs} onReplay={setReplay} />}
      />
      {replay
        ? <ReplayDialog entry={replay} job={replayJob} runs={runs} onClose={() => setReplay(null)} onOpenRun={(name) => onOpenRun?.(replay.namespace, name)} />
        : null}
    </>
  )
}

/** The whole page, from data: separate from the hooks so every state renders in a test. */
export function TonightView({
  jobs,
  runs,
  history,
  historyError,
  calendars,
  unreadCalendars = [],
  envByNamespace,
  now,
  onOpenJob,
  onOpenRun,
  replayAction,
}: {
  jobs: readonly BatchJobXR[]
  runs: readonly RunRow[]
  history: HistoryRead | undefined
  historyError?: unknown
  calendars: Parameters<typeof calendarRows>[0]
  unreadCalendars?: readonly string[]
  envByNamespace?: ReadonlyMap<string, string>
  now: number
  onOpenJob?(namespace: string, name: string): void
  onOpenRun?(namespace: string, name: string): void
  /** The replay control of one dead-letter entry; absent, the queue is read-only. */
  replayAction?(entry: DlqEntry): ReactNode
}) {
  const events: readonly BatchEvent[] = history?.state === 'read' ? history.events : []
  const forecast = useMemo(
    () => tonightRows(jobs, { now, runs, events, calendars, unreadCalendars, envByNamespace }),
    [jobs, now, runs, events, calendars, unreadCalendars, envByNamespace],
  )
  const chains = useMemo(() => dependencyChains(jobs, runs), [jobs, runs])
  const dlq = useMemo(() => dlqByJob(dlqEntries(runs, events)), [runs, events])
  const today = dateInZone(now) ?? new Date(now).toISOString().slice(0, 10)
  const cals = useMemo(() => calendarRows(calendars, jobs, today), [calendars, jobs, today])
  const jobKeys = useMemo(() => new Set(jobs.map((j) => batchRef(j.metadata.namespace ?? '', j.metadata.name))), [jobs])
  const runKeys = useMemo(() => new Set(runs.map((r) => r.key)), [runs])
  const openJob = (ns: string, name: string) => (onOpenJob && jobKeys.has(batchRef(ns, name)) ? () => onOpenJob(ns, name) : undefined)
  const openRun = (ns: string, name: string) => (onOpenRun && runKeys.has(batchRef(ns, name)) ? () => onOpenRun(ns, name) : undefined)

  // History that could not be read changes what the estimates and the counts mean, so it is said once, at the top.
  const partial = history?.state === 'unavailable'
    ? history.reason === 'no-bus'
      ? 'This cluster has no event bus, so expected ends and dead-letter counts come only from the runs the cluster still holds (seven days by default).'
      : `The batch history could not be read (${history.detail}), so expected ends and dead-letter counts come only from the runs the cluster still holds.`
    : historyError && !history
    ? `The batch history could not be read (${errorText(historyError)}), so expected ends and dead-letter counts come only from the runs the cluster still holds.`
    : history?.state === 'read' && (history.truncated || history.degraded)
    ? 'Part of the batch history could not be read, so an expected end may rest on fewer runs than there were.'
    : undefined

  return (
    <div className='space-y-6'>
      {partial ? <Note tone='warn'>{partial}</Note> : null}
      <Section title='Next 24 hours'>
        <ForecastTable rows={forecast} now={now} openJob={openJob} />
      </Section>
      <Section title='Dependency chains'>
        <ChainsTable chains={chains} openJob={openJob} openRun={openRun} />
      </Section>
      <Section title='Dead-letter queue'>
        <DlqTable jobs={dlq} openJob={openJob} openRun={openRun} replayAction={replayAction} />
      </Section>
      <Section title='Calendars'>
        <CalendarsTable rows={cals} unread={unreadCalendars} />
      </Section>
    </div>
  )
}

/* ─────────────────────────── the forecast ─────────────────────────── */

const JobName = ({ name, sub, open }: { name: string; sub?: string; open?: () => void }) => (
  <div className='min-w-0'>
    {open
      ? <button type='button' className='truncate text-left font-medium text-content hover:underline' onClick={open}>{name}</button>
      : <div className='truncate font-medium text-content'>{name}</div>}
    {sub ? <div className='truncate text-[11px] text-content-subtle'>{sub}</div> : null}
  </div>
)

function CalendarCell({ verdict }: { verdict: CalendarVerdict }) {
  if (verdict.state === 'none') return <span className='text-content-subtle'>—</span>
  if (verdict.state === 'business-day') return <span className='font-mono text-[12px]'>{verdict.calendar}</span>
  if (verdict.state === 'skipped') {
    return (
      <span title={`It starts and exits 0 as skipped: this date is a ${verdict.why} in ${verdict.calendar}.`}>
        <StatusBadge kind='unknown'>Skips: {verdict.why}</StatusBadge>
        <span className='ml-1.5 font-mono text-[11px] text-content-subtle'>{verdict.calendar}</span>
      </span>
    )
  }
  return (
    <span title={`${verdict.calendar}: ${verdict.why}`}>
      <StatusBadge kind='paused'>Calendar unknown</StatusBadge>
      <span className='ml-1.5 text-[11px] text-content-subtle'>{verdict.calendar}: {verdict.why}</span>
    </span>
  )
}

function SlaCell({ row }: { row: TonightRow }) {
  if (row.sla === 'none') return <span className='text-content-subtle'>{row.finishBy && row.calendar.state === 'skipped' ? 'nothing due' : '—'}</span>
  const by = <span className='font-mono text-[11px] text-content-subtle'>by {row.finishBy}</span>
  if (row.sla === 'unknown') return <span title='No successful run to estimate from, so the end cannot be forecast.'><StatusBadge kind='unknown'>No estimate</StatusBadge> {by}</span>
  const slack = durationWords(Math.abs(row.slackMs ?? 0))
  return row.sla === 'at-risk'
    ? <span title={`Expected to end ${slack} after the deadline.`}><StatusBadge kind='failed'>At risk</StatusBadge> {by} <span className='text-[11px] text-rose-700 dark:text-rose-300'>{slack} late</span></span>
    : <span title={`Expected to end ${slack} before the deadline.`}><StatusBadge kind='healthy'>On time</StatusBadge> {by}</span>
}

export function ForecastTable({ rows, now, openJob }: { rows: readonly TonightRow[]; now: number; openJob?(namespace: string, name: string): (() => void) | undefined }) {
  if (!rows.length) {
    return <EmptyState compact title='Nothing is scheduled in the next 24 hours' description='No schedule that is neither held nor suspended fires in this window. On-demand jobs run only when someone or something starts them.' />
  }
  return (
    <div className='overflow-x-auto rounded-xl border border-edge-default bg-surface-raised'>
      <table className={TABLE}>
        <thead className='bg-surface-muted'>
          <tr>
            <th className={TH}>Starts</th>
            <th className={TH}>Job</th>
            <th className={TH}>Business date</th>
            <th className={TH}>Calendar</th>
            <th className={TH}>Expected end</th>
            <th className={TH}>Finish by</th>
            <th className={TH}>Then</th>
          </tr>
        </thead>
        <tbody className='divide-y divide-edge-subtle'>
          {rows.map((r) => (
            <tr key={r.key} className={cn(r.calendar.state === 'skipped' && 'text-content-muted')}>
              <td className={TD}>
                <div className='font-mono tabular-nums'>{clock(r.startMs, r.timeZone)} <span className='text-[11px] text-content-subtle'>{r.timeZone}</span></div>
                <div className='text-[11px] text-content-subtle'><Until at={r.startMs} timeZone={r.timeZone} now={now} /></div>
              </td>
              <td className={TD}>
                <JobName name={r.displayName} sub={[r.environment ?? r.namespace, r.more ? `and ${r.more} more ${r.more === 1 ? 'fire' : 'fires'} in this window` : null].filter(Boolean).join(' · ')} open={openJob?.(r.namespace, r.job)} />
              </td>
              <td className={cn(TD, 'font-mono')}>{r.businessDate ?? '—'}</td>
              <td className={TD}><CalendarCell verdict={r.calendar} /></td>
              <td className={TD}>
                {r.calendar.state === 'skipped'
                  ? <span className='text-content-subtle'>no work</span>
                  : r.expectedEndMs === undefined
                  ? <span className='text-content-subtle' title='No successful run to estimate from.'>no estimate</span>
                  : (
                    <>
                      <div className='font-mono tabular-nums'>{clock(r.expectedEndMs, r.timeZone)}</div>
                      <div className='text-[11px] text-content-subtle'>p90 {durationWords(r.p90Ms)}</div>
                    </>
                  )}
              </td>
              <td className={TD}><SlaCell row={r} /></td>
              <td className={cn(TD, 'font-mono text-[11px] text-content-muted')}>{r.then.length ? r.then.join(', ') : <span className='text-content-subtle'>—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ─────────────────────────── dependency chains ─────────────────────────── */

const CHAIN_BADGE: Record<Chain['state'], { kind: 'healthy' | 'paused' | 'unknown'; label: string }> = {
  ready: { kind: 'healthy', label: 'Upstream done' },
  waiting: { kind: 'paused', label: 'Waiting' },
  unknown: { kind: 'unknown', label: 'Cannot tell' },
}

export function ChainsTable({
  chains,
  openJob,
  openRun,
}: {
  chains: readonly Chain[]
  openJob?(namespace: string, name: string): (() => void) | undefined
  openRun?(namespace: string, name: string): (() => void) | undefined
}) {
  if (!chains.length) {
    return <EmptyState compact title='No job waits for another' description={<>A job with <span className='font-mono'>dependsOn</span> is started by the platform once the jobs it names have succeeded.</>} />
  }
  return (
    <div className='overflow-x-auto rounded-xl border border-edge-default bg-surface-raised'>
      <table className={TABLE}>
        <thead className='bg-surface-muted'>
          <tr>
            <th className={TH}>Job</th>
            <th className={TH}>Runs after</th>
            <th className={TH}>State</th>
            <th className={TH}>Last started by its dependencies</th>
          </tr>
        </thead>
        <tbody className='divide-y divide-edge-subtle'>
          {chains.map((c) => {
            const last = c.lastDependencyRun
            const open = last ? openRun?.(c.namespace, last.name) : undefined
            return (
              <tr key={c.key}>
                <td className={TD}><JobName name={c.job} sub={c.namespace} open={openJob?.(c.namespace, c.job)} /></td>
                <td className={TD}>
                  <ul className='space-y-1'>
                    {c.after.map((l) => (
                      <li key={l.key}>
                        <span className='font-mono'>{l.key}</span>{' '}
                        <span className='text-[11px] text-content-subtle'>
                          {!l.known
                            ? 'not visible to you'
                            : l.sameBusinessDate
                            ? l.lastSuccessDate ? `same business date · last succeeded for ${l.lastSuccessDate}` : 'same business date · no success in the cluster'
                            : l.lastPhase ? `latest run · ${PHASE_LABEL[l.lastPhase].toLowerCase()}` : 'latest run · none in the cluster'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </td>
                <td className={TD}><StatusBadge kind={CHAIN_BADGE[c.state].kind}>{CHAIN_BADGE[c.state].label}</StatusBadge></td>
                <td className={TD}>
                  {last
                    ? (
                      <span className='inline-flex flex-wrap items-center gap-1.5'>
                        {open
                          ? <button type='button' className='font-mono text-brand-700 hover:underline dark:text-brand-300' onClick={open}>{last.name}</button>
                          : <span className='font-mono'>{last.name}</span>}
                        <StatusBadge kind={PHASE_BADGE[last.phase]}>{PHASE_LABEL[last.phase]}</StatusBadge>
                        {last.businessDate ? <span className='font-mono text-[11px] text-content-subtle'>{last.businessDate}</span> : null}
                      </span>
                    )
                    : <span className='text-content-subtle'>none in the cluster</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ─────────────────────────── the dead-letter queue ─────────────────────────── */

export function DlqTable({
  jobs,
  openJob,
  openRun,
  replayAction,
}: {
  jobs: readonly DlqJob[]
  openJob?(namespace: string, name: string): (() => void) | undefined
  openRun?(namespace: string, name: string): (() => void) | undefined
  replayAction?(entry: DlqEntry): ReactNode
}) {
  if (!jobs.length) {
    return <EmptyState compact title='No dead letters' description='No run in the cluster or in the history kept reported an item it could not process. The items themselves live in each job’s own database.' />
  }
  return (
    <div className='space-y-2'>
      <div className='overflow-x-auto rounded-xl border border-edge-default bg-surface-raised'>
        <table className={TABLE}>
          <thead className='bg-surface-muted'>
            <tr>
              <th className={TH}>Run</th>
              <th className={TH}>Business date</th>
              <th className={TH}>Execution</th>
              <th className={cn(TH, 'text-right')}>Dead letters</th>
              <th className={TH}>Ended</th>
              <th className={TH}>Replay</th>
            </tr>
          </thead>
          {jobs.map((j) => (
            <tbody key={j.key} className='divide-y divide-edge-subtle border-t border-edge-default'>
              <tr>
                <th colSpan={6} scope='rowgroup' className='bg-surface-sunken px-3 py-1.5 text-left text-[11px] font-semibold text-content-muted'>
                  <span className='inline-flex items-center gap-2'>
                    <JobName name={j.job} open={openJob?.(j.namespace, j.job)} />
                    <span className='font-normal text-content-subtle'>{j.namespace} · {j.total.toLocaleString()} dead-lettered in {j.entries.length} {j.entries.length === 1 ? 'run' : 'runs'}</span>
                  </span>
                </th>
              </tr>
              {j.entries.map((e) => {
                const open = e.run ? openRun?.(e.namespace, e.run) : undefined
                const openReplay = e.replay ? openRun?.(e.namespace, e.replay.run) : undefined
                return (
                  <tr key={`${e.run}#${e.executionId ?? ''}`}>
                    <td className={TD}>
                      {!e.run
                        ? <span className='text-content-subtle'>unnamed</span>
                        : open
                        ? <button type='button' className='font-mono text-brand-700 hover:underline dark:text-brand-300' onClick={open}>{e.run}</button>
                        : <span className='font-mono' title='This run is no longer in the cluster'>{e.run}</span>}
                      {e.source === 'event' ? <span className='ml-1.5 text-[11px] text-content-subtle'>from history</span> : null}
                    </td>
                    <td className={cn(TD, 'font-mono')}>{e.businessDate ?? '—'}</td>
                    <td className={cn(TD, 'font-mono tabular-nums')}>{e.executionId ?? <span className='font-sans text-content-subtle'>not reported</span>}</td>
                    <td className={cn(TD, 'text-right font-mono tabular-nums')}>{e.deadLettered.toLocaleString()}</td>
                    <td className={TD}><When at={e.ended} /></td>
                    <td className={TD}>
                      <span className='inline-flex flex-wrap items-center gap-1.5'>
                        {e.replay
                          ? (
                            <>
                              {openReplay
                                ? <button type='button' className='font-mono text-[11px] text-brand-700 hover:underline dark:text-brand-300' onClick={openReplay}>{e.replay.run}</button>
                                : <span className='font-mono text-[11px]'>{e.replay.run}</span>}
                              <StatusBadge kind={PHASE_BADGE[e.replay.phase]}>{PHASE_LABEL[e.replay.phase]}</StatusBadge>
                            </>
                          )
                          : null}
                        {replayAction?.(e)}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          ))}
        </table>
      </div>
      <p className='text-[11px] text-content-subtle'>
        Counts are what each run reported when it ended. A replay re-processes only that execution’s rejected items, as an ops Job with the job’s own credentials:{' '}
        <span className='font-mono'>adhar batch dlq &lt;job&gt; --replay</span> starts the same Job.
      </p>
    </div>
  )
}

/**
 * Replay, for one entry. There only when a replay could be started: the entry
 * names an execution, the BatchJob is on the page (its run template is what the
 * ops Job is made from), no replay of it is under way or done, and the caller
 * may create runs there. Hidden otherwise, never disabled (§7.4).
 */
export function ReplayButton({ entry, jobs, onReplay }: { entry: DlqEntry; jobs: readonly BatchJobXR[]; onReplay(entry: DlqEntry): void }) {
  const job = jobs.find((j) => (j.metadata.namespace ?? '') === entry.namespace && j.metadata.name === entry.job)
  const gate = useBatchGate('run', { namespace: entry.namespace, name: entry.job, kind: job ? runKindOfJob(job) : 'Job' })
  if (!job || entry.executionId === undefined || !gate.allowed) return null
  if (entry.replay && entry.replay.phase !== 'failed') return null
  return <Button size='sm' variant='ghost' onClick={() => onReplay(entry)}>{entry.replay ? 'Retry replay' : 'Replay'}</Button>
}

export function ReplayDialog({
  entry,
  job,
  runs,
  onClose,
  onOpenRun,
  Frame = Modal,
}: {
  entry: DlqEntry
  job: BatchJobXR | undefined
  /** The runs the cluster holds, live: an existing replay is found among them. */
  runs: readonly RunRow[]
  onClose(): void
  onOpenRun?(name: string): void
  Frame?: DialogFrame
}) {
  const read = useRunTemplate(entry.namespace, entry.job, job?.status?.runTemplate)
  const template = read.data?.state === 'ok' ? read.data.template : undefined
  const plan = useMemo(() => replayPlan(entry, runs), [entry, runs])
  const replay = useReplayDeadLetters()
  const toast = useToast()

  const submit = async () => {
    if (!template || plan.action !== 'create' || entry.executionId === undefined) return
    try {
      const out = await replay.mutateAsync({ namespace: entry.namespace, template, name: plan.name, executionId: entry.executionId, restartOf: plan.restartOf })
      const name = out.created ? out.run.metadata.name : out.existing
      if (out.created) toast.success(`Started ${name}`)
      else toast.success(`${name} already exists`, { description: 'A replay of this execution was started before, so that one is shown instead of a second.' })
      onOpenRun?.(name)
      onClose()
    } catch (e) {
      toast.error(`Could not replay the dead letters of ${entry.job}`, { description: errorText(e) })
    }
  }

  return (
    <Frame
      open
      onClose={onClose}
      title={`Replay dead letters of ${entry.job}`}
      description={`In ${entry.namespace}: an ops Job from the deployed run template, acting on one execution.`}
      width='lg'
      footer={
        <div className='flex w-full items-center justify-between gap-2'>
          <span className='min-w-0 truncate text-[11px] text-content-subtle'>
            {plan.action !== 'refused' ? <>Run <span className='font-mono'>{plan.name}</span></> : null}
          </span>
          <div className='flex gap-2'>
            <Button variant='ghost' onClick={onClose}>Cancel</Button>
            {plan.action === 'exists'
              ? <Button variant='primary' onClick={() => { onOpenRun?.(plan.name); onClose() }}>Open the existing replay</Button>
              : <Button variant='primary' onClick={submit} loading={replay.isPending} disabled={!template || plan.action !== 'create'}>Start replay</Button>}
          </div>
        </div>
      }
    >
      {read.isLoading
        ? <div className='flex items-center gap-2 py-4 text-[13px] text-content-subtle' role='status'><Spinner size={12} /> Reading the run template…</div>
        : read.isError
        ? <Note tone='warn'>{errorText(read.error)}</Note>
        : read.data && read.data.state !== 'ok'
        ? <Note tone='warn'>{read.data.message}</Note>
        : (
          <div className='space-y-3 text-[13px] text-content'>
            <p>
              Execution <span className='font-mono'>{entry.executionId ?? '—'}</span>
              {entry.run ? <> of <span className='font-mono'>{entry.run}</span></> : null}
              {entry.businessDate ? <> (business date <span className='font-mono'>{entry.businessDate}</span>)</> : null} reported{' '}
              <span className='font-semibold tabular-nums'>{entry.deadLettered.toLocaleString()}</span> dead-lettered {entry.deadLettered === 1 ? 'item' : 'items'}.
            </p>
            {plan.action === 'refused'
              ? <Note tone='warn'>{plan.reason}</Note>
              : plan.action === 'exists'
              ? <Note>A replay of this execution is already {PHASE_LABEL[plan.phase].toLowerCase()}: <span className='font-mono'>{plan.name}</span>. Nothing more is started.</Note>
              : (
                <Note>
                  Only the rejected items of this execution are processed again, by the job’s own runner with the job’s own credentials. Fix what rejected them first: an
                  item that fails again is dead-lettered again.
                  {plan.restartOf ? <> The earlier replay <span className='font-mono'>{plan.restartOf}</span> failed, so this is its retry.</> : null}
                </Note>
              )}
            {replay.isError ? <Note tone='warn'>{errorText(replay.error)}</Note> : null}
          </div>
        )}
    </Frame>
  )
}

/* ─────────────────────────── calendars (D5) ─────────────────────────── */

const days = (list: readonly string[]) => list.map((d) => d.slice(0, 1) + d.slice(1, 3).toLowerCase()).join(', ')

export function CalendarsTable({ rows, unread = [] }: { rows: readonly CalendarRow[]; unread?: readonly string[] }) {
  return (
    <div className='space-y-2'>
      {unread.length
        ? <Note tone='warn'>You may not read the calendars of <span className='font-mono'>{unread.join(', ')}</span>, so a job that names one there shows as “calendar unknown”, not as running every day.</Note>
        : null}
      {!rows.length
        ? (
          <EmptyState
            compact
            title='No calendars'
            description={
              <>
                A calendar is a ConfigMap labelled <span className='font-mono'>adhar.io/batch-calendar: "true"</span> with a <span className='font-mono'>calendar.yaml</span>, in a team’s
                overlays or shipped by the platform. A job with no <span className='font-mono'>schedule.calendar</span> runs on every date its cron fires.
              </>
            }
          />
        )
        : (
          <div className='overflow-x-auto rounded-xl border border-edge-default bg-surface-raised'>
            <table className={TABLE}>
              <thead className='bg-surface-muted'>
                <tr>
                  <th className={TH}>Calendar</th>
                  <th className={TH}>Time zone</th>
                  <th className={TH}>Weekend</th>
                  <th className={TH}>Coming up</th>
                  <th className={TH}>Followed by</th>
                </tr>
              </thead>
              <tbody className='divide-y divide-edge-subtle'>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td className={TD}>
                      <div className='flex flex-wrap items-center gap-1.5'>
                        <span className='font-mono font-medium text-content'>{r.calendar.name}</span>
                        <StatusBadge kind={r.scope === 'platform' ? 'info' : 'unknown'}>{r.scope}</StatusBadge>
                        {r.calendar.error ? <StatusBadge kind='failed'>Unreadable</StatusBadge> : null}
                      </div>
                      <div className='text-[11px] text-content-subtle'>
                        {r.calendar.namespace}
                        {r.shadows ? ' · replaces the platform calendar of this name for jobs here' : ''}
                      </div>
                      {r.calendar.error ? <div className='text-[11px] text-rose-700 dark:text-rose-300'>{r.calendar.error} A run that mounts it exits 2.</div> : null}
                    </td>
                    <td className={TD}>{r.calendar.timeZone ?? <span className='text-content-subtle'>the job’s</span>}</td>
                    <td className={TD}>{r.calendar.weekendDays.length ? days(r.calendar.weekendDays) : <span className='text-content-subtle'>none</span>}</td>
                    <td className={TD}>
                      {r.upcoming.length
                        ? (
                          <ul className='space-y-0.5'>
                            {r.upcoming.slice(0, 4).map((u) => (
                              <li key={`${u.date}${u.kind}`}><span className='font-mono'>{u.date}</span> <span className='text-[11px] text-content-subtle'>{u.kind === 'holiday' ? 'holiday' : 'working day'}</span></li>
                            ))}
                            {r.upcoming.length > 4 ? <li className='text-[11px] text-content-subtle'>and {r.upcoming.length - 4} more</li> : null}
                          </ul>
                        )
                        : <span className='text-content-subtle'>nothing listed from today</span>}
                    </td>
                    <td className={cn(TD, 'font-mono text-[11px]')}>{r.usedBy.length ? r.usedBy.join(', ') : <span className='font-sans text-content-subtle'>no job on this page</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}
