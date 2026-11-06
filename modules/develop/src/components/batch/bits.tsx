import { type ReactNode, useEffect, useState } from 'react'
import { EmptyState, Spinner, StatusBadge } from '@adhar/shell-ui'
import { cn, formatAbsolute, formatDuration, formatRelative } from '@adhar/utils'
import { type BatchJobXR, exitMeaning, outcomeLabel, PHASE_BADGE, PHASE_LABEL, type RunRow, SLA_BADGE, SLA_LABEL, type SlaState } from '../../data/batch-model.ts'
import { Note } from '../../views/function-bits.tsx'

/** Small pieces shared by the Batch page and its two drawers. */

export const TABLE = 'min-w-full text-[12px]'
export const TH = 'px-3 py-2 text-left font-medium text-content-subtle whitespace-nowrap'
export const TD = 'px-3 py-2 align-top'
export const NEW_JOB_HREF = '/catalog?section=create&family=batch'

/** The wall clock, ticking only while something on screen is moving. */
export function useNow(active: boolean, everyMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [active, everyMs])
  return now
}

export function Loading({ label }: { label: string }) {
  return (
    <div className='flex items-center gap-2 py-6 text-[13px] text-content-subtle' role='status'>
      <Spinner size={12} /> {label}
    </div>
  )
}

export function ErrorLine({ error }: { error: unknown }) {
  return <Note tone='warn'>{error instanceof Error ? error.message : String(error)}</Note>
}

/** A timestamp as "3h ago", with the exact one a hover away. */
export function When({ at }: { at?: string | number }) {
  if (at === undefined || at === '') return <span className='text-content-subtle'>—</span>
  const iso = typeof at === 'number' ? new Date(at).toISOString() : at
  return <span title={formatAbsolute(iso)} className='whitespace-nowrap'>{formatRelative(iso)}</span>
}

/** A time in the future, as "in 3h", exact on hover. `formatRelative` only reads the past. */
export function Until({ at, timeZone, now }: { at?: number; timeZone?: string; now: number }) {
  if (at === undefined) return <span className='text-content-subtle'>—</span>
  const exact = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }).format(new Date(at))
  const ms = Math.max(0, at - now)
  const label = ms < 60_000 ? 'in under a minute' : `in ${formatDuration(ms - (ms % 60_000)).replace(/ 0s$/, '')}`
  return <span title={`${exact}${timeZone ? ` (${timeZone})` : ''}`} className='whitespace-nowrap'>{label}</span>
}

export function RunBadge({ row }: { row: Pick<RunRow, 'phase' | 'summary' | 'message'> }) {
  // Exit 0 covers four results (D13): a skipped run must not read as work done.
  const skipped = row.phase === 'succeeded' && row.summary?.outcome === 'skipped'
  const label = skipped ? 'Skipped' : PHASE_LABEL[row.phase]
  const title = outcomeLabel(row.summary) ?? row.message
  return <span title={title}><StatusBadge kind={skipped ? 'info' : PHASE_BADGE[row.phase]}>{label}</StatusBadge></span>
}

export function ExitCode({ code }: { code?: number }) {
  if (code === undefined) return <span className='text-content-subtle'>—</span>
  return <span className={cn('font-mono tabular-nums', code !== 0 && 'text-rose-700 dark:text-rose-300')} title={exitMeaning(code)}>{code}</span>
}

export function SlaBadge({ sla }: { sla: SlaState }) {
  if (sla.level === 'none') return <span className='text-[11px] text-content-subtle'>—</span>
  return <span title={sla.message}><StatusBadge kind={SLA_BADGE[sla.level]}>{SLA_LABEL[sla.level]}</StatusBadge></span>
}

export function DurationText({ ms, running }: { ms?: number; running?: boolean }) {
  if (ms === undefined) return <span className='text-content-subtle'>—</span>
  return <span className='tabular-nums'>{formatDuration(ms)}{running ? ' so far' : ''}</span>
}

