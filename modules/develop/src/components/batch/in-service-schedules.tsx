import { type ReactNode, useMemo } from 'react'
import { matchesQuery, StatusBadge, useToolPublicUrl } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { useBatchSchedules, useScheduleNamespaceWatch } from '../../data/batch-schedules.ts'
import {
  groupServicesByApplication,
  inServiceLinks,
  MISFIRE_LABEL,
  type ScheduleJobRow,
  type ScheduleServiceRow,
  serviceSearchText,
  type TriggerView,
} from '../../data/batch-schedules-model.ts'
import { ExternalLink, Note } from '../../views/function-bits.tsx'
import { DurationText, TABLE, TD, TH, Until, useNow, When } from './bits.tsx'

/**
 * Develop → Batch → Jobs, the in-service group (design 0025 §5.20.8, CON-Q.3):
 * jobs that run INSIDE a service on the kit's Quartz scheduler, from the
 * schedule reports the services write, grouped by application.
 *
 * Read-only, on purpose. Run now, Stop, Restart and Hold act on Kubernetes
 * objects, and an in-service run is not one: it is a thread in a replica, and
 * the only thing that can start or stop it is the service itself. So a row
 * offers where to look (the service's logs for that run, its dashboard), and
 * nothing to press.
 */

const COLS = 5

/** One namespace's report watch (and the poll standing in for it). Renders nothing. */
function ScheduleWatch({ namespace }: { namespace: string }) {
  useScheduleNamespaceWatch(namespace)
  return null
}

export function ScheduleWatches({ namespaces }: { namespaces: readonly string[] }) {
  return <>{[...new Set(namespaces)].map((ns) => <ScheduleWatch key={ns} namespace={ns} />)}</>
}

/**
 * The group as the Jobs page mounts it: every report the caller may read across
 * `namespaces`, narrowed by the page's search. Its own clock ticks, so a fire
 * that falls overdue says so without the rest of the page re-rendering.
 */
export function InServiceSchedules({ namespaces, envByNamespace, query = '', empty }: {
  namespaces: readonly string[]
  envByNamespace?: ReadonlyMap<string, string>
  query?: string
  /** Shown instead when the search leaves nothing (the page's own "no match"). */
  empty?: ReactNode
}) {
  const now = useNow(true, 30_000)
  const { services, failed } = useBatchSchedules(namespaces, { envByNamespace, now })
  const shown = useMemo(() => (query ? services.filter((s) => matchesQuery(query, serviceSearchText(s))) : services), [services, query])
  const grafana = useToolPublicUrl('grafana')
  if (!shown.length && !failed.length) return services.length > 0 && empty ? <>{empty}</> : null
  return <InServiceSchedulesView services={shown} failed={failed} now={now} grafana={grafana} />
}

