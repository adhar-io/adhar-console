import { useMemo, useState } from 'react'
import { Badge, Button, Can, canResource, type Column, DataTable, EmptyState, SearchInput } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { type CatalogEntry, catalogEntries, type Home, runStats, type RunStats } from '../data/catalog.ts'
import { WORKFLOWS } from '../data/gvr.ts'
import { type Scope, ScopeWatches, TemplateWatches, useRuns, useTemplates } from '../data/hooks.ts'
import { shortDuration, type Workflow } from '../data/nodes.ts'
import { ErrorNote, Loading, ScopeLine } from './common.tsx'
import { RunForm } from './run-form.tsx'

/**
 * The catalogue (design 0026 §6.9): WorkflowTemplates in scope, catalogue
 * ClusterWorkflowTemplates and CronWorkflows — as cards or a table — with the
 * last ten outcomes, the 7-day success rate and p50 duration of each, and Run
 * (the generated form) and History. "Open in designer", "Duplicate" and
 * "Schedule" join with the designer (W2) and schedules (W4).
 */

const HOME_TONE: Record<Home, 'brand' | 'violet' | 'emerald' | 'amber' | 'slate'> = {
  App: 'brand',
  Project: 'violet',
  Platform: 'emerald',
  Draft: 'amber',
  Unmanaged: 'slate',
}

const KIND_SHORT: Record<CatalogEntry['kind'], string> = {
  WorkflowTemplate: 'Template',
  ClusterWorkflowTemplate: 'Cluster template',
  CronWorkflow: 'Schedule',
}

