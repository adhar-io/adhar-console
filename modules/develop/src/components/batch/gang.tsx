import { useMemo } from 'react'
import { StatusBadge, type StatusKind } from '@adhar/shell-ui'
import { cn, formatDuration } from '@adhar/utils'
import type { BatchJobXR } from '../../data/batch-model.ts'
import {
  formatRes,
  type GangPhase,
  gangPlanOf,
  type GangRow,
  gangProgress,
  gangRow,
  gangsOfJob,
  hasRes,
  isWaitingGang,
  jobQueueWarning,
  QUEUE_LEVEL_BADGE,
  QUEUE_LEVEL_LABEL,
  queueConditionOf,
  queueFitOf,
  queueOfJob,
  queueRow,
  resOf,
} from '../../data/batch-queues-model.ts'
import { useNamespaceGangs, useQueue, useRunGang, useSchedulerDescriptor, useVolcanoInstalled } from '../../data/batch-queues.ts'
import { Facts, Note, Section } from '../../views/function-bits.tsx'
import { TABLE, TD, TH } from './bits.tsx'

/**
 * A gang, as a person reads it (design 0025 §4.5): how many of its
 * all-or-nothing members are up, what phase Volcano has it in, and — while it
 * waits — Volcano's own words for why it does not fit. Used by the Queues tab
 * and by the run drawer's Gang section (`RunGang`).
 */

export const GANG_PHASE_BADGE: Record<GangPhase, StatusKind> = {
  Pending: 'paused',
  Inqueue: 'progressing',
  Running: 'progressing',
  Completed: 'healthy',
  Unknown: 'unknown',
}

export const GANG_PHASE_LABEL: Record<GangPhase, string> = {
  Pending: 'Waiting for room',
  Inqueue: 'Admitted, placing',
  Running: 'Running',
  Completed: 'Completed',
  Unknown: 'Unknown',
}

export function GangBadge({ phase }: { phase: GangPhase }) {
  return <StatusBadge kind={GANG_PHASE_BADGE[phase]}>{GANG_PHASE_LABEL[phase]}</StatusBadge>
}

export function GangProgress({ gang }: { gang: Pick<GangRow, 'ready' | 'minMember' | 'phase'> }) {
  const p = gangProgress(gang)
  return (
    <div className='flex min-w-[7rem] items-center gap-2' title={`${p.label} members up; no member starts until all ${gang.minMember} fit`}>
      <div className='h-1.5 w-16 overflow-hidden rounded-full bg-surface-sunken' aria-hidden='true'>
        <div className={cn('h-full rounded-full', isWaitingGang(gang.phase) ? 'bg-amber-500' : 'bg-brand-600')} style={{ width: `${Math.round(p.fraction * 100)}%` }} />
      </div>
      <span className='tabular-nums text-[12px]'>{p.label}</span>
    </div>
  )
}

export function GangWait({ gang }: { gang: Pick<GangRow, 'waitingMs' | 'overdue'> }) {
  if (gang.waitingMs === undefined) return <span className='text-content-subtle'>—</span>
  return (
    <span className={cn('whitespace-nowrap tabular-nums', gang.overdue && 'font-medium text-amber-700 dark:text-amber-300')} title={gang.overdue ? 'Past the 30 minutes after which BatchGangPending fires' : undefined}>
      {formatDuration(gang.waitingMs - (gang.waitingMs % 60_000) || gang.waitingMs).replace(/ 0s$/, '')}
    </span>
  )
}

/**
 * The run drawer's Gang section: the PodGroup the run is scheduled as. Renders
 * nothing for a run that has none (a native Job on the default scheduler) and
 * asks for nothing where Volcano is not installed, so the drawer can include it
 * unconditionally.
 */
export function RunGang({ namespace, run, uid, now = Date.now() }: { namespace: string; run: string; uid?: string; now?: number }) {
  const volcano = useVolcanoInstalled()
  const served = Boolean(volcano.data?.podgroups)
  const q = useRunGang(namespace, run, served, uid)
  if (!served || !q.data) return null
  const g = gangRow(q.data, now)
  const counts = [g.running ? `${g.running} running` : null, g.succeeded ? `${g.succeeded} succeeded` : null, g.failed ? `${g.failed} failed` : null].filter(Boolean)
  return (
    <section className='space-y-2'>
      <h3 className='text-[12px] font-semibold uppercase tracking-wide text-content-subtle'>Gang</h3>
      <div className='flex flex-wrap items-center gap-3 text-[12px]'>
        <GangBadge phase={g.phase} />
        <GangProgress gang={g} />
        {g.queue ? <span className='text-content-subtle'>queue <span className='font-mono text-content'>{g.queue}</span></span> : null}
        {g.waitingMs !== undefined ? <span className='text-content-subtle'>waiting <GangWait gang={g} /></span> : null}
        {counts.length ? <span className='text-content-subtle'>{counts.join(' · ')}</span> : null}
      </div>
      {g.minMember > 1 && isWaitingGang(g.phase)
        ? <p className='text-[11px] text-content-subtle'>All {g.minMember} members start together or none does: Volcano creates no pod of this run until every one of them fits.</p>
        : null}
      {g.reason ? <Note tone={g.overdue ? 'warn' : 'info'}>{g.reason}</Note> : null}
    </section>
  )
}