/** The Conditions table: what the control plane or the Job controller reported. */
export function ConditionsTable({ conditions }: { conditions: ReadonlyArray<{ type?: string; status?: string; reason?: string; message?: string; lastTransitionTime?: string }> }) {
  return (
    <div className='overflow-x-auto rounded-xl border border-edge-default'>
      <table className={TABLE}>
        <thead className='bg-surface-muted'>
          <tr><th className={TH}>Type</th><th className={TH}>Status</th><th className={TH}>Reason</th><th className={TH}>Message</th><th className={TH}>Since</th></tr>
        </thead>
        <tbody className='divide-y divide-edge-subtle'>
          {conditions.map((c) => (
            <tr key={c.type}>
              <td className={cn(TD, 'font-medium')}>{c.type}</td>
              <td className={TD}><StatusBadge kind={c.status === 'True' ? 'healthy' : c.status === 'False' ? 'failed' : 'unknown'}>{c.status ?? '—'}</StatusBadge></td>
              <td className={TD}>{c.reason ?? ''}</td>
              <td className={cn(TD, 'max-w-md text-content-muted [overflow-wrap:anywhere]')}>{c.message ?? ''}</td>
              <td className={cn(TD, 'text-content-subtle')}><When at={c.lastTransitionTime} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ─────────────────────────── the page's whole-page states ─────────────────────────── */

export function BatchNotInstalled() {
  return (
    <EmptyState
      title='Batch is not available on this cluster'
      description={
        <>
          The platform’s BatchJob API (<span className='font-mono'>batchjobs.platform.adhar.io</span>) is not served here, so there is
          nothing to list and nothing has been hidden from you. It arrives with a release of the platform’s control plane; once it is
          installed, this page fills in on its own.
        </>
      }
    />
  )
}

export function BatchForbidden({ denied }: { denied: readonly string[] }) {
  return (
    <EmptyState
      title='You do not have access to batch jobs here'
      description={
        <>
          Your account may not list <span className='font-mono'>batchjobs.platform.adhar.io</span>
          {denied.length ? <> in <span className='font-mono'>{denied.join(', ')}</span></> : <> in any namespace it was checked against</>}. This does
          not mean there are none: ask your team’s owner for access to the environment you need.
        </>
      }
    />
  )
}

export function BatchLoadError({ error, onRetry }: { error: unknown; onRetry(): void }) {
  return (
    <EmptyState
      tone='error'
      title='Could not load batch jobs'
      description={error instanceof Error ? error.message : String(error)}
      action={
        <button
          type='button'
          onClick={onRetry}
          className='inline-flex h-8 items-center rounded-md border border-edge-default bg-surface-raised px-3 text-[12px] font-medium text-content shadow-sm hover:border-edge-strong'
        >
          Retry
        </button>
      }
    />
  )
}

export function BatchEmpty({ action, compact = false }: { action?: ReactNode; compact?: boolean }) {
  return (
    <EmptyState
      compact={compact}
      title='No batch jobs yet'
      description={
        <>
          A batch job is created from a template. Pick a Spring Batch template in Create New and the platform scaffolds its repository,
          builds it on every push and deploys a BatchJob to each environment of its project. It appears here as soon as its first build
          is promoted to dev.
        </>
      }
      action={
        <>
          {action}
          <a href='/catalog?section=create' className='inline-flex h-8 items-center rounded-md border border-edge-default bg-surface-raised px-3 text-[12px] font-medium text-content shadow-sm hover:border-edge-strong'>
            Browse all templates
          </a>
        </>
      }
    />
  )
}

/** What a job's definition says in one line, for headers. */
export function jobSubtitle(job: BatchJobXR, parts: { application: string; project?: string; team?: string }): string {
  return [
    job.spec?.parameters?.job ? `job ${job.spec.parameters.job}` : null,
    parts.application !== job.metadata.name ? `app ${parts.application}` : null,
    parts.project ? `project ${parts.project}` : null,
    parts.team ? `team ${parts.team}` : null,
  ].filter(Boolean).join(' · ')
}