export function CatalogView({ scope, q, onQuery, onOpenRun, onHistory }: {
  scope: Scope
  q?: string
  onQuery(q: string): void
  onOpenRun(w: Workflow): void
  onHistory(e: CatalogEntry): void
}) {
  const t = useTemplates(scope)
  const runs = useRuns(scope, undefined)
  const [view, setView] = useState<'cards' | 'table'>('cards')
  const [home, setHome] = useState<Home | ''>('')
  const [kind, setKind] = useState<CatalogEntry['kind'] | ''>('')
  const [approvals, setApprovals] = useState(false)
  const [running, setRunning] = useState<CatalogEntry | null>(null)
  const all = useMemo(() => (t.data ? catalogEntries(t.data.wts.items, t.data.cwts.items, t.data.crons.items) : []), [t.data])
  const now = Date.now()
  const stats = useMemo(() => new Map(all.map((e) => [e.key, runStats(e, runs.data?.items ?? [], now)])), [all, runs.data, now])
  // "Deployed in": the same template name in other namespaces of the scope.
  const envs = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const e of all) if (e.kind === 'WorkflowTemplate') m.set(e.name, [...(m.get(e.name) ?? []), e.namespace ?? ''])
    return m
  }, [all])
  const query = (q ?? '').trim().toLowerCase()
  const shown = all.filter((e) =>
    (!home || e.home === home) &&
    (!kind || e.kind === kind) &&
    (!approvals || e.hasApprovals) &&
    (!query || [e.title, e.name, e.namespace, e.description, ...e.tags, e.team].some((s) => s?.toLowerCase().includes(query)))
  )
  const mode = t.data?.wts.mode
  const denied = [...new Set([...(t.data?.wts.denied ?? []), ...(t.data?.crons.denied ?? [])])]
  return (
    <div className="space-y-4">
      <TemplateWatches scope={scope} mode={mode} queryKey={t.queryKey} />
      <ScopeWatches gvr={WORKFLOWS} mode={runs.data?.mode} namespaces={scope.namespaces.map((n) => n.namespace)} denied={runs.data?.denied} queryKeys={[runs.queryKey]} throttleMs={5_000} />
      <ScopeLine scope={scope} mode={mode} denied={denied} />
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={q ?? ''} onChange={onQuery} placeholder="Search templates…" className="w-64" />
        <select className="h-9 rounded-lg border border-edge-default bg-surface-raised px-2 text-sm" value={home} onChange={(e) => setHome(e.currentTarget.value as Home | '')} aria-label="Home">
          <option value="">Every home</option>
          {(['App', 'Project', 'Platform', 'Draft', 'Unmanaged'] as const).map((h) => <option key={h} value={h}>{h}</option>)}
        </select>
        <select className="h-9 rounded-lg border border-edge-default bg-surface-raised px-2 text-sm" value={kind} onChange={(e) => setKind(e.currentTarget.value as CatalogEntry['kind'] | '')} aria-label="Kind">
          <option value="">Every kind</option>
          <option value="WorkflowTemplate">Templates</option>
          <option value="ClusterWorkflowTemplate">Cluster templates</option>
          <option value="CronWorkflow">Schedules</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-content-muted">
          <input type="checkbox" className="accent-brand-600" checked={approvals} onChange={(e) => setApprovals(e.currentTarget.checked)} /> Has approvals
        </label>
        <div className="ml-auto inline-flex rounded-lg border border-edge-default p-0.5 text-xs" role="tablist" aria-label="Layout">
          {(['cards', 'table'] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} className={cn('rounded-md px-2.5 py-1 capitalize', view === v ? 'bg-surface-sunken font-medium text-content' : 'text-content-muted')}>
              {v}
            </button>
          ))}
        </div>
      </div>
      {t.isLoading ? <Loading label="Loading the catalogue…" /> : t.error ? <ErrorNote title="Could not read the catalogue" error={t.error} /> : !all.length ? (
        <EmptyState
          title={`No templates yet${scope.only ? ` in ${scope.only}` : ''}`}
          description="Workflow templates arrive through Git: an app's deploy/base/workflows/ or the project's automation/ folder. The designer (next release) will publish them for you."
        />
      ) : !shown.length ? (
        <EmptyState compact title="Nothing matches these filters" />
      ) : view === 'cards' ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((e) => (
            <EntryCard key={e.key} entry={e} stats={stats.get(e.key)} envs={envs.get(e.name)} onRun={() => setRunning(e)} onHistory={() => onHistory(e)} />
          ))}
        </div>
      ) : (
        <EntryTable rows={shown} stats={stats} onRun={setRunning} onHistory={onHistory} />
      )}
      {running ? (
        <RunForm
          entry={running}
          namespaces={scope.namespaces}
          onClose={() => setRunning(null)}
          onSubmitted={(w) => {
            setRunning(null)
            onOpenRun(w)
          }}
        />
      ) : null}
    </div>
  )
}

function Outcomes({ stats }: { stats?: RunStats }) {
  if (!stats || !stats.outcomes.length) return <span className="text-[11px] text-content-subtle">no runs yet</span>
  return (
    <span className="flex items-center gap-2">
      <span className="flex items-end gap-0.5" aria-label={`Last ${stats.outcomes.length} runs: ${stats.outcomes.filter((o) => o === 'ok').length} succeeded`}>
        {stats.outcomes.map((o, i) => <span key={i} className={cn('h-3 w-1.5 rounded-sm', o === 'ok' ? 'bg-emerald-500' : 'bg-rose-500')} />)}
      </span>
      {stats.successRate !== undefined ? <span className="text-[11px] tabular-nums text-content-muted">{Math.round(stats.successRate * 100)}%</span> : null}
      {stats.p50Ms !== undefined ? <span className="text-[11px] tabular-nums text-content-subtle">p50 {shortDuration(stats.p50Ms)}</span> : null}
    </span>
  )
}

function RunButton({ entry, onRun, size = 'sm' }: { entry: CatalogEntry; onRun(): void; size?: 'xs' | 'sm' }) {
  // A cluster template may run wherever the person may create runs; the form checks the namespace it picks.
  const check = canResource(WORKFLOWS, 'create', { namespace: entry.namespace })
  if (entry.kind === 'ClusterWorkflowTemplate') return <Button size={size} onClick={onRun}>Run</Button>
  return (
    <Can check={check}>
      <Button size={size} onClick={onRun}>Run</Button>
    </Can>
  )
}