/* ─────────────────────────── the job drawer's Scheduling section ─────────────────────────── */

/**
 * Where a job's Volcano runs wait (design 0025 §4.3–4.5): the leaf queue it
 * targets, what one run asks for, whether that fits the leaf (DEC-3 — a gang
 * that can never be admitted, or that cannot reclaim, is said here instead of
 * leaving the run silently Pending), and the job's gangs that are waiting or
 * running now. Renders nothing, and asks for nothing, where Volcano is not
 * installed or the job resolved to the native scheduler — unless it resolved
 * there BECAUSE its queue is unavailable: the composition then reports
 * QueueFits=False with the native scheduler and no `status.queue` (a prod leaf
 * the batch root refused, a Closed leaf), which is the case DEC-3 is about.
 */
export function JobScheduling({ job, runs, now = Date.now() }: { job: BatchJobXR; runs: readonly string[]; now?: number }) {
  const volcano = useVolcanoInstalled()
  const condition = queueConditionOf(job)
  const resolved = job.status?.scheduler === 'volcano' || Boolean(job.status?.queue)
  const onVolcano = Boolean(volcano.data?.queues) && (resolved || Boolean(condition))
  const target = queueOfJob(job)
  const leaf = useQueue(target?.name, onVolcano)
  const descriptor = useSchedulerDescriptor(onVolcano)
  const namespace = job.metadata.namespace ?? ''
  const pgs = useNamespaceGangs(namespace, onVolcano && resolved && Boolean(volcano.data?.podgroups))
  const gangs = useMemo(() => gangsOfJob(job.metadata.name, runs, pgs.data?.items ?? [], now), [job.metadata.name, runs, pgs.data, now])
  if (!onVolcano) return null

  const plan = gangPlanOf(job)
  const q = leaf.data?.leaf
  const fit = target ? queueFitOf(plan, { name: target.name, leaf: q, state: leaf.data?.state ?? 'unknown' }, descriptor.data) : { level: 'unknown' as const }
  const row = q ? queueRow(q, gangs) : undefined
  const warning = jobQueueWarning(job, fit)
  const deserved = q ? resOf(q.spec?.deserved) : fit.deserved
  return (
    <Section title='Scheduling'>
      <div className='space-y-3'>
        {warning ? <Note tone='warn'>{warning}</Note> : null}
        <Facts
          rows={[
            ['Scheduler', resolved ? 'Volcano' : 'Not Volcano: its queue is unavailable (above)'],
            ['Queue', target
              ? (
                <span key='q' className='inline-flex flex-wrap items-center gap-2'>
                  <span className='font-mono text-[12px]'>{target.name}</span>
                  {row ? <StatusBadge kind={QUEUE_LEVEL_BADGE[row.level]}>{QUEUE_LEVEL_LABEL[row.level]}</StatusBadge> : null}
                  {target.reported ? null : <span className='text-content-subtle'>from its namespace’s organisation, team and tier</span>}
                </span>
              )
              : resolved ? 'Not reported yet: the control plane has not resolved it' : 'None: its leaf queue is unavailable (above)'],
            ['Queue access', leaf.data?.state === 'denied' ? 'You may not read this queue, so its capacity is not shown.' : undefined],
            ['Gang', plan.shape === 'gang' ? `${plan.members} pods (1 manager + ${plan.workers} workers), all-or-nothing` : 'One pod; Volcano gives it a PodGroup of its own'],
            ['Requests', formatRes(plan.request)],
            ['Capability', row && hasRes(row.capability) ? formatRes(row.capability) : undefined],
            ['Deserved', deserved && hasRes(deserved) ? `${formatRes(deserved)}${fit.source === 'descriptor' ? ' (the platform’s prod share)' : ''}` : q ? 'None: anything it holds can be reclaimed by prod' : undefined],
            ['Allocated', row ? formatRes(row.allocated) : undefined],
          ]}
        />
        {pgs.data?.forbidden ? <Note tone='warn'>You may not list PodGroups in {namespace}, so this job’s gangs cannot be shown.</Note> : null}
        {gangs.length
          ? (
            <div className='overflow-x-auto rounded-xl border border-edge-default'>
              <table className={TABLE}>
                <thead className='bg-surface-muted'>
                  <tr><th className={TH}>Run</th><th className={TH}>Gang</th><th className={TH}>Members</th><th className={TH}>Waiting</th><th className={TH}>Why it waits</th></tr>
                </thead>
                <tbody className='divide-y divide-edge-subtle'>
                  {gangs.map((g) => (
                    <tr key={g.key}>
                      <td className={cn(TD, 'font-mono')}>{g.run?.name ?? g.name}</td>
                      <td className={TD}><GangBadge phase={g.phase} /></td>
                      <td className={TD}><GangProgress gang={g} /></td>
                      <td className={TD}><GangWait gang={g} /></td>
                      <td className={cn(TD, 'max-w-md text-content-muted [overflow-wrap:anywhere]')}>{g.reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
          : null}
      </div>
    </Section>
  )
}
