import { useMemo, useState } from 'react'
import { EmptyState, lensOrAll, StatusBadge, useTeamScope } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { StatTile } from '../components/list-kit.tsx'
import type { BatchJobList } from '../data/batch-model.ts'
import {
  belongsToTeam,
  candidateQueueNames,
  formatRes,
  gangRows,
  hasRes,
  isWaitingGang,
  nativePathNote,
  type ProjectRef,
  QUEUE_LEVEL_BADGE,
  QUEUE_LEVEL_LABEL,
  type QueueRow,
  queueRows,
  queuesStateOf,
  type Res,
  ROOT_QUEUE,
  rootOf,
} from '../data/batch-queues-model.ts'
import { useBatchPodGroups, useBatchQueues, usePodGroupNamespaceWatch, useSchedulerDescriptor } from '../data/batch-queues.ts'
import { Note } from './function-bits.tsx'
import { Loading, TABLE, TD, TH, useNow, When } from '../components/batch/bits.tsx'
import { GangBadge, GangProgress, GangWait } from '../components/batch/gang.tsx'

/**
 * Develop → Batch → Queues (design 0025 §7.2, Phase 2): the active team's
 * Volcano leaves — capability, deserved share, what is allocated and what is
 * waiting — and every gang in them, the waiting ones first.
 *
 * Placement (2026-11-14): §7.1 and CON-2.1 put this view in the Platform module
 * as its own federated entry, the way Builds is. It lives here instead, as a
 * tab of the Batch page, because it is built on THIS module's Batch data layer
 * (the BatchJob list decides the namespaces and the leaf names, the run drawer
 * is where a gang links to) rather than on the Platform's cluster layer, and
 * because only a tab can disappear when Volcano is not installed — a sidebar
 * entry would be a dead link on every cluster until the production gate. The
 * design's intent (rendered under Develop → Batch, `batch-*` names) holds.
 *
 * The page renders only when discovery says Volcano's scheduling API is served
 * (`batch.tsx` hides the tab otherwise). Everything is read as the signed-in
 * user: a team member sees the leaves the Team composition granted them by
 * name, a platform admin sees the hierarchy, and the team lens narrows without
 * ever emptying the page.
 */