/** The group itself, with the Grafana address passed in (tests render this). Nothing at all when there is nothing to show. */
export function InServiceSchedulesView({
  services,
  failed = [],
  now,
  grafana,
}: {
  services: readonly ScheduleServiceRow[]
  failed?: ReadonlyArray<{ namespace: string; message: string }>
  now: number
  grafana: string
}) {
  if (!services.length && !failed.length) return null
  const groups = groupServicesByApplication(services)
  const jobs = services.reduce((n, s) => n + s.jobs.length, 0)
  return (
    <section aria-label='In-service schedules' className='space-y-2'>
      <div>
        <h3 className='text-[13px] font-semibold text-content'>
          In-service schedules <span className='font-normal text-content-subtle'>· {jobs} {jobs === 1 ? 'job' : 'jobs'} in {services.length} {services.length === 1 ? 'service' : 'services'}</span>
        </h3>
        <p className='text-[11px] text-content-subtle'>
          Jobs that run inside a long-running service on its Quartz scheduler, from the schedule report the service writes. They are
          changed in the service’s configuration and started by its own triggers, so there is nothing to run or stop from here.
        </p>
      </div>
      {failed.length
        ? <Note tone='warn'>Could not read the schedule reports in {failed.map((f) => `${f.namespace} (${f.message})`).join(', ')}.</Note>
        : null}
      {groups.length
        ? (
          <div className='overflow-x-auto rounded-xl border border-edge-default bg-surface-raised'>
            <table className={TABLE}>
              <thead className='bg-surface-muted'>
                <tr>
                  <th className={TH}>Job</th>
                  <th className={TH}>Triggers</th>
                  <th className={TH}>Next fire</th>
                  <th className={TH}>Last run</th>
                  <th className={TH}>Links</th>
                </tr>
              </thead>
              {groups.map((g) => (
                <tbody key={g.application} className='divide-y divide-edge-subtle border-t border-edge-default'>
                  <tr>
                    <th colSpan={COLS} scope='rowgroup' className='bg-surface-sunken px-3 py-1.5 text-left text-[11px] font-semibold text-content-muted'>
                      {g.application}
                    </th>
                  </tr>
                  {g.services.map((s) => <ServiceRows key={s.key} service={s} now={now} grafana={grafana} />)}
                </tbody>
              ))}
            </table>
          </div>
        )
        : null}
    </section>
  )
}

function ServiceRows({ service: s, now, grafana }: { service: ScheduleServiceRow; now: number; grafana: string }) {
  return (
    <>
      <tr>
        <td colSpan={COLS} className={cn(TD, 'text-[11px] text-content-muted')}>
          <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
            <span className='font-medium capitalize text-content'>{s.environment ?? <span className='font-mono normal-case'>{s.namespace}</span>}</span>
            {s.scheduler ? <span>scheduler <span className='font-mono'>{s.scheduler}</span></span> : null}
            <Replicas service={s} />
            {s.updatedMs !== undefined ? <span>report <When at={s.updatedMs} /></span> : null}
            {s.truncated
              ? <span title='The report was over its size limit, so the service left out the last runs, then triggers beyond 50 per job.'><StatusBadge kind='info'>Report truncated</StatusBadge></span>
              : null}
            {s.stale
              ? <span title='A fire this report promised is overdue and no replica has reported since. The service may be down, still running the job, or unable to write its report.'><StatusBadge kind='paused'>Overdue</StatusBadge></span>
              : null}
          </div>
        </td>
      </tr>
      {s.report === 'v1'
        ? s.jobs.length
          ? s.jobs.map((j) => <JobRowView key={j.key} job={j} service={s} now={now} grafana={grafana} />)
          : <tr><td colSpan={COLS} className={cn(TD, 'text-content-subtle')}>The report lists no jobs.</td></tr>
        : <tr><td colSpan={COLS} className={TD}><Unreadable service={s} /></td></tr>}
    </>
  )
}

function Replicas({ service: s }: { service: ScheduleServiceRow }) {
  if (s.replicas === undefined) return null
  const title = s.instances.map((i) => `${i.id ?? 'unnamed'}${i.checkin ? ` · checked in ${i.checkin}` : ''}`).join('\n')
  return (
    <span title={title || undefined} className={cn(s.replicas === 0 && 'text-amber-700 dark:text-amber-300')}>
      {s.replicas === 0 ? 'no live replicas' : `${s.replicas} live ${s.replicas === 1 ? 'replica' : 'replicas'}`}
    </span>
  )
}

/** A report this console cannot read: said, and shown as written. */
function Unreadable({ service: s }: { service: ScheduleServiceRow }) {
  return (
    <div className='space-y-1.5'>
      <p className='text-content-muted'>
        {s.report === 'unknown'
          ? <>This report is version <span className='font-mono'>{s.version}</span>, which this console does not read. It is shown as the service wrote it.</>
          : s.report === 'invalid'
          ? <>The report in <span className='font-mono'>{s.configMap}</span> could not be read ({s.error}).</>
          : <><span className='font-mono'>{s.configMap}</span> carries no <span className='font-mono'>schedules.json</span> yet.</>}
      </p>
      {s.raw ? <pre className='max-h-48 overflow-auto rounded-md bg-surface-sunken p-2 font-mono text-[11px] [overflow-wrap:anywhere] whitespace-pre-wrap'>{s.raw}</pre> : null}
    </div>
  )
}

