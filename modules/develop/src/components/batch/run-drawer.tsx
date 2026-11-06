import { type ReactNode, useMemo, useState } from 'react'
import { Button, canResource, LogConsole, Spinner, StatusBadge, type TabDef, Tabs, TimeSeriesChart, useAccessReview, useLogStream, useToolPublicUrl } from '@adhar/shell-ui'
import { cn, formatDuration } from '@adhar/utils'
import { CloseButton, Drawer } from '../list-kit.tsx'
import { usePrometheusReachable } from '../../data/perf-metrics.ts'
import { useBatchGate, useRun, useRunEvents, useRunMetrics, useRunPods } from '../../data/batch.ts'
import {
  BATCH_CONTAINER,
  type BatchJobXR,
  displayParam,
  exitMeaning,
  fieldsOfJob,
  isActivePhase,
  observabilityLinks,
  outcomeLabel,
  podIndex,
  podRole,
  PODS_GVR,
  runActionsOf,
  runEvents,
  type RunKind,
  type RunPod,
  runParams,
  type RunRow,
  runRow,
  speakerPod,
  summaryOf,
  terminationOf,
} from '../../data/batch-model.ts'
import { ExternalLink, Facts, Note, Section } from '../../views/function-bits.tsx'
import { ConditionsTable, DurationText, ErrorLine, ExitCode, Loading, RunBadge, TABLE, TD, TH, useNow, When } from './bits.tsx'
import { RestartDialog, ResumeDialog, StopDialog } from './dialogs.tsx'

/**
 * Develop → Batch → one run: its phase and conditions, the pods behind it (the
 * manager and each worker with its index), the termination summary, live logs,
 * Kubernetes events and CPU/memory, with Stop, Resume and Restart. Every read is
 * a live query keyed by namespace + name, and nothing is fetched for a tab that
 * is not open.
 */

export type RunTab = 'overview' | 'pods' | 'events' | 'metrics'

const TABS: TabDef<RunTab>[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'pods', label: 'Pods & logs' },
  { id: 'events', label: 'Events' },
  { id: 'metrics', label: 'Metrics' },
]

export function RunDrawer({
  namespace,
  name,
  kind,
  job,
  existingNames,
  tab,
  onTab,
  onClose,
  onOpenRun,
}: {
  namespace: string
  name: string
  kind?: RunKind
  /** The BatchJob, when the caller may read it: it says which parameters are sensitive. */
  job?: BatchJobXR
  existingNames: readonly string[]
  tab?: string
  onTab(tab: RunTab): void
  onClose(): void
  onOpenRun(name: string): void
}) {
  const live = useRun(namespace, name, kind)
  const pods = useRunPods(namespace, name, kind)
  const active = live.data ? isActivePhase(runRow(live.data, []).phase) : false
  const now = useNow(active, 5_000)
  const row = useMemo(() => (live.data ? runRow(live.data, pods.data?.items ?? [], now) : undefined), [live.data, pods.data, now])
  const current: RunTab = TABS.some((t) => t.id === tab) ? (tab as RunTab) : 'overview'

  return (
    <Drawer
      onClose={onClose}
      width='max-w-5xl'
      widthId='develop.batch.run'
      header={
        <div className='space-y-2'>
          <div className='flex items-start justify-between gap-3'>
            <div className='min-w-0'>
              <div className='flex flex-wrap items-center gap-2'>
                <h2 className='truncate font-mono text-lg font-semibold tracking-tight text-content'>{name}</h2>
                {row ? <RunBadge row={row} /> : null}
                {live.data === null ? <StatusBadge kind='failed'>gone</StatusBadge> : null}
              </div>
              <div className='mt-0.5 truncate text-[12px] text-content-subtle'>
                {[row?.batchJob ? `job ${row.batchJob}` : null, namespace, row?.trigger ? `triggered by ${row.trigger}` : null, row?.actor ? `by ${row.actor}` : null].filter(Boolean).join(' · ')}
              </div>
            </div>
            <CloseButton onClick={onClose} />
          </div>
          {row ? <RunActionsBar row={row} job={job} existingNames={existingNames} onOpenRun={onOpenRun} /> : null}
        </div>
      }
    >
      {live.isLoading
        ? <Loading label='Loading the run…' />
        : live.isError && !live.data
        ? <ErrorLine error={live.error} />
        : live.data === null || !row
        ? (
          <Note>
            <span className='font-mono'>{namespace}/{name}</span> no longer exists. A finished run is removed when its TTL passes, and its pods and summary go with it.
          </Note>
        )
        : (
          <Tabs<RunTab> ariaLabel='Run' value={current} onChange={onTab} tabs={TABS}>
            {(t) => (
              <div className='pt-4'>
                {t === 'overview'
                  ? <OverviewTab row={row} job={job} forbiddenPods={pods.data?.forbidden} />
                  : t === 'pods'
                  ? <PodsTab row={row} pods={pods.data?.items ?? []} loading={pods.isLoading} forbidden={pods.data?.forbidden} error={pods.error} />
                  : t === 'events'
                  ? <EventsTab row={row} pods={pods.data?.items ?? []} />
                  : <MetricsTab row={row} />}
              </div>
            )}
          </Tabs>
        )}
    </Drawer>
  )
}

