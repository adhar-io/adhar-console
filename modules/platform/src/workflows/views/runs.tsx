import { useMemo, useState } from 'react'
import { Button, Can, canResource, type Column, DataTable, EmptyState, Tabs, useOptionalUser, useToast } from '@adhar/shell-ui'
import { formatAbsolute, formatRelative } from '@adhar/utils'
import { deleteRun, shutdownRun } from '../data/api.ts'
import { ACTIVE_SELECTOR, FINISHED_SELECTOR, LABEL, WORKFLOWS } from '../data/gvr.ts'
import { type Scope, ScopeWatches, useInvalidateWorkflows, useNow, useRuns, useWorkflowCluster } from '../data/hooks.ts'
import { elapsedMs, isFinished, progressOf, runPhase, shortDuration, submitterOf, submitterSlug, templateOf, triggerOf, type Workflow } from '../data/nodes.ts'
import { ErrorNote, Loading, RunPhase, ScopeLine } from './common.tsx'
import { RunActions, TypedConfirm } from './run-actions.tsx'

/**
 * Runs (design 0026 §6.9): Active / Recent / Mine, live by apiserver watch —
 * one per namespace in scope, or one cluster-wide for platform staff. Rows
 * open the run view; bulk Stop and Delete ask first.
 */

export type RunsTab = 'active' | 'recent' | 'mine'

const TABS: Array<{ id: RunsTab; label: string }> = [
  { id: 'active', label: 'Active' },
  { id: 'recent', label: 'Recent' },
  { id: 'mine', label: 'Mine' },
]

const TRIGGER = { manual: 'manual', cron: 'cron', event: 'event', resubmit: 'resubmit' } as const

/** "Mine": the `adhar.io/submitter` slug Kyverno stamps, matched against the signed-in user. */
export function isMine(w: Workflow, user: { name?: string; email?: string; id?: string } | null): boolean {
  if (!user) return false
  const norm = (s: string | undefined) => (s ?? '').replace(/^oidc:/i, '').toLowerCase()
  const mine = new Set([user.name, user.email, user.id].map(norm).filter(Boolean))
  // Kyverno slugs the API server's user name, prefix included ("oidc:ana@x.io"
  // → "oidc-ana-x.io"): compare against both spellings, computed the same way.
  const slugs = new Set([...mine].flatMap((v) => [submitterSlug(v), submitterSlug(`oidc:${v}`)]))
  const label = w.metadata.labels?.[LABEL.submitter]
  if (label && slugs.has(label.toLowerCase())) return true
  const by = submitterOf(w)
  return Boolean(by && mine.has(norm(by)))
}

export function RunsView({ scope, tab, onTab, onOpen }: { scope: Scope; tab?: string; onTab(t: RunsTab): void; onOpen(w: Workflow): void }) {
  const active = (TABS.some((t) => t.id === tab) ? tab : 'active') as RunsTab
  const user = useOptionalUser()
  const selector = active === 'active' ? ACTIVE_SELECTOR : active === 'recent' ? FINISHED_SELECTOR : undefined
  const q = useRuns(scope, selector)
  const rows = useMemo(() => {
    const all = q.data?.items ?? []
    return active === 'mine' ? all.filter((w) => isMine(w, user)) : all
  }, [q.data, active, user])
  const anyRunning = rows.some((r) => !isFinished(r))
  const now = useNow(anyRunning)
  return (
    <div className="space-y-3">
      <ScopeWatches gvr={WORKFLOWS} mode={q.data?.mode} namespaces={scope.namespaces.map((n) => n.namespace)} denied={q.data?.denied} labelSelector={selector} queryKeys={[q.queryKey]} />
      <ScopeLine scope={scope} mode={q.data?.mode} denied={q.data?.denied} />
      <Tabs tabs={TABS} value={active} onChange={onTab} ariaLabel="Runs" variant="pills">
        {() => (
          <div className="pt-2">
            {q.isLoading ? <Loading label="Loading runs…" /> : q.error ? <ErrorNote title="Could not list runs" error={q.error} /> : (
              <RunTable rows={rows} now={now} onOpen={onOpen} bulk empty={EMPTY[active]} />
            )}
          </div>
        )}
      </Tabs>
    </div>
  )
}

const EMPTY: Record<RunsTab, { title: string; description: string }> = {
  active: { title: 'Nothing is running', description: 'Start one from the Catalog: Run a template.' },
  recent: { title: 'No finished runs in the TTL window', description: 'Finished runs stay a day after success and three after failure; older ones are in History.' },
  mine: { title: 'You have no runs here', description: 'Runs you submit are labelled with your name and show up here.' },
}