function JobRowView({ job: j, service: s, now, grafana }: { job: ScheduleJobRow; service: ScheduleServiceRow; now: number; grafana: string }) {
  const links = inServiceLinks(grafana, { application: s.application, namespace: s.namespace, run: j.lastRun?.run, job: j.job })
  const last = j.lastRun
  return (
    <tr>
      <td className={TD}>
        <div className='font-medium text-content'>{j.job}</div>
        {j.name ? <div className='font-mono text-[11px] text-content-subtle'>{j.name}</div> : null}
      </td>
      <td className={TD}>
        {j.triggers.length
          ? <div className='space-y-1'>{j.triggers.map((t) => <TriggerLine key={t.key} trigger={t} />)}</div>
          : <span className='text-content-subtle'>No triggers reported</span>}
      </td>
      <td className={TD}>
        {j.overdue
          ? (
            <div title='No replica has reported this fire. The service may be down, still running it, or unable to write its report.'>
              <div className='text-amber-700 dark:text-amber-300'>Overdue</div>
              <div className='text-[11px] text-content-subtle'>was due <When at={j.overdueSinceMs} /></div>
            </div>
          )
          : j.nextFireMs !== undefined
          ? <Until at={j.nextFireMs} timeZone={j.nextTimeZone} now={now} />
          : <span className='text-content-subtle'>{j.triggers.length ? 'not scheduled' : '—'}</span>}
      </td>
      <td className={TD}>
        {last
          ? (
            <div className='space-y-0.5'>
              <span title={last.outcome}><StatusBadge kind={last.tone}>{last.label}</StatusBadge></span>
              <div className='text-[11px] text-content-subtle'>
                {last.run ? <span className='font-mono'>{last.run}</span> : null}
                {last.run && last.startMs !== undefined ? ' · ' : null}
                {last.startMs !== undefined ? <><DurationText ms={last.durationMs} running={last.running} /> · <When at={last.startMs} /></> : null}
              </div>
            </div>
          )
          : <span className='text-content-subtle'>{s.truncated ? 'Not in the truncated report' : 'No runs yet'}</span>}
      </td>
      <td className={cn(TD, 'whitespace-nowrap')}>
        {links
          ? (
            <div className='flex flex-col gap-0.5 text-[12px]'>
              <ExternalLink href={links.logs}>{last?.run ? 'Logs of this run' : 'Logs'}</ExternalLink>
              <ExternalLink href={links.dashboard}>Dashboard</ExternalLink>
            </div>
          )
          : <span className='text-content-subtle'>—</span>}
      </td>
    </tr>
  )
}

function TriggerLine({ trigger: t }: { trigger: TriggerView }) {
  const facts = [
    t.timeZone,
    t.calendar ? `calendar ${t.calendar}` : null,
    t.misfire ? `misfire ${t.misfire}` : null,
  ].filter(Boolean).join(' · ')
  return (
    <div>
      <div className='flex flex-wrap items-center gap-1.5'>
        <span title={t.definition}>{t.words}</span>
        <span className='font-mono text-[11px] text-content-subtle'>{t.name}</span>
        {t.stateLabel ? <StatusBadge kind={t.state === 'ERROR' ? 'failed' : t.state === 'BLOCKED' ? 'progressing' : 'paused'}>{t.stateLabel}</StatusBadge> : null}
      </div>
      {facts ? <div className='text-[11px] text-content-subtle' title={t.misfire ? MISFIRE_LABEL[t.misfire] : undefined}>{facts}</div> : null}
    </div>
  )
}