export function BatchQueues({ list, projects, onOpenRun }: {
  list: BatchJobList | undefined
  projects: readonly ProjectRef[]
  onOpenRun(namespace: string, name: string): void
}) {
  const descriptor = useSchedulerDescriptor(true)
  const root = descriptor.data?.rootQueue || ROOT_QUEUE
  const candidates = useMemo(() => candidateQueueNames(list?.items ?? [], projects), [list?.items, projects])
  const queuesQ = useBatchQueues(candidates, root, true)
  const podGroupsQ = useBatchPodGroups(list, true)
  const { team, filtering } = useTeamScope()
  const [selected, setSelected] = useState('')

  const gangsAll = useMemo(() => podGroupsQ.data?.items ?? [], [podGroupsQ.data])
  const anyWaiting = useMemo(() => gangsAll.some((pg) => pg.status?.phase === 'Pending' || pg.status?.phase === 'Inqueue'), [gangsAll])
  const now = useNow(anyWaiting)
  const gangs = useMemo(() => gangRows(gangsAll, now), [gangsAll, now])

  const all = useMemo(() => queuesQ.data?.items ?? [], [queuesQ.data])
  // The lens narrows to the active team's leaves, and shows every readable one
  // when the team has none (a lens never empties a page).
  const rows = useMemo(() => {
    const leaves = queueRows(all, gangs, root)
    const mine = new Set(lensOrAll(all.filter((q) => leaves.some((r) => r.name === q.metadata.name)), (q) => belongsToTeam(q, team), filtering).map((q) => q.metadata.name))
    return leaves.filter((r) => mine.has(r.name))
  }, [all, gangs, root, team, filtering])
  const ceiling = useMemo(() => rootOf(all, root), [all, root])
  const state = queuesStateOf({ isLoading: queuesQ.isLoading, isError: queuesQ.isError, data: queuesQ.data }, rows.length)

  const names = useMemo(() => new Set(rows.map((r) => r.name)), [rows])
  const shownGangs = useMemo(
    () => gangs.filter((g) => g.queue && names.has(g.queue) && (!selected || g.queue === selected)),
    [gangs, names, selected],
  )
  const count = useMemo(() => ({
    waiting: gangs.filter((g) => g.queue && names.has(g.queue) && isWaitingGang(g.phase)).length,
    running: rows.reduce((n, r) => n + r.counts.running, 0),
    saturated: rows.filter((r) => r.level === 'saturated').length,
  }), [gangs, names, rows])

  const note = descriptor.data ? nativePathNote(descriptor.data) : undefined
  const loading = state === 'loading'

  return (
    <div className='space-y-4'>
      {list?.scope === 'namespaces' ? <PodGroupWatches list={list} /> : null}
      {note ? <Note>{note}</Note> : null}

      <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
        <StatTile label='Queues' value={loading ? '…' : rows.length} hint={ceiling ? `ceiling ${formatRes(ceiling.capability)}` : undefined} />
        <StatTile label='Gangs waiting' value={loading ? '…' : count.waiting} tone='amber' />
        <StatTile label='Running' value={loading ? '…' : count.running} tone='info' />
        <StatTile label='Saturated' value={loading ? '…' : count.saturated} tone='violet' hint='at capability with work waiting' />
      </div>

      {state === 'loading'
        ? <Loading label='Reading queues…' />
        : state === 'error'
        ? (
          <EmptyState
            tone='error'
            title='Could not load batch queues'
            description={queuesQ.error instanceof Error ? queuesQ.error.message : String(queuesQ.error)}
            action={
              <button type='button' onClick={() => queuesQ.refetch()} className='inline-flex h-8 items-center rounded-md border border-edge-default bg-surface-raised px-3 text-[12px] font-medium text-content shadow-sm hover:border-edge-strong'>
                Retry
              </button>
            }
          />
        )
        : state === 'forbidden'
        ? (
          <EmptyState
            title='You may not read these batch queues'
            description={
              <>
                Your account may not get <span className='font-mono'>queues.scheduling.volcano.sh</span>{' '}
                <span className='font-mono'>{queuesQ.data?.denied.join(', ')}</span>. A team is granted its own three leaves by its Team; this
                does not mean the queues are missing.
              </>
            }
          />
        )
        : state === 'empty'
        ? (
          <EmptyState
            title='No batch queues for your team yet'
            description={
              <>
                Each team gets one Volcano queue per tier — <span className='font-mono'>{'<org>-<team>-dev|test|prod'}</span> — under{' '}
                <span className='font-mono'>{root}</span>, composed by its Team. None exists for the teams your batch jobs and projects belong
                to{queuesQ.data?.missing.length ? <> (looked for <span className='font-mono'>{queuesQ.data.missing.join(', ')}</span>)</> : null}.
              </>
            }
          />
        )
        : (
          <>
            {ceiling ? <Ceiling root={root} capability={ceiling.capability} allocated={ceiling.allocated} used={ceiling.used} /> : null}
            <QueueTable rows={rows} selected={selected} onSelect={(n) => setSelected((cur) => (cur === n ? '' : n))} />
            <section className='space-y-2'>
              <div className='flex items-baseline justify-between gap-2'>
                <h3 className='text-[13px] font-semibold text-content'>
                  Gangs{selected ? <> in <span className='font-mono'>{selected}</span></> : null}
                </h3>
                {selected ? <button type='button' onClick={() => setSelected('')} className='text-[12px] text-brand-700 hover:underline dark:text-brand-300'>All queues</button> : null}
              </div>
              {podGroupsQ.data?.partial ? <Note>Some namespaces refused the list of PodGroups, so this is not every gang.</Note> : null}
              {podGroupsQ.isError && !podGroupsQ.data ? <Note tone='warn'>PodGroups could not be read, so the gangs below are unknown, not absent.</Note> : null}
              <GangTable gangs={shownGangs} loading={podGroupsQ.isLoading} onOpenRun={onOpenRun} />
            </section>
          </>
        )}
    </div>
  )
}

/** A caller who cannot watch cluster-wide watches each namespace it can read. Renders nothing. */
function PodGroupWatches({ list }: { list: BatchJobList }) {
  const readable = list.namespaces.filter((n) => !list.denied.includes(n))
  return <>{readable.map((ns) => <PodGroupWatch key={ns} namespace={ns} />)}</>
}

function PodGroupWatch({ namespace }: { namespace: string }) {
  usePodGroupNamespaceWatch(namespace)
  return null
}

function Ceiling({ root, capability, allocated, used }: { root: string; capability: Res; allocated: Res; used?: number }) {
  return (
    <p className='text-[12px] text-content-subtle'>
      All batch shares <span className='font-mono text-content'>{root}</span>: capability <span className='text-content'>{formatRes(capability)}</span>, allocated{' '}
      <span className='text-content'>{formatRes(allocated)}</span>{used !== undefined ? ` (${Math.round(used * 100)}%)` : ''}.
    </p>
  )
}

function UsageBar({ used }: { used?: number }) {
  if (used === undefined) return null
  const pct = Math.round(used * 100)
  return (
    <div className='mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-surface-sunken' aria-hidden='true'>
      <div className={cn('h-full rounded-full', pct >= 100 ? 'bg-rose-500' : pct >= 80 ? 'bg-amber-500' : 'bg-brand-600')} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  )
}