function EntryCard({ entry, stats, envs, onRun, onHistory }: { entry: CatalogEntry; stats?: RunStats; envs?: string[]; onRun(): void; onHistory(): void }) {
  const others = (envs ?? []).filter((n) => n !== entry.namespace)
  return (
    <article className="flex flex-col gap-3 rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-content" title={entry.title}>{entry.title}</h3>
          <div className="truncate font-mono text-[11px] text-content-subtle">{entry.namespace ? `${entry.namespace}/` : ''}{entry.name}</div>
        </div>
        <Badge tone={HOME_TONE[entry.home]}>{entry.home}</Badge>
      </header>
      {entry.description ? <p className="line-clamp-2 text-xs text-content-muted">{entry.description}</p> : null}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <Badge>{KIND_SHORT[entry.kind]}</Badge>
        <Badge>{entry.params.length} parameter{entry.params.length === 1 ? '' : 's'}</Badge>
        {entry.hasApprovals ? <Badge tone="amber">approvals</Badge> : null}
        {entry.team ? <Badge tone="sky">{entry.team}</Badge> : null}
        {entry.schedules?.length ? <Badge tone="indigo" className="font-mono">{entry.schedules.join(' · ')}</Badge> : null}
        {entry.suspended ? <Badge tone="amber">suspended</Badge> : null}
        {entry.tags.map((t) => <Badge key={t} tone="slate">#{t}</Badge>)}
      </div>
      {others.length ? <div className="text-[11px] text-content-subtle">Also in {others.join(', ')}</div> : null}
      {entry.source ? <div className="truncate text-[11px] text-content-subtle" title={entry.source}>Managed in Git: {entry.source}</div> : null}
      <footer className="mt-auto flex items-center gap-2 border-t border-edge-subtle pt-3">
        <Outcomes stats={stats} />
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={onHistory}>History</Button>
          <RunButton entry={entry} onRun={onRun} />
        </div>
      </footer>
    </article>
  )
}

function EntryTable({ rows, stats, onRun, onHistory }: { rows: CatalogEntry[]; stats: Map<string, RunStats>; onRun(e: CatalogEntry): void; onHistory(e: CatalogEntry): void }) {
  const columns: Column<CatalogEntry>[] = [
    { key: 'title', header: 'Template', pinned: true, cell: (e) => <div><div className="font-medium text-content">{e.title}</div><div className="font-mono text-[11px] text-content-subtle">{e.name}</div></div>, value: (e) => e.title },
    { key: 'kind', header: 'Kind', cell: (e) => KIND_SHORT[e.kind], value: (e) => e.kind },
    { key: 'home', header: 'Home', cell: (e) => <Badge tone={HOME_TONE[e.home]}>{e.home}</Badge>, value: (e) => e.home },
    { key: 'namespace', header: 'Namespace', cell: (e) => e.namespace ?? 'cluster', value: (e) => e.namespace ?? '' },
    { key: 'params', header: 'Params', numeric: true, cell: (e) => e.params.length, value: (e) => e.params.length },
    { key: 'runs', header: 'Last 10', sortable: false, filter: false, cell: (e) => <Outcomes stats={stats.get(e.key)} /> },
    { key: 'team', header: 'Owner', cell: (e) => e.team ?? '—', value: (e) => e.team ?? '' },
    { key: 'actions', header: <span className="sr-only">Actions</span>, sortable: false, filter: false, cell: (e) => <div className="flex gap-1" onClick={(ev) => ev.stopPropagation()}><Button size="xs" variant="ghost" onClick={() => onHistory(e)}>History</Button><RunButton entry={e} onRun={() => onRun(e)} size="xs" /></div> },
  ]
  return <DataTable tableId="workflow-catalog" columns={columns} rows={rows} rowKey={(e) => e.key} features={{ search: false, filters: true, columns: true, export: true }} />
}