/* ─────────────────────────── actions ─────────────────────────── */

export function RunActionsBar({ row, job, existingNames, onOpenRun }: { row: RunRow; job?: BatchJobXR; existingNames: readonly string[]; onOpenRun(name: string): void }) {
  const can = runActionsOf(row.phase)
  const target = { namespace: row.namespace, name: row.name, kind: row.kind }
  const stop = useBatchGate('stop', target)
  const resume = useBatchGate('resume', target)
  const restart = useBatchGate('restart', target)
  const [open, setOpen] = useState<'stop' | 'resume' | 'restart' | null>(null)
  const showRestart = can.restart && restart.allowed && Boolean(row.batchJob)
  if (!(can.stop && stop.allowed) && !(can.resume && resume.allowed) && !showRestart) return null
  return (
    <div className='flex flex-wrap items-center gap-2'>
      {can.stop && stop.allowed ? <Button size='sm' variant='danger' onClick={() => setOpen('stop')}>Stop</Button> : null}
      {can.resume && resume.allowed ? <Button size='sm' variant='primary' onClick={() => setOpen('resume')}>Resume</Button> : null}
      {showRestart ? <Button size='sm' variant='primary' onClick={() => setOpen('restart')}>Restart</Button> : null}
      {open === 'stop' ? <StopDialog run={row} onClose={() => setOpen(null)} /> : null}
      {open === 'resume' ? <ResumeDialog run={row} onClose={() => setOpen(null)} /> : null}
      {open === 'restart'
        ? <RestartDialog run={row} job={job} existingNames={existingNames} onClose={() => setOpen(null)} onOpenRun={onOpenRun} />
        : null}
    </div>
  )
}

/* ─────────────────────────── Overview ─────────────────────────── */

function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className='rounded-xl border border-edge-default bg-surface-raised px-3 py-2'>
      <div className='text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>{label}</div>
      <div className='text-lg font-semibold tabular-nums text-content'>{value}</div>
      {hint ? <div className='text-[10px] text-content-subtle'>{hint}</div> : null}
    </div>
  )
}

const count = (n: number | undefined) => (n === undefined ? '—' : n.toLocaleString())