const ResCell = ({ r, empty = '—' }: { r: Res; empty?: string }) =>
  hasRes(r) ? <span className='whitespace-nowrap tabular-nums'>{formatRes(r)}</span> : <span className='text-content-subtle'>{empty}</span>

function QueueTable({ rows, selected, onSelect }: { rows: readonly QueueRow[]; selected: string; onSelect(name: string): void }) {
  return (
    <div className='overflow-x-auto rounded-xl border border-edge-default'>
      <table className={TABLE}>
        <thead className='bg-surface-muted'>
          <tr>
            <th className={TH}>Queue</th>
            <th className={TH}>State</th>
            <th className={TH}>Capability</th>
            <th className={TH}>Deserved</th>
            <th className={TH}>Allocated</th>
            <th className={TH}>Waiting</th>
            <th className={cn(TH, 'text-right')}>Running</th>
            <th className={TH}>Reclaimable</th>
            <th className={cn(TH, 'text-right')}>Priority</th>
          </tr>
        </thead>
        <tbody className='divide-y divide-edge-subtle'>
          {rows.map((r) => (
            <tr
              key={r.name}
              onClick={() => onSelect(r.name)}
              aria-selected={selected === r.name}
              className={cn('cursor-pointer hover:bg-surface-sunken', selected === r.name && 'bg-brand-50/60 dark:bg-brand-500/10')}
            >
              <td className={TD}>
                <div className='font-mono text-[12px] text-content'>{r.name}</div>
                <div className='text-[11px] text-content-subtle'>{[r.tier, r.team ? `team ${r.team}` : null].filter(Boolean).join(' · ')}</div>
              </td>
              <td className={TD}>
                <span title={r.message}><StatusBadge kind={QUEUE_LEVEL_BADGE[r.level]}>{QUEUE_LEVEL_LABEL[r.level]}</StatusBadge></span>
              </td>
              <td className={TD}><ResCell r={r.capability} empty={`inherits ${r.parent ?? 'parent'}`} /></td>
              <td className={TD}><ResCell r={r.deserved} empty='none' /></td>
              <td className={TD}>
                <ResCell r={r.allocated} empty='nothing' />
                <UsageBar used={r.used} />
              </td>
              <td className={TD}>
                <span className='tabular-nums'>{r.counts.pending + r.counts.inqueue}</span>
                {hasRes(r.demand) ? <div className='text-[11px] text-content-subtle'>needs {formatRes(r.demand)}</div> : null}
              </td>
              <td className={cn(TD, 'text-right tabular-nums')}>{r.counts.running}</td>
              <td className={TD}>{r.reclaimable === undefined ? <span className='text-content-subtle'>—</span> : r.reclaimable ? 'yes' : 'no'}</td>
              <td className={cn(TD, 'text-right tabular-nums')}>{r.priority ?? <span className='text-content-subtle'>—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function GangTable({ gangs, loading, onOpenRun }: { gangs: ReturnType<typeof gangRows>; loading: boolean; onOpenRun(namespace: string, name: string): void }) {
  if (loading) return <Loading label='Reading gangs…' />
  if (!gangs.length) {
    return <EmptyState compact title='No gangs waiting or running' description='A gang appears when a partitioned run is created: Volcano holds all of its pods back until every one of them fits.' />
  }
  return (
    <div className='overflow-x-auto rounded-xl border border-edge-default'>
      <table className={TABLE}>
        <thead className='bg-surface-muted'>
          <tr>
            <th className={TH}>Run</th>
            <th className={TH}>Queue</th>
            <th className={TH}>Phase</th>
            <th className={TH}>Members</th>
            <th className={TH}>Needs</th>
            <th className={TH}>Waiting</th>
            <th className={TH}>Why</th>
          </tr>
        </thead>
        <tbody className='divide-y divide-edge-subtle'>
          {gangs.map((g) => (
            <tr key={g.key} onClick={g.run ? () => onOpenRun(g.namespace, g.run!.name) : undefined} className={cn(g.run && 'cursor-pointer hover:bg-surface-sunken')}>
              <td className={TD}>
                <div className='font-mono text-[12px] text-content'>{g.run?.name ?? g.name}</div>
                <div className='text-[11px] text-content-subtle'>{[g.batchJob, g.namespace].filter(Boolean).join(' · ')}</div>
              </td>
              <td className={cn(TD, 'font-mono text-[12px]')}>{g.queue}</td>
              <td className={TD}><GangBadge phase={g.phase} /></td>
              <td className={TD}><GangProgress gang={g} /></td>
              <td className={TD}><ResCell r={g.minResources} /></td>
              <td className={TD}>{g.waitingMs !== undefined ? <GangWait gang={g} /> : <When at={g.createdAt} />}</td>
              <td className={cn(TD, 'max-w-md text-content-muted [overflow-wrap:anywhere]')}>{g.reason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
