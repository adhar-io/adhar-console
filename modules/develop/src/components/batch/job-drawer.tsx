import { useMemo, useState } from 'react'
import { Button, Checkbox, CONSOLE_PERMISSIONS, Field, Input, StatusBadge, type TabDef, Tabs, useAccessReview, useToast, useToolPublicUrl } from '@adhar/shell-ui'
import { cn, formatDuration } from '@adhar/utils'
import { CloseButton, Drawer } from '../list-kit.tsx'
import { useBatchGate, useBatchJob, useFiringAlerts, useRunTemplate } from '../../data/batch.ts'
import { useDeleteOwningApplication, useDelivery } from '../../data/functions.ts'
import {
  type ApplicationXR,
  deliveryRows,
  giteaTreeUrl,
  overlayDir,
  PLATFORM_ENVIRONMENTS,
  repoFromUrl,
} from '../../data/functions-model.ts'
import {
  type BatchJobXR,
  displayParam,
  durationBars,
  fieldsOfJob,
  type JobRow,
  JOB_STATUS_BADGE,
  JOB_STATUS_LABEL,
  jobOwner,
  jobProblem,
  observabilityLinks,
  runKindOfJob,
  type RunRow,
} from '../../data/batch-model.ts'
import { ExternalLink, Facts, Note, Section } from '../../views/function-bits.tsx'
import { ConditionsTable, DurationText, ErrorLine, ExitCode, jobSubtitle, Loading, RunBadge, SlaBadge, TABLE, TD, TH, Until, When } from './bits.tsx'
import { HoldDialog, ReleaseDialog, RunNowDialog } from './dialogs.tsx'

/**
 * Develop → Batch → one job: its definition (from the XR and the run template),
 * parameter schema, recent runs as bars against `maxDuration`, firing alerts,
 * delivery, and links out to its dashboard, logs and traces. Run now and Hold /
 * Release are here. A change to the definition is a pull request against
 * `deploy/envs/<env>`, because Argo CD would put back a live edit (§7.4).
 */

export type JobTab = 'overview' | 'parameters' | 'runs' | 'alerts' | 'delivery' | 'config'

const TABS: TabDef<JobTab>[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'parameters', label: 'Parameters' },
  { id: 'runs', label: 'Runs' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'delivery', label: 'Delivery' },
  { id: 'config', label: 'Configuration' },
]

export function JobDrawer({
  row,
  applications,
  now,
  tab,
  onTab,
  onClose,
  onOpenRun,
}: {
  row: JobRow
  applications?: readonly ApplicationXR[]
  now: number
  tab?: string
  onTab(tab: JobTab): void
  onClose(): void
  onOpenRun(name: string): void
}) {
  const live = useBatchJob(row.namespace, row.name)
  const gone = live.data === null
  const job = live.data ?? row.job
  const [dialog, setDialog] = useState<'run' | 'hold' | 'release' | null>(null)
  const current: JobTab = TABS.some((t) => t.id === tab) ? (tab as JobTab) : 'overview'
  const existingNames = useMemo(() => row.runs.map((r) => r.name), [row.runs])

  return (
    <Drawer
      onClose={onClose}
      width='max-w-5xl'
      widthId='develop.batch.job'
      header={
        <div className='space-y-2'>
          <div className='flex items-start justify-between gap-3'>
            <div className='min-w-0'>
              <div className='flex flex-wrap items-center gap-2'>
                <h2 className='truncate text-lg font-semibold tracking-tight text-content'>{row.displayName}</h2>
                <StatusBadge kind={JOB_STATUS_BADGE[row.status]}>{JOB_STATUS_LABEL[row.status]}</StatusBadge>
                {row.held ? <span title={row.held.reason}><StatusBadge kind='paused'>Held</StatusBadge></span> : null}
                {row.environment ? <StatusBadge kind='unknown'>{row.environment}</StatusBadge> : null}
                {gone ? <StatusBadge kind='failed'>deleted</StatusBadge> : null}
              </div>
              <div className='mt-0.5 truncate text-[12px] text-content-subtle'>
                {[row.namespace, jobSubtitle(job, { application: row.application, project: row.project, team: row.team })].filter(Boolean).join(' · ')}
              </div>
            </div>
            <CloseButton onClick={onClose} />
          </div>
          {!gone ? <JobActionsBar job={job} held={Boolean(row.held)} onDialog={setDialog} /> : null}
          {row.held
            ? (
              <div className='text-[12px] text-amber-800 dark:text-amber-200'>
                Held{row.held.since ? <> <When at={row.held.since} /></> : null}: {row.held.reason || 'no reason given'}. Its schedule is not firing.
              </div>
            )
            : null}
        </div>
      }
    >
      {gone
        ? <Note><span className='font-mono'>{row.key}</span> was deleted, by its application or from Git. Runs that still exist stay under Runs until their TTL passes.</Note>
        : (
          <Tabs<JobTab> ariaLabel='Batch job' value={current} onChange={onTab} tabs={TABS}>
            {(t) => (
              <div className='pt-4'>
                {t === 'overview'
                  ? <OverviewTab row={row} job={job} now={now} />
                  : t === 'parameters'
                  ? <ParametersTab job={job} />
                  : t === 'runs'
                  ? <RunsTab row={row} onOpenRun={onOpenRun} />
                  : t === 'alerts'
                  ? <AlertsTab namespace={row.namespace} name={row.name} />
                  : t === 'delivery'
                  ? <DeliveryTab row={row} />
                  : <ConfigTab row={row} job={job} applications={applications} onDeleted={onClose} />}
              </div>
            )}
          </Tabs>
        )}

      {dialog === 'run' ? <RunNowDialog job={job} existingNames={existingNames} onClose={() => setDialog(null)} onOpenRun={onOpenRun} /> : null}
      {dialog === 'hold' ? <HoldDialog job={job} onClose={() => setDialog(null)} /> : null}
      {dialog === 'release' ? <ReleaseDialog job={job} reason={row.held?.reason ?? ''} onClose={() => setDialog(null)} /> : null}
    </Drawer>
  )
}

