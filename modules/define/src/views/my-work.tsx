import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, EmptyState, Select, Tabs, usePlaneWorkspace, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import { planeError, useUpdateIssue } from '../data/plane.ts'
import { classifyError, useMe, useProjectsData, useScopeProjects } from '../data/insights-data.ts'
import { useDrill } from '../data/insights-drill.ts'
import { DAY, endOfDay, isOpen, isOverdue, startOfDay, toMs, type WorkItem } from '../data/insights-math.ts'
import { OPEN_CATEGORIES, useDefineParams, useSetDefineParams } from '../data/insights-nav.ts'
import { MENTION_SCAN_LIMIT, useMentionScan, useRecentlyViewed, useWatchList } from '../data/my-work.ts'
import { useAllPages } from '../data/pages-store.ts'
import { ConsoleSideBadge, Loading, PriorityMark, SourceNote } from '../components/insights-ui.tsx'

/**
 * My Work — a personal inbox across every project (capped), matched to the
 * signed-in console user's Plane account by email.
 */

type Tab = 'assigned' | 'due' | 'mentioned' | 'watching' | 'recent' | 'reported'

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }

export function MyWork() {
  const params = useDefineParams()
  const setParams = useSetDefineParams()
  const tab = (['assigned', 'due', 'mentioned', 'watching', 'recent', 'reported'].includes(params.tab ?? '') ? params.tab : 'assigned') as Tab
  const scope = useScopeProjects('all')
  const data = useProjectsData(scope.projects)
  const me = useMe()
  const watch = useWatchList()
  const recent = useRecentlyViewed()
  const now = useMemo(() => Date.now(), [data.updatedAt])
  const [scan, setScan] = useState(false)
  const mentions = useMentionScan(data.items, me.planeId, me.member?.member?.display_name ?? me.member?.display_name, scan, now)
  const drill = useDrill(scope.projects)
  const pagesQ = useAllPages()
  const myNames = [me.member?.member?.display_name, me.member?.display_name, me.user?.name, me.user?.name?.replace(/\s+/g, ''), me.user?.email?.split('@')[0]]
    .filter((n): n is string => !!n)
    .map((n) => n.toLowerCase())
  const pageMentions = (pagesQ.data ?? []).filter((p) => !p.archived && (p.mentions ?? []).some((m) => myNames.includes(m.toLowerCase())))

  const mine = me.planeId ? data.items.filter((i) => isOpen(i) && i.assignees.includes(me.planeId!)) : []
  const weekEnd = endOfDay(startOfDay(now) + (7 - new Date(now).getUTCDay()) * DAY)
  const due = mine.filter((i) => {
    const d = toMs(i.targetDate)
    return d !== undefined && d <= weekEnd
  })
  const reported = me.planeId ? data.items.filter((i) => isOpen(i) && i.createdBy === me.planeId) : []
  const byId = new Map(data.items.map((i) => [i.id, i]))
  const watching = (watch.data ?? []).map((w) => byId.get(w.id)).filter((i): i is WorkItem => !!i)
  const recentItems = recent.map((r) => byId.get(r.id)).filter((i): i is WorkItem => !!i)

  const err = data.errors[0] ? classifyError(data.errors[0]) : null

  if (!me.user) return <EmptyState title="Sign in to see your work" />

  const tabs = [
    { id: 'assigned' as const, label: 'Assigned', badge: mine.length || undefined },
    { id: 'due' as const, label: 'Due this week', badge: due.length ? { kind: due.some((i) => isOverdue(i, now)) ? 'failed' as const : 'degraded' as const, value: due.length } : undefined },
    { id: 'mentioned' as const, label: 'Mentioned', badge: (mentions.data?.length ?? 0) + pageMentions.length || undefined },
    { id: 'watching' as const, label: 'Watching', badge: watching.length || undefined },
    { id: 'recent' as const, label: 'Recently viewed' },
    { id: 'reported' as const, label: 'Reported by me', badge: reported.length || undefined },
  ]

  const sorted = (xs: WorkItem[]) => [...xs].sort((a, b) => (PRIORITY_RANK[a.priority] ?? 5) - (PRIORITY_RANK[b.priority] ?? 5) || (a.targetDate ?? '9999').localeCompare(b.targetDate ?? '9999'))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-content-muted">
        <span>
          {me.member ? <>Signed in as <span className="font-medium text-content">{me.member.member?.display_name ?? me.user.name}</span> in Plane</> : me.unmatched ? null : 'Matching your Plane account…'}
          {/* No leading separator when the identity part is empty (unmatched). */}
          {me.unmatched && !me.member ? null : ' · '}
          {scope.projects.length} project{scope.projects.length === 1 ? '' : 's'}
          {scope.capped ? ` (first ${scope.projects.length} of ${scope.total})` : ''}
        </span>
        <div className="flex items-center gap-2">
            {mine.length ? <Button size="sm" onClick={() => drill.issues({ assignee: 'me', statusCategory: OPEN_CATEGORIES })}>Open in Issues</Button> : null}
        </div>
      </div>
      {err ? <SourceNote kind={err.kind} message={err.message} /> : null}
      {me.unmatched ? <SourceNote kind="other" title="You aren’t a Plane member yet" message={`No Plane member has your console email (${me.user.email}). Ask a Plane admin to invite that address — until then nothing can be "yours" here.`} /> : null}

      <Tabs tabs={tabs} value={tab} onChange={(t) => setParams({ tab: t === 'assigned' ? undefined : t })} ariaLabel="My work" />

      {data.isLoading && !data.items.length ? <Loading label="Loading your work…" /> : null}

      {tab === 'assigned' ? <Inbox items={sorted(mine)} now={now} empty="Nothing open is assigned to you." watch={watch} states={data.states} /> : null}
      {tab === 'due' ? <Inbox items={sorted(due)} now={now} empty="Nothing of yours is due this week." watch={watch} states={data.states} /> : null}
      {tab === 'reported'
        ? (
          <>
            <p className="text-[11px] text-content-subtle">Items created by your Plane account. Items created through the console are recorded under the platform's API key, so they don't appear here.</p>
            <Inbox items={sorted(reported)} now={now} empty="No open items were created by your Plane account." watch={watch} states={data.states} />
          </>
        )
        : null}
      {tab === 'watching'
        ? (
          <>
            <div className="flex items-center gap-2 text-[11px] text-content-subtle"><ConsoleSideBadge /> Plane's API has no subscriptions, so your watch list is kept by the console.</div>
            {watch.error ? <SourceNote {...classifyError(watch.error)} /> : null}
            <Inbox items={watching} now={now} empty="You're not watching anything. Use ☆ on any item to follow it." watch={watch} states={data.states} />
          </>
        )
        : null}
      {tab === 'recent'
        ? (
          <>
            <p className="text-[11px] text-content-subtle">Issues you opened from Define's dashboard, My Work or Reports in this browser.</p>
            <Inbox items={recentItems} now={now} empty="Nothing viewed yet." watch={watch} states={data.states} />
          </>
        )
        : null}
      {tab === 'mentioned'
        ? (
          <div className="space-y-3">
            {pageMentions.length
              ? (
                <div className="space-y-1.5">
                  <h3 className="text-[12px] font-semibold uppercase tracking-wider text-content-subtle">In pages</h3>
                  <ul className="divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-raised">
                    {pageMentions.map((p) => (
                      <li key={p.id}>
                        <button type="button" onClick={() => drill.open('pages', { page: p.id, project: p.project })} className="flex w-full items-baseline gap-2 px-4 py-2.5 text-left">
                          <span className="truncate text-[13px] font-medium text-content">{p.title}</span>
                          <span className="ml-auto shrink-0 text-[11px] text-content-subtle">{p.updatedByName ? `${p.updatedByName} · ` : ''}{formatRelative(p.updatedAt)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )
              : null}
            <h3 className="text-[12px] font-semibold uppercase tracking-wider text-content-subtle">In Plane comments</h3>
            <p className="text-[12px] text-content-muted">
              Plane's public API has no mention feed. Scanning reads the comments of the {Math.min(MENTION_SCAN_LIMIT, mentions.candidates)} most recently updated issues (last 14 days) — one request each, from the console's shared Plane budget.
            </p>
            {!scan
              ? <Button variant="primary" size="sm" disabled={!me.planeId || !mentions.candidates} onClick={() => setScan(true)}>Scan {mentions.candidates} recent issue{mentions.candidates === 1 ? '' : 's'}</Button>
              : mentions.isFetching
              ? <Loading label={`Scanning comments… ${mentions.scanned}/${mentions.candidates}`} />
              : mentions.error
              ? <SourceNote {...classifyError(mentions.error)} />
              : !mentions.data?.length
              ? <p className="text-[12px] text-content-subtle">No mentions of you in those comments.</p>
              : (
                <ul className="divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-raised">
                  {mentions.data.map((h) => (
                    <li key={h.comment.id} className="px-4 py-3">
                      <button type="button" onClick={() => drill.item(h.item)} className="block w-full text-left">
                        <div className="flex items-baseline gap-2">
                          {h.item.key ? <span className="font-mono text-[10px] font-semibold text-content-subtle">{h.item.key}</span> : null}
                          <span className="truncate text-[13px] font-medium text-content">{h.item.name}</span>
                          <span className="ml-auto shrink-0 text-[11px] text-content-subtle">{formatRelative(h.comment.created_at)}</span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-[12px] text-content-muted">
                          <span className="font-medium">{h.comment.actor_detail?.display_name ?? 'Someone'}:</span> {(h.comment.comment_stripped ?? h.comment.comment_html ?? '').replace(/<[^>]+>/g, ' ')}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        )
        : null}
    </div>
  )
}

function Inbox({ items, now, empty, watch, states }: { items: WorkItem[]; now: number; empty: string; watch: ReturnType<typeof useWatchList>; states: plane.State[] }) {
  if (!items.length) return <p className="rounded-xl border border-dashed border-edge-default py-8 text-center text-[12px] text-content-subtle">{empty}</p>
  return (
    <ul className="divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-raised">
      {items.map((i) => <InboxRow key={i.id} item={i} now={now} watch={watch} states={states.filter((s) => s.project === i.project)} />)}
    </ul>
  )
}

function InboxRow({ item, now, watch, states }: { item: WorkItem; now: number; watch: ReturnType<typeof useWatchList>; states: plane.State[] }) {
  const update = useUpdateIssue(item.project)
  const qc = useQueryClient()
  const slug = usePlaneWorkspace()
  const toast = useToast()
  const drill = useDrill([])
  const overdue = isOverdue(item, now)
  const watched = watch.ids.has(item.id)
  const setState = (state: string) => {
    if (state === item.state) return
    // Optimistic: patch the shared lite list so every insight view moves at once.
    const key = ['plane', 'issues-lite', slug, item.project]
    const prev = qc.getQueryData<plane.Issue[]>(key)
    qc.setQueryData<plane.Issue[]>(key, (old) => old?.map((x) => (x.id === item.id ? { ...x, state } : x)))
    update.mutate({ id: item.id, patch: { state } }, {
      onSuccess: () => {
        toast.success(`${item.key || 'Item'} moved to ${states.find((s) => s.id === state)?.name ?? 'new state'}`)
        qc.invalidateQueries({ queryKey: key })
      },
      onError: (e) => {
        qc.setQueryData(key, prev)
        toast.error("Couldn't change the state", { description: planeError(e) })
      },
    })
  }
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
      <button
        type="button"
        aria-label={watched ? 'Stop watching' : 'Watch'}
        title={watched ? 'Stop watching' : 'Watch'}
        onClick={() => watch.toggle.mutate(item, { onError: (e) => toast.error("Couldn't update your watch list", { description: classifyError(e).message }) })}
        className={cn('text-[14px] leading-none', watched ? 'text-amber-500' : 'text-content-subtle hover:text-content')}
      >
        {watched ? '★' : '☆'}
      </button>
      <button type="button" onClick={() => drill.item(item)} className="flex min-w-0 flex-1 basis-48 items-center gap-2 text-left">
        {item.key ? <span className="shrink-0 font-mono text-[10px] font-semibold text-content-subtle">{item.key}</span> : null}
        <span className="truncate text-[13px] text-content hover:underline">{item.name}</span>
      </button>
      <PriorityMark p={item.priority} />
      {item.targetDate ? <span className={cn('text-[11px] tabular-nums', overdue ? 'font-medium text-rose-700 dark:text-rose-300' : 'text-content-subtle')}>{overdue ? 'Overdue · ' : 'Due '}{item.targetDate}</span> : null}
      <Select
        aria-label={`State of ${item.key || item.name}`}
        value={item.state}
        disabled={update.isPending || !states.length}
        onChange={(e) => setState(e.target.value)}
        options={states.map((s) => ({ value: s.id, label: s.name }))}
        className="h-7 py-0.5 text-[12px]"
      />
    </li>
  )
}