export function RunTable({ rows, now, onOpen, bulk = false, empty, compact = false }: {
  rows: Workflow[]
  now: number
  onOpen(w: Workflow): void
  bulk?: boolean
  empty?: { title: string; description?: string }
  compact?: boolean
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [confirm, setConfirm] = useState<null | 'stop' | 'delete'>(null)
  const { cluster } = useWorkflowCluster()
  const toast = useToast()
  const refresh = useInvalidateWorkflows()
  const keyOf = (w: Workflow) => `${w.metadata.namespace}/${w.metadata.name}`
  const chosen = rows.filter((r) => picked.has(keyOf(r)))
  const toggle = (k: string) => setPicked((s) => {
    const n = new Set(s)
    if (n.has(k)) n.delete(k)
    else n.add(k)
    return n
  })
  const columns: Column<Workflow>[] = [
    ...(bulk ? [{
      key: 'pick',
      header: <span className="sr-only">Select</span>,
      width: 32,
      sortable: false,
      filter: false as const,
      cell: (w: Workflow) => (
        <input type="checkbox" aria-label={`Select ${w.metadata.name}`} checked={picked.has(keyOf(w))} onClick={(e) => e.stopPropagation()} onChange={() => toggle(keyOf(w))} className="accent-brand-600" />
      ),
    }] : []),
    { key: 'status', header: 'Status', cell: (w) => <RunPhase run={w} />, value: (w) => runPhase(w), width: 120 },
    { key: 'name', header: 'Name', pinned: true, cell: (w) => <span className="font-mono text-[13px] text-content">{w.metadata.name}</span>, value: (w) => w.metadata.name },
    { key: 'template', header: 'Template', cell: (w) => { const t = templateOf(w); return t ? <span className="font-mono text-xs">{t.name}</span> : <span className="text-content-subtle">inline</span> }, value: (w) => templateOf(w)?.name ?? '' },
    { key: 'trigger', header: 'Trigger', cell: (w) => TRIGGER[triggerOf(w).kind], value: (w) => triggerOf(w).kind, defaultHidden: compact },
    { key: 'submitter', header: 'Submitter', cell: (w) => submitterOf(w)?.replace(/^oidc:/, '') ?? '—', value: (w) => submitterOf(w) ?? '', defaultHidden: compact },
    { key: 'started', header: 'Started', cell: (w) => w.status?.startedAt ? <span title={formatAbsolute(w.status.startedAt)}>{formatRelative(w.status.startedAt)}</span> : '—', value: (w) => w.status?.startedAt ?? w.metadata.creationTimestamp ?? '' },
    { key: 'duration', header: 'Duration', numeric: true, cell: (w) => shortDuration(elapsedMs(w.status?.startedAt, w.status?.finishedAt, now)), value: (w) => elapsedMs(w.status?.startedAt, w.status?.finishedAt, now) ?? 0 },
    { key: 'progress', header: 'Progress', cell: (w) => { const p = progressOf(w.status?.progress); return p ? `${p.done}/${p.total}` : '—' }, value: (w) => w.status?.progress ?? '', defaultHidden: compact },
    { key: 'namespace', header: 'Namespace', cell: (w) => <span className="text-xs text-content-muted">{w.metadata.namespace}</span>, value: (w) => w.metadata.namespace ?? '' },
    { key: 'actions', header: <span className="sr-only">Actions</span>, sortable: false, filter: false, cell: (w) => <RunActions run={w} compact /> },
  ]
  const bulkOp = async (op: 'stop' | 'delete') => {
    setConfirm(null)
    const targets = op === 'stop' ? chosen.filter((w) => !isFinished(w)) : chosen.filter((w) => isFinished(w))
    const res = await Promise.allSettled(targets.map((w) => op === 'stop' ? shutdownRun(w.metadata.namespace!, w.metadata.name, 'Stop', cluster) : deleteRun(w.metadata.namespace!, w.metadata.name, cluster)))
    const failed = res.filter((r) => r.status === 'rejected').length
    if (failed) toast.error(`${failed} of ${targets.length} could not be ${op === 'stop' ? 'stopped' : 'deleted'}`)
    else toast.success(`${op === 'stop' ? 'Stopping' : 'Deleted'} ${targets.length} run${targets.length === 1 ? '' : 's'}`)
    setPicked(new Set())
    refresh()
  }
  if (!rows.length) return <EmptyState compact title={empty?.title ?? 'No runs'} description={empty?.description} />
  const nsOfChosen = [...new Set(chosen.map((w) => w.metadata.namespace ?? ''))]
  return (
    <div className="space-y-2">
      {bulk && chosen.length ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-xs">
          <span>{chosen.length} selected</span>
          {chosen.some((w) => !isFinished(w)) ? (
            <Can check={nsOfChosen.map((namespace) => canResource(WORKFLOWS, 'patch', { namespace }))}>
              <Button size="xs" variant="secondary" onClick={() => setConfirm('stop')}>Stop</Button>
            </Can>
          ) : null}
          {chosen.some((w) => isFinished(w)) ? (
            <Can check={nsOfChosen.map((namespace) => canResource(WORKFLOWS, 'delete', { namespace }))}>
              <Button size="xs" variant="ghost" className="text-rose-600 dark:text-rose-400" onClick={() => setConfirm('delete')}>Delete</Button>
            </Can>
          ) : null}
          <Button size="xs" variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button>
        </div>
      ) : null}
      <DataTable
        tableId={compact ? 'workflow-runs-compact' : 'workflow-runs'}
        columns={columns}
        rows={rows}
        rowKey={keyOf}
        onRowClick={onOpen}
        features={compact ? undefined : { search: true, filters: true, columns: true, export: true }}
        dense={compact}
        defaultSort={{ key: 'started', dir: 'desc' }}
        searchPlaceholder="Search runs…"
      />
      {confirm ? (
        <TypedConfirm
          title={confirm === 'stop' ? `Stop ${chosen.filter((w) => !isFinished(w)).length} runs?` : `Delete ${chosen.filter((w) => isFinished(w)).length} runs?`}
          body={confirm === 'stop' ? 'Each stops gracefully: no new step starts, exit handlers run.' : 'The finished runs and their pods go. Archived records stay in History.'}
          name={String(confirm === 'stop' ? chosen.filter((w) => !isFinished(w)).length : chosen.filter((w) => isFinished(w)).length)}
          action={confirm === 'stop' ? 'Stop' : 'Delete'}
          onClose={() => setConfirm(null)}
          onConfirm={() => bulkOp(confirm)}
        />
      ) : null}
    </div>
  )
}