function OverviewTab({ row, job, forbiddenPods }: { row: RunRow; job?: BatchJobXR; forbiddenPods?: boolean }) {
  const s = row.summary
  const params = runParams(row.raw)
  const fields = job ? fieldsOfJob(job) : []
  const paramRows = Object.entries(params)
  const conditions = row.raw.status?.conditions ?? []
  const grafana = useToolPublicUrl('grafana')
  const links = observabilityLinks(grafana, { application: row.application ?? row.batchJob ?? row.name, namespace: row.namespace, name: row.batchJob ?? row.name, run: row.name })
  return (
    <div className='space-y-5'>
      {row.message && row.phase !== 'succeeded'
        ? <Note tone={row.phase === 'failed' ? 'warn' : 'info'}>{row.message}</Note>
        : null}
      {forbiddenPods
        ? <Note tone='warn'>You may not list pods in {row.namespace}, so this run’s exit code and summary cannot be read.</Note>
        : null}

      <Section title='Run'>
        <Facts
          rows={[
            ['Status', <RunBadge key='s' row={row} />],
            ['Outcome', outcomeLabel(s)],
            ['Exit code', row.exitCode !== undefined ? <span key='e'><ExitCode code={row.exitCode} /> <span className='text-content-muted'>{exitMeaning(row.exitCode)}</span></span> : undefined],
            ['Trigger', row.trigger],
            ['Actor', row.actor],
            ['Business date', row.businessDate ? <span key='b' className='font-mono text-[12px]'>{row.businessDate}</span> : undefined],
            ['Restart of', row.restartOf ? <span key='r' className='font-mono text-[12px]'>{row.restartOf}</span> : undefined],
            ['Scheduled for', row.scheduledAt ? <When key='sc' at={row.scheduledAt} /> : undefined],
            ['Started', row.startedAt ? <When key='st' at={row.startedAt} /> : undefined],
            ['Took', row.durationMs !== undefined ? <DurationText key='d' ms={row.durationMs} running={isActivePhase(row.phase)} /> : undefined],
            ['Attempts', String(row.attempts)],
            ['Kind', row.kind === 'VolcanoJob' ? 'Volcano Job' : 'Job'],
            ['Image', row.image ? <span key='i' className='font-mono text-[12px]'>{row.image}</span> : undefined],
          ]}
        />
      </Section>

      {paramRows.length
        ? (
          <Section title='Parameters'>
            <Facts rows={paramRows.map(([k, v]) => [k, <span key={k} className='font-mono text-[12px]'>{displayParam(fields.find((f) => f.name === k), v)}</span>] as [string, ReactNode])} />
          </Section>
        )
        : null}

      <Section title='Summary'>
        {s
          ? <SummaryView row={row} />
          : isActivePhase(row.phase)
          ? <Note>The runner writes its summary when the run ends. While it runs, follow the logs.</Note>
          : <Note>This run wrote no summary. A JVM that fails before the runner starts cannot write one, and a run that has not adopted the kit’s runner does not either.</Note>}
      </Section>

      {conditions.length ? <Section title='Conditions'><ConditionsTable conditions={conditions} /></Section> : null}

      {links
        ? (
          <div className='flex flex-wrap gap-4 text-[12px]'>
            <ExternalLink href={links.dashboard}>Grafana dashboard</ExternalLink>
            <ExternalLink href={links.logs}>Logs in Loki</ExternalLink>
            <ExternalLink href={links.traces}>Traces in Tempo</ExternalLink>
          </div>
        )
        : null}
    </div>
  )
}