/** Run now, and Hold or Release. Each is there only if the request it makes would be allowed: hidden, never disabled. */
export function JobActionsBar({ job, held, onDialog }: { job: BatchJobXR; held: boolean; onDialog(d: 'run' | 'hold' | 'release'): void }) {
  const target = { namespace: job.metadata.namespace ?? '', name: job.metadata.name, kind: runKindOfJob(job) }
  const canRun = useBatchGate('run', target)
  const canHold = useBatchGate('hold', target)
  if (!canRun.allowed && !canHold.allowed) return null
  return (
    <div className='flex flex-wrap items-center gap-2'>
      {canRun.allowed ? <Button size='sm' variant='primary' onClick={() => onDialog('run')}>Run now</Button> : null}
      {canHold.allowed
        ? held
          ? <Button size='sm' variant='ghost' onClick={() => onDialog('release')}>Release</Button>
          : <Button size='sm' variant='ghost' onClick={() => onDialog('hold')}>Hold</Button>
        : null}
    </div>
  )
}

/* ─────────────────────────── Overview ─────────────────────────── */

function OverviewTab({ row, job, now }: { row: JobRow; job: BatchJobXR; now: number }) {
  const p = job.spec?.parameters ?? {}
  const template = useRunTemplate(row.namespace, row.name, job.status?.runTemplate)
  const problem = jobProblem(job)
  const grafana = useToolPublicUrl('grafana')
  const links = observabilityLinks(grafana, { application: row.application, namespace: row.namespace, name: row.name })
  const conditions = job.status?.conditions ?? []
  const s = row.schedule
  return (
    <div className='space-y-5'>
      {problem ? <Note tone='warn'>{problem}</Note> : null}
      {job.status?.message && job.status.message !== problem ? <Note>{job.status.message}</Note> : null}

      <Section title='Schedule'>
        <Facts
          rows={[
            ['Runs', s.cron ? `${s.label} (${s.timeZone})` : 'On demand: only when someone or something starts it'],
            ['Cron', s.cron ? <span key='c' className='font-mono text-[12px]'>{s.cron}</span> : undefined],
            ['Next run', s.cron ? (row.held ? 'Not while held' : s.suspended ? 'Suspended in Git' : <Until key='n' at={row.nextRunMs} timeZone={s.timeZone} now={now} />) : undefined],
            ['Last scheduled', job.status?.lastScheduleTime ? <When key='l' at={job.status.lastScheduleTime} /> : undefined],
            ['Last success', row.lastSuccess ? <When key='ls' at={row.lastSuccess} /> : undefined],
            ['SLA', <span key='sla' className='inline-flex items-center gap-2'><SlaBadge sla={row.sla} />{row.sla.message ? <span className='text-content-muted'>{row.sla.message}</span> : null}</span>],
            ['If it overlaps', p.schedule?.cron ? (p.schedule.concurrencyPolicy === 'Allow' ? 'Both run' : 'The new occurrence is skipped') : undefined],
            ['Misfire window', p.schedule?.cron ? `${p.schedule.startingDeadlineSeconds ?? 3600}s` : undefined],
          ]}
        />
      </Section>

      <Section title='Definition'>
        <Facts
          rows={[
            ['Spring Batch job', p.job ? <span key='j' className='font-mono text-[12px]'>{p.job}</span> : undefined],
            ['Image', p.image ? <span key='i' className='font-mono text-[12px]'>{p.image}</span> : undefined],
            ['Mode', p.mode ?? 'single'],
            ['Scheduler', job.status?.scheduler ?? p.scheduler ?? 'auto'],
            ['Queue', job.status?.queue],
            ['Priority', p.priority ?? 'standard'],
            ['Resources', `${p.resources?.cpu ?? '1'} CPU · ${p.resources?.memory ?? '1536Mi'} memory${p.resources?.tmpSize ? ` · ${p.resources.tmpSize} /tmp` : ''}`],
            ['Retries', `${p.retry?.backoffLimit ?? 2} (for retryable failures)`],
            ['Deadline', `${formatDuration((p.timeouts?.activeDeadlineSeconds ?? 21600) * 1_000)}, ${p.timeouts?.terminationGracePeriodSeconds ?? 120}s to stop`],
            ['Job repository', p.database?.secretRef ? <span key='d' className='font-mono text-[12px]'>{p.database.secretRef} ({p.database.schema ?? 'batch'})</span> : undefined],
            ['Run template', template.isLoading
              ? 'Reading…'
              : template.isError
              ? 'Could not be read'
              : template.data?.state === 'ok'
              ? <span key='t' className='font-mono text-[12px]'>{job.status?.runTemplate ?? `${row.name}-run`} · {template.data.template.kind} · naming {template.data.template.naming}</span>
              : template.data?.message],
          ]}
        />
      </Section>

      {conditions.length
        ? <Section title='Conditions'><ConditionsTable conditions={conditions} /></Section>
        : <Note>No conditions reported yet: the control plane has not reconciled this BatchJob.</Note>}

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

/* ─────────────────────────── Parameters ─────────────────────────── */

function ParametersTab({ job }: { job: BatchJobXR }) {
  const fields = fieldsOfJob(job)
  if (!fields.length) return <Note>This job declares no parameters.</Note>
  return (
    <div className='space-y-2'>
      <div className='overflow-x-auto rounded-xl border border-edge-default'>
        <table className={TABLE}>
          <thead className='bg-surface-muted'>
            <tr><th className={TH}>Name</th><th className={TH}>Type</th><th className={TH}>Identifies a run</th><th className={TH}>Required</th><th className={TH}>Default</th><th className={TH}>Allowed</th><th className={TH}>Comes from</th><th className={TH}>Description</th></tr>
          </thead>
          <tbody className='divide-y divide-edge-subtle'>
            {fields.map((f) => (
              <tr key={f.name}>
                <td className={cn(TD, 'font-mono font-medium')}>{f.name}{f.sensitive ? <span className='ml-1 font-sans text-[10px] text-content-subtle'>sensitive</span> : null}</td>
                <td className={TD}>{f.type}</td>
                <td className={TD}>{f.identifying ? 'Yes' : 'No'}</td>
                <td className={TD}>{f.required ? 'Yes' : 'No'}</td>
                <td className={cn(TD, 'font-mono')}>{f.default !== undefined ? displayParam(f, f.default || '""') : '—'}</td>
                <td className={cn(TD, 'font-mono')}>{f.allowed?.join(', ') ?? f.pattern ?? '—'}</td>
                <td className={TD}>{f.source === 'schedule' ? 'The schedule' : 'Whoever starts it'}</td>
                <td className={cn(TD, 'max-w-xs text-content-muted')}>{f.description ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className='text-[11px] text-content-subtle'>
        A run is named for its identifying parameters, so the same values always mean the same run, and Spring Batch will not repeat one that completed.
      </p>
    </div>
  )
}

/* ─────────────────────────── Runs ─────────────────────────── */

const BAR_TONE = (b: { phase: string; over: boolean }) =>
  b.phase === 'failed' ? 'bg-rose-500' : b.over ? 'bg-amber-500' : b.phase === 'succeeded' ? 'bg-emerald-500' : b.phase === 'stopped' ? 'bg-content-subtle' : 'bg-sky-500'

const LEGEND: Array<[string, string]> = [
  ['bg-emerald-500', 'Succeeded'],
  ['bg-rose-500', 'Failed'],
  ['bg-amber-500', 'Over the limit'],
  ['bg-sky-500', 'Running'],
  ['bg-content-subtle', 'Stopped'],
]

/**
 * Recent runs as bars against the job's limit, oldest on the left. The status
 * colours always come with the label in the bar's tooltip and the table beneath,
 * so state never rests on colour alone. Each bar's button fills the column: the
 * mark is thin, the target is not.
 */
function DurationBars({ runs, maxDurationMs, onOpenRun }: { runs: readonly RunRow[]; maxDurationMs?: number; onOpenRun(name: string): void }) {
  const { bars, limitRatio } = useMemo(() => durationBars(runs, maxDurationMs), [runs, maxDurationMs])
  if (!bars.length) return null
  return (
    <figure className='rounded-xl border border-edge-default bg-surface-raised p-3'>
      <figcaption className='mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[11px] text-content-subtle'>
        <span>Duration of the last {bars.length} {bars.length === 1 ? 'run' : 'runs'}{maxDurationMs !== undefined ? `, against a limit of ${formatDuration(maxDurationMs)}` : ''}</span>
        <span className='flex flex-wrap gap-x-3'>
          {LEGEND.map(([tone, label]) => <span key={label} className='inline-flex items-center gap-1'><span className={cn('h-2 w-2 rounded-[2px]', tone)} />{label}</span>)}
        </span>
      </figcaption>
      <div className='relative flex h-20 items-end gap-0.5'>
        {limitRatio !== undefined
          ? (
            <div
              className='pointer-events-none absolute inset-x-0 border-t border-dashed border-content-subtle/60'
              style={{ bottom: `${limitRatio * 100}%` }}
              aria-hidden='true'
            />
          )
          : null}
        {bars.map((b) => (
          <button
            key={b.key}
            type='button'
            onClick={() => onOpenRun(b.name)}
            title={`${b.name}: ${b.phase}, ${formatDuration(b.durationMs)}${b.over ? ' (over the limit)' : ''}`}
            aria-label={`${b.name}, ${b.phase}, took ${formatDuration(b.durationMs)}`}
            className='flex h-full max-w-6 flex-1 items-end rounded-sm hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40'
          >
            <span className={cn('w-full rounded-t', BAR_TONE(b))} style={{ height: `${Math.max(2, b.ratio * 100)}%` }} />
          </button>
        ))}
      </div>
    </figure>
  )
}

function RunsTab({ row, onOpenRun }: { row: JobRow; onOpenRun(name: string): void }) {
  if (!row.runs.length) {
    return <Note>No runs yet. {row.schedule.cron ? 'One appears when the schedule next fires, or' : 'One appears when'} someone starts it with Run now.</Note>
  }
  return (
    <div className='space-y-3'>
      <DurationBars runs={row.runs} maxDurationMs={row.sla.maxDurationMs} onOpenRun={onOpenRun} />
      <div className='overflow-x-auto rounded-xl border border-edge-default'>
        <table className={TABLE}>
          <thead className='bg-surface-muted'>
            <tr><th className={TH}>Run</th><th className={TH}>Status</th><th className={TH}>Trigger</th><th className={TH}>Business date</th><th className={TH}>Attempts</th><th className={TH}>Took</th><th className={TH}>Exit</th><th className={TH}>Started</th></tr>
          </thead>
          <tbody className='divide-y divide-edge-subtle'>
            {row.runs.slice(0, 50).map((r) => (
              <tr key={r.key} className='cursor-pointer hover:bg-surface-sunken' onClick={() => onOpenRun(r.name)}>
                <td className={cn(TD, 'font-mono')}>
                  <button type='button' className='text-left text-brand-700 hover:underline dark:text-brand-300' onClick={(e) => { e.stopPropagation(); onOpenRun(r.name) }}>{r.name}</button>
                </td>
                <td className={TD}><RunBadge row={r} /></td>
                <td className={TD}>{r.trigger ?? '—'}</td>
                <td className={cn(TD, 'font-mono')}>{r.businessDate ?? '—'}</td>
                <td className={cn(TD, 'tabular-nums')}>{r.attempts}</td>
                <td className={TD}><DurationText ms={r.durationMs} /></td>
                <td className={TD}><ExitCode code={r.exitCode} /></td>
                <td className={cn(TD, 'text-content-subtle')}><When at={r.startedAt} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ─────────────────────────── Alerts ─────────────────────────── */

function AlertsTab({ namespace, name }: { namespace: string; name: string }) {
  const q = useFiringAlerts(namespace, name)
  if (q.isLoading) return <Loading label='Asking Prometheus…' />
  if (q.error) return <Note tone='warn'>{q.error.message} Firing alerts cannot be shown, which does not mean none are firing.</Note>
  if (!q.alerts.length) return <Note>No batch alert is firing for this job.</Note>
  return (
    <div className='overflow-x-auto rounded-xl border border-edge-default'>
      <table className={TABLE}>
        <thead className='bg-surface-muted'>
          <tr><th className={TH}>Alert</th><th className={TH}>Severity</th><th className={TH}>About</th></tr>
        </thead>
        <tbody className='divide-y divide-edge-subtle'>
          {q.alerts.map((a, i) => (
            <tr key={`${a.name}-${i}`}>
              <td className={cn(TD, 'font-medium')}>{a.name}</td>
              <td className={TD}><StatusBadge kind={a.severity === 'critical' ? 'failed' : 'paused'}>{a.severity ?? 'unknown'}</StatusBadge></td>
              <td className={cn(TD, 'font-mono text-[11px] text-content-muted')}>{a.labels.job_name ?? a.labels.pod ?? a.labels.cronjob ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ─────────────────────────── Delivery ─────────────────────────── */

function DeliveryTab({ row }: { row: JobRow }) {
  const q = useDelivery(row.project)
  const envs = PLATFORM_ENVIRONMENTS
  const rows = useMemo(() => deliveryRows(q.stages, q.freight, row.project, row.application, envs), [q.stages, q.freight, row.project, row.application, envs])
  const deployTab = `/catalog?entity=${encodeURIComponent(`component:${row.application}`)}&tab=deploy`
  if (!row.project) return <Note>This job names no project, so it has no promotion chain to show.</Note>
  if (q.forbidden) return <Note tone='warn'>You may not read Kargo stages in project {row.project}.</Note>
  if (q.isLoading) return <Loading label='Loading the promotion chain…' />
  if (q.error) return <ErrorLine error={q.error} />
  if (!rows.some((r) => r.stage)) return <Note>Project {row.project} has no Kargo stage carrying {row.application} yet. It joins the chain when its Warehouse is created.</Note>
  return (
    <div className='space-y-3'>
      <ExternalLink href={deployTab}>Promote from the catalog’s Deploy tab</ExternalLink>
      <div className='overflow-x-auto rounded-xl border border-edge-default'>
        <table className={TABLE}>
          <thead className='bg-surface-muted'>
            <tr><th className={TH}>Environment</th><th className={TH}>Stage</th><th className={TH}>Running</th><th className={TH}>Last promotion</th><th className={TH}>Verification</th></tr>
          </thead>
          <tbody className='divide-y divide-edge-subtle'>
            {rows.map((r) => (
              <tr key={r.env}>
                <td className={cn(TD, 'font-medium capitalize')}>{r.env}</td>
                <td className={cn(TD, 'font-mono')}>{r.stage ?? '—'}{r.promoting ? <div className='mt-0.5 font-sans text-[11px] text-sky-700 dark:text-sky-300'>promoting…</div> : null}</td>
                <td className={cn(TD, 'font-mono')}>{r.freight ?? '—'}</td>
                <td className={TD}>
                  {r.lastPromotionPhase ? <StatusBadge kind={r.lastPromotionPhase === 'Succeeded' ? 'healthy' : /fail|error/i.test(r.lastPromotionPhase) ? 'failed' : 'progressing'}>{r.lastPromotionPhase}</StatusBadge> : '—'}
                  {r.lastPromoted ? <div className='mt-0.5 text-[11px] text-content-subtle'><When at={r.lastPromoted} /></div> : null}
                </td>
                <td className={TD}>{r.verification ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ─────────────────────────── Configuration ─────────────────────────── */

function ConfigTab({ row, job, applications, onDeleted }: { row: JobRow; job: BatchJobXR; applications?: readonly ApplicationXR[]; onDeleted(): void }) {
  const giteaPublic = useToolPublicUrl('gitea')
  const app = applications?.find((a) => (a.metadata.labels?.['adhar.io/application'] || a.metadata.name) === row.application)
  const repo = repoFromUrl(app?.spec?.parameters?.source?.repoURL, giteaPublic)
  const owner = jobOwner(job)
  const branch = app?.spec?.parameters?.source?.targetRevision || 'main'
  const manifestPath = app?.spec?.parameters?.source?.path || 'deploy'
  const env = row.environment
  const envVars = Object.entries(job.spec?.parameters?.env ?? {})
  const yaml = JSON.stringify(job.spec?.parameters ?? {}, null, 2)
  return (
    <div className='space-y-5'>
      <Note>
        {owner.managed
          ? <>This job is deployed from Git: Argo CD would put back a change made to the live object. Its schedule and definition change through a pull request against the environment’s overlay. Holding it is the one thing done live, and Argo CD leaves that alone.</>
          : <>This BatchJob is not managed from Git, so it has no overlay. A job created from a template is; this one was applied by hand.</>}
      </Note>
      {repo?.webUrl && env
        ? (
          <div className='flex flex-wrap gap-4 text-[12px]'>
            <ExternalLink href={giteaTreeUrl(repo.webUrl, branch, overlayDir(env, manifestPath))}>Edit in Git · {overlayDir(env, manifestPath)}</ExternalLink>
            <ExternalLink href={giteaTreeUrl(repo.webUrl, branch, `${manifestPath}/base`)}>Base · {manifestPath}/base</ExternalLink>
          </div>
        )
        : owner.managed
        ? <Note tone='warn'>The source repository is unknown: no Application XR you can read names this job’s application, so the console cannot link to its overlay.</Note>
        : null}

      <Section title={`Environment variables (${envVars.length})`}>
        {envVars.length
          ? (
            <div className='overflow-x-auto rounded-xl border border-edge-default'>
              <table className={TABLE}>
                <tbody className='divide-y divide-edge-subtle'>
                  {envVars.map(([k, v]) => (
                    <tr key={k}>
                      <td className='px-3 py-1.5 font-mono font-medium'>{k}</td>
                      <td className='px-3 py-1.5 font-mono text-content-muted [overflow-wrap:anywhere]'>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
          : <Note>None set beyond the platform’s own (ADHAR_BATCH_*, the datasource and telemetry).</Note>}
      </Section>

      <Section title='Declared parameters of this BatchJob'>
        <pre className='max-h-96 overflow-auto rounded-xl border border-edge-default bg-surface-sunken p-3 font-mono text-[12px] text-content'>{yaml}</pre>
      </Section>

      {owner.managed ? <DeleteSection application={row.application} name={row.name} onDeleted={onDeleted} /> : null}
    </div>
  )
}

function DeleteSection({ application, name, onDeleted }: { application: string; name: string; onDeleted(): void }) {
  const toast = useToast()
  const access = useAccessReview(CONSOLE_PERMISSIONS.applicationsDelete)
  const del = useDeleteOwningApplication()
  const [typed, setTyped] = useState('')
  const [deleteRepo, setDeleteRepo] = useState(false)
  if (!access.allowed) return null
  const run = async () => {
    try {
      const out = await del.mutateAsync({ name: application, deleteRepo })
      toast.success(`Deleting application ${application}`, { description: out.deleting ? 'The control plane is removing its BatchJob from every environment.' : 'Removed.' })
      onDeleted()
    } catch (e) {
      toast.error(`Could not delete ${application}`, { description: e instanceof Error ? e.message : String(e) })
    }
  }
  return (
    <Section title={`Delete application ${application}`}>
      <div className='space-y-3 rounded-xl border border-rose-200 p-4 dark:border-rose-500/25'>
        <p className='text-[13px] text-content-muted'>
          Deleting <span className='font-mono'>{name}</span> here would not stick: Argo CD would put it back. It goes with its application, which removes it from every
          environment. Runs in progress are not stopped first, so stop any that matter.
        </p>
        <Field label={<span>Type <span className='font-mono'>{application}</span> to confirm</span>}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete='off' spellCheck={false} className='font-mono' />
        </Field>
        <Checkbox
          label='Also delete its repository'
          description='Off by default: the code stays in Gitea even when the application is gone.'
          checked={deleteRepo}
          onChange={(e) => setDeleteRepo(e.target.checked)}
        />
        <Button variant='danger' onClick={run} loading={del.isPending} disabled={typed !== application}>Delete application</Button>
      </div>
    </Section>
  )
}