function SummaryView({ row }: { row: RunRow }) {
  const s = row.summary
  if (!s) return null
  return (
    <div className='space-y-3'>
      {s.truncated ? <Note tone='warn'>The summary was cut off. These are the fields that could be recovered.</Note> : null}
      {s.exitDescription ? <Note tone={row.phase === 'failed' ? 'warn' : 'info'}><span className='[overflow-wrap:anywhere]'>{s.exitDescription}</span></Note> : null}
      <div className='grid grid-cols-2 gap-2 sm:grid-cols-5'>
        <Tile label='Read' value={count(s.read)} />
        <Tile label='Written' value={count(s.written)} />
        <Tile label='Skipped' value={count(s.skipped)} />
        <Tile label='Dead-lettered' value={count(s.deadLettered)} />
        <Tile label='Filtered' value={count(s.filtered)} />
      </div>
      <Facts
        rows={[
          ['Job', s.job],
          ['Instance', s.instanceId !== undefined ? String(s.instanceId) : undefined],
          ['Execution', s.executionId !== undefined ? String(s.executionId) : undefined],
          ['Spring Batch status', s.status],
          ['Image digest', s.image ? <span key='d' className='font-mono text-[12px]'>{s.image}</span> : undefined],
        ]}
      />
      {s.steps?.length
        ? (
          <div className='overflow-x-auto rounded-xl border border-edge-default'>
            <table className={TABLE}>
              <thead className='bg-surface-muted'>
                <tr><th className={TH}>Step</th><th className={TH}>Status</th><th className={TH}>Read</th><th className={TH}>Written</th><th className={TH}>Skipped</th></tr>
              </thead>
              <tbody className='divide-y divide-edge-subtle'>
                {s.steps.map((st, i) => (
                  <tr key={st.name ?? i}>
                    <td className={cn(TD, 'font-mono')}>{st.name ?? '—'}</td>
                    <td className={TD}>{st.status ?? '—'}</td>
                    <td className={cn(TD, 'tabular-nums')}>{count(st.read)}</td>
                    <td className={cn(TD, 'tabular-nums')}>{count(st.written)}</td>
                    <td className={cn(TD, 'tabular-nums')}>{count(st.skipped)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
        : null}
      {s.stepsTruncated ? <p className='text-[11px] text-content-subtle'>Step detail was dropped to fit the 3.5 KB summary. The full history is in the job’s repository and its logs.</p> : null}
    </div>
  )
}

/* ─────────────────────────── Pods & logs ─────────────────────────── */

const podLabel = (p: RunPod) => {
  const role = podRole(p)
  const index = podIndex(p)
  return [role && role !== 'single' ? role : null, index !== undefined ? `#${index}` : null].filter(Boolean).join(' ')
}

const podState = (p: RunPod): { label: string; kind: 'healthy' | 'failed' | 'progressing' | 'unknown' } => {
  if (p.metadata.deletionTimestamp) return { label: 'Terminating', kind: 'progressing' }
  const t = terminationOf(p)
  if (t) return t.exitCode === 0 ? { label: t.reason ?? 'Completed', kind: 'healthy' } : { label: t.reason ?? 'Failed', kind: 'failed' }
  const c = p.status?.containerStatuses?.find((x) => x.name === BATCH_CONTAINER)
  const waiting = c?.state?.waiting?.reason
  if (waiting) return { label: waiting, kind: /BackOff|Err|Invalid/.test(waiting) ? 'failed' : 'progressing' }
  const phase = p.status?.phase ?? 'Unknown'
  return { label: phase, kind: phase === 'Failed' ? 'failed' : phase === 'Succeeded' ? 'healthy' : phase === 'Unknown' ? 'unknown' : 'progressing' }
}

function PodsTab({ row, pods, loading, forbidden, error }: { row: RunRow; pods: readonly RunPod[]; loading: boolean; forbidden?: boolean; error: unknown }) {
  const [pick, setPick] = useState<string>('auto')
  const logs = useAccessReview(canResource(PODS_GVR, 'get', { namespace: row.namespace, subresource: 'log' }))
  const sorted = useMemo(() => [...pods].sort((a, b) => (b.metadata.creationTimestamp ?? '').localeCompare(a.metadata.creationTimestamp ?? '')), [pods])
  const speaker = useMemo(() => speakerPod(sorted), [sorted])
  const chosen = pick === 'all' ? sorted : pick === 'auto' ? (speaker ? [speaker] : []) : sorted.filter((p) => p.metadata.name === pick)
  const sources = chosen
    .filter((p) => p.status?.phase !== 'Pending')
    .map((p) => ({ pod: p.metadata.name, container: BATCH_CONTAINER, label: podLabel(p) || p.metadata.name.replace(`${row.name}-`, '') }))
  const follow = isActivePhase(row.phase)
  const stream = useLogStream({ namespace: row.namespace, sources, follow, tailLines: 1000, enabled: logs.allowed && sources.length > 0 })

  if (loading) return <Loading label='Loading pods…' />
  if (forbidden) return <Note tone='warn'>You may not list pods in {row.namespace}.</Note>
  if (error) return <ErrorLine error={error} />
  if (!sorted.length) {
    return (
      <Note>
        {isActivePhase(row.phase)
          ? 'No pods yet. The Job has not created one, or the scheduler is still finding room.'
          : row.phase === 'stopped'
          ? 'No pods: a stopped run holds none. Resuming creates a new one.'
          : 'Its pods are gone, so its logs are only in Loki.'}
      </Note>
    )
  }
  return (
    <div className='space-y-4'>
      <div className='overflow-x-auto rounded-xl border border-edge-default'>
        <table className={TABLE}>
          <thead className='bg-surface-muted'>
            <tr><th className={TH}>Pod</th><th className={TH}>Role</th><th className={TH}>State</th><th className={TH}>Exit</th><th className={TH}>Node</th><th className={TH}>Started</th></tr>
          </thead>
          <tbody className='divide-y divide-edge-subtle'>
            {sorted.map((p) => {
              const st = podState(p)
              const t = terminationOf(p)
              const sum = summaryOf(p)
              return (
                <tr key={p.metadata.name} className={cn(pick === p.metadata.name && 'bg-surface-sunken')}>
                  <td className={cn(TD, 'font-mono')}>
                    <button type='button' className='text-left hover:underline' onClick={() => setPick(p.metadata.name)}>{p.metadata.name}</button>
                  </td>
                  <td className={TD}>{podLabel(p) || '—'}</td>
                  <td className={TD}><StatusBadge kind={st.kind}>{st.label}</StatusBadge></td>
                  <td className={TD}><ExitCode code={sum?.exitCode ?? t?.exitCode} /></td>
                  <td className={cn(TD, 'font-mono text-[11px] text-content-subtle')}>{p.spec?.nodeName ?? '—'}</td>
                  <td className={cn(TD, 'text-content-subtle')}><When at={p.metadata.creationTimestamp} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {!logs.allowed && !logs.loading
        ? <Note tone='warn'>Reading logs needs <span className='font-mono'>get pods/log</span> in {row.namespace}.</Note>
        : (
          <LogConsole
            lines={stream.lines}
            status={stream.status}
            error={stream.error}
            reconnect={stream.reconnect}
            live={stream.status === 'streaming'}
            filename={`${row.name}-logs`}
            label={BATCH_CONTAINER}
            toolbar={
              <select
                aria-label='Pod'
                value={pick}
                onChange={(e) => setPick(e.target.value)}
                className='max-w-[16rem] rounded border border-code-fg/20 bg-transparent px-1.5 py-0.5 font-mono text-[11px] text-code-fg/80'
              >
                <option value='auto'>{sorted.length > 1 ? 'Latest attempt' : sorted[0].metadata.name}</option>
                {sorted.length > 1 ? <option value='all'>All pods ({sorted.length})</option> : null}
                {sorted.length > 1 ? sorted.map((p) => <option key={p.metadata.name} value={p.metadata.name}>{p.metadata.name}</option>) : null}
              </select>
            }
            emptyMessage='No output yet from the batch container.'
          />
        )}
    </div>
  )
}

/* ─────────────────────────── Events ─────────────────────────── */

function EventsTab({ row, pods }: { row: RunRow; pods: readonly RunPod[] }) {
  const q = useRunEvents(row.namespace)
  const names = useMemo(() => pods.map((p) => p.metadata.name), [pods])
  const rows = useMemo(() => runEvents(q.data?.items, row, names), [q.data, row, names])
  if (q.isLoading) return <Loading label='Loading events…' />
  if (q.isError) return <ErrorLine error={q.error} />
  if (q.data?.forbidden) return <Note tone='warn'>You may not list events in {row.namespace}.</Note>
  if (!rows.length) return <Note>No recent events for this run or its pods. Kubernetes keeps events for about an hour.</Note>
  return (
    <div className='overflow-x-auto rounded-xl border border-edge-default'>
      <table className={TABLE}>
        <thead className='bg-surface-muted'>
          <tr><th className={TH}>Type</th><th className={TH}>Reason</th><th className={TH}>Object</th><th className={TH}>Message</th><th className={TH}>Count</th><th className={TH}>Last seen</th></tr>
        </thead>
        <tbody className='divide-y divide-edge-subtle'>
          {rows.map((e) => (
            <tr key={e.key}>
              <td className={TD}><StatusBadge kind={e.type === 'Warning' ? 'paused' : 'unknown'}>{e.type}</StatusBadge></td>
              <td className={cn(TD, 'font-medium')}>{e.reason}</td>
              <td className={cn(TD, 'font-mono text-[11px]')}>{e.object}</td>
              <td className={cn(TD, 'max-w-md text-content-muted [overflow-wrap:anywhere]')}>{e.message}</td>
              <td className={cn(TD, 'tabular-nums')}>{e.count}</td>
              <td className={cn(TD, 'text-content-subtle')}><When at={e.at} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ─────────────────────────── Metrics ─────────────────────────── */

const fmtMetric = (unit: string, v: number) => {
  if (!Number.isFinite(v)) return '—'
  if (unit === 'cores') return v < 1 ? `${Math.round(v * 1000)}m` : v.toFixed(2)
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let x = v
  let i = 0
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i++
  }
  return `${x < 10 ? x.toFixed(1) : Math.round(x)} ${units[i]}`
}

function MetricsTab({ row }: { row: RunRow }) {
  const prom = usePrometheusReachable()
  const ok = prom.data?.ok === true
  const startMs = row.startedAt ? Date.parse(row.startedAt) : undefined
  const endMs = row.finishedAt && !isActivePhase(row.phase) ? Date.parse(row.finishedAt) : undefined
  const panels = useRunMetrics(row.namespace, row.name, Number.isNaN(startMs) ? undefined : startMs, endMs, ok)
  if (prom.isLoading) return <div className='flex items-center gap-2 py-6 text-[13px] text-content-subtle'><Spinner size={12} /> Checking Prometheus…</div>
  if (!ok) return <Note tone='warn'>{prom.data?.reason ?? 'Prometheus is not reachable from the console.'} Metrics cannot be shown.</Note>
  if (startMs === undefined) return <Note>This run has not started, so it has no metrics yet.</Note>
  return (
    <div className='space-y-3'>
      <p className='text-[11px] text-content-subtle'>
        {row.durationMs !== undefined ? `Over the run’s ${formatDuration(row.durationMs)}. ` : ''}A run shorter than the 30-second scrape interval may show nothing here.
        Item throughput and JVM panels are on the job’s Grafana dashboard.
      </p>
      <div className='grid grid-cols-1 gap-3 lg:grid-cols-2'>
        {panels.map((p) => (
          <div key={p.spec.id} className='rounded-xl border border-edge-default bg-surface-raised p-3'>
            <div className='mb-1 text-[13px] font-semibold text-content'>{p.spec.title}</div>
            {p.error
              ? <div className='py-8 text-center text-[12px] text-content-subtle'>{p.error}</div>
              : p.loading
              ? <div className='flex justify-center py-8'><Spinner size={12} /></div>
              : !p.points.length
              ? <div className='py-8 text-center text-[12px] text-content-subtle'>No data</div>
              : <TimeSeriesChart series={[{ name: p.spec.title, points: p.points }]} height={140} formatY={(v) => fmtMetric(p.spec.unit, v)} />}
            <div className='mt-1 text-[11px] text-content-subtle'>{p.spec.hint}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
