import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { Button, Can, canResource, type Column, DataTable, EmptyState, Input, Modal, Select, Tabs, useToast } from '@adhar/shell-ui'
import { formatAbsolute, formatRelative } from '@adhar/utils'
import { YamlView } from '../../components/yaml-view.tsx'
import { toYaml } from '../../data/manifest-yaml.ts'
import { type ArchivedRun, type ArchiveFilters, type Capabilities, getArchived, resubmitArchived, retryArchived, WorkflowsApiError } from '../data/api.ts'
import { compareRuns } from '../data/compare.ts'
import { WORKFLOWS } from '../data/gvr.ts'
import { type Scope, useArchive, useArchivedRun, useInvalidateWorkflows, useWorkflowCluster } from '../data/hooks.ts'
import { pageNamespace } from '../data/scope.ts'
import { msOf, runGraph, shortDuration, submitterSlug, type Workflow } from '../data/nodes.ts'
import { Drawer, ErrorNote, Loading, PhaseBadge } from './common.tsx'
import { ParamTable } from './run-view.tsx'

/**
 * History (design 0026 §6.9): the Argo archive, per namespace, through the
 * BFF — which asks `list workflows` in that namespace AS THE USER and pins it,
 * so one team cannot page through another's runs (acceptance 2). Filters are
 * an allow-list (template, phase, submitter, name, since); the console never
 * sends a field selector. An archived run opens read-only with its graph,
 * parameters and YAML; two runs can be compared; the table exports as CSV.
 */

const WorkflowCanvas = lazy(() => import('../canvas/workflow-canvas.tsx'))

const PHASES = ['Succeeded', 'Failed', 'Error', 'Running', 'Pending'] as const
const SINCE: Array<{ value: string; label: string; ms: number }> = [
  { value: '', label: 'Any time', ms: 0 },
  { value: '1d', label: 'Last 24 hours', ms: 86_400_000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
  { value: '30d', label: 'Last 30 days', ms: 30 * 86_400_000 },
]

export function HistoryView({ scope, caps, ns, uid, template, onParams }: {
  scope: Scope
  caps: Capabilities
  ns?: string
  uid?: string
  template?: string
  onParams(p: { ns?: string; uid?: string; q?: string }, push?: boolean): void
}) {
  const { namespace, options: nsOptions } = pageNamespace(scope, ns)
  const [phase, setPhase] = useState('')
  const [submitter, setSubmitter] = useState('')
  const [since, setSince] = useState('7d')
  const [tpl, setTpl] = useState(template ?? '')
  const [pages, setPages] = useState<string[]>([])
  const [compare, setCompare] = useState<string[]>([])
  useEffect(() => setTpl(template ?? ''), [template])
  useEffect(() => setPages([]), [namespace, phase, submitter, since, tpl])
  const sinceMs = SINCE.find((s) => s.value === since)?.ms ?? 0
  const filters: ArchiveFilters = useMemo(() => ({
    limit: 100,
    phase: phase || undefined,
    // Whatever was typed ("oidc:ana@x.io", "Ana@x.io"), as the label Kyverno writes.
    submitter: submitter.trim() ? submitterSlug(submitter.trim()) || undefined : undefined,
    template: tpl.trim() || undefined,
    since: sinceMs ? new Date(Math.floor((Date.now() - sinceMs) / 60_000) * 60_000).toISOString().replace(/\.\d+Z$/, 'Z') : undefined,
    continue: pages[pages.length - 1],
  // `since` is rounded to the minute so the query key does not change every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [phase, submitter, tpl, sinceMs, pages, Math.floor(Date.now() / 60_000)])
  const q = useArchive(namespace, filters, caps.archive)
  const rows = q.data?.items ?? []

  if (!caps.archive) {
    return (
      <EmptyState
        title="The run archive is not available"
        description={caps.argoServer.reachable ? 'argo-server reports no archive on this cluster.' : 'The console cannot reach argo-server, which serves the archive. Live runs are still under Runs.'}
      />
    )
  }
  const forbidden = q.error instanceof WorkflowsApiError && (q.error.status === 403 || q.error.status === 404)
  const columns: Column<ArchivedRun>[] = [
    { key: 'pick', header: <span className="sr-only">Compare</span>, width: 32, sortable: false, filter: false, cell: (r) => (
      <input
        type="checkbox"
        className="accent-brand-600"
        aria-label={`Compare ${r.name}`}
        checked={compare.includes(r.uid)}
        onClick={(e) => e.stopPropagation()}
        onChange={() => setCompare((c) => (c.includes(r.uid) ? c.filter((x) => x !== r.uid) : [...c, r.uid].slice(-2)))}
      />
    ) },
    { key: 'phase', header: 'Status', cell: (r) => <PhaseBadge phase={r.phase} />, value: (r) => r.phase, width: 110 },
    { key: 'name', header: 'Name', pinned: true, cell: (r) => <span className="font-mono text-[13px]">{r.name}</span>, value: (r) => r.name },
    { key: 'template', header: 'Template', cell: (r) => r.template ?? r.clusterTemplate ?? (r.cron ? `cron/${r.cron}` : '—'), value: (r) => r.template ?? r.clusterTemplate ?? r.cron ?? '' },
    { key: 'submitter', header: 'Submitter', cell: (r) => (r.submittedBy ?? r.submitter ?? '—').replace(/^oidc:/, ''), value: (r) => r.submittedBy ?? r.submitter ?? '' },
    { key: 'started', header: 'Started', cell: (r) => r.startedAt ? <span title={formatAbsolute(r.startedAt)}>{formatRelative(r.startedAt)}</span> : '—', value: (r) => r.startedAt ?? '' },
    { key: 'duration', header: 'Duration', numeric: true, cell: (r) => shortDuration(dur(r)), value: (r) => dur(r) ?? 0 },
    { key: 'message', header: 'Message', defaultHidden: true, cell: (r) => r.message ?? '', value: (r) => r.message ?? '' },
  ]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-xs text-content-subtle">
          <span>Namespace</span>
          <Select
            aria-label="Namespace"
            controlSize="sm"
            value={namespace ?? ''}
            onChange={(e) => onParams({ ns: e.currentTarget.value, uid: undefined })}
            options={nsOptions.map((n) => ({ value: n, label: n }))}
          />
        </label>
        <label className="space-y-1 text-xs text-content-subtle">
          <span>Template</span>
          <Input value={tpl} onChange={(e) => setTpl(e.currentTarget.value)} placeholder="any" className="h-8 w-44" aria-label="Template" />
        </label>
        <label className="space-y-1 text-xs text-content-subtle">
          <span>Status</span>
          <Select aria-label="Status" controlSize="sm" value={phase} onChange={(e) => setPhase(e.currentTarget.value)} options={[{ value: '', label: 'Any' }, ...PHASES.map((p) => ({ value: p, label: p }))]} />
        </label>
        <label className="space-y-1 text-xs text-content-subtle">
          <span>Submitter</span>
          <Input value={submitter} onChange={(e) => setSubmitter(e.currentTarget.value)} placeholder="slug" className="h-8 w-36" aria-label="Submitter" />
        </label>
        <label className="space-y-1 text-xs text-content-subtle">
          <span>When</span>
          <Select aria-label="When" controlSize="sm" value={since} onChange={(e) => setSince(e.currentTarget.value)} options={SINCE.map((s) => ({ value: s.value, label: s.label }))} />
        </label>
        <div className="ml-auto flex gap-2">
          {compare.length === 2 ? <Button size="sm" variant="secondary" onClick={() => onParams({ uid: `compare:${compare.join(',')}` }, true)}>Compare 2 runs</Button> : null}
        </div>
      </div>
      {!namespace ? <EmptyState compact title="Choose a namespace" /> : q.isLoading ? <Loading label="Reading the archive…" /> : forbidden ? (
        <EmptyState compact title={`You cannot read runs in ${namespace}`} description="The archive answers only for namespaces where your RBAC lets you list workflows." />
      ) : q.error ? <ErrorNote title="Could not read the archive" error={q.error} /> : !rows.length ? (
        <EmptyState compact title="No archived runs match" description="The archive keeps 60 days of finished runs." />
      ) : (
        <>
          <DataTable
            tableId="workflow-history"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.uid}
            onRowClick={(r) => onParams({ uid: r.uid }, true)}
            features={{ search: true, filters: true, columns: true, export: true }}
            defaultSort={{ key: 'started', dir: 'desc' }}
          />
          <div className="flex items-center gap-2 text-xs">
            {pages.length ? <Button size="xs" variant="ghost" onClick={() => setPages((p) => p.slice(0, -1))}>← Newer</Button> : null}
            {q.data?.continue ? <Button size="xs" variant="ghost" onClick={() => setPages((p) => [...p, q.data!.continue!])}>Older →</Button> : null}
          </div>
        </>
      )}
      {namespace && uid?.startsWith('compare:') ? (
        <CompareDialog namespace={namespace} uids={uid.slice(8).split(',')} onClose={() => onParams({ uid: undefined })} />
      ) : namespace && uid ? (
        <ArchivedRunView namespace={namespace} uid={uid} onClose={() => onParams({ uid: undefined })} />
      ) : null}
    </div>
  )
}

function dur(r: ArchivedRun): number | undefined {
  const s = msOf(r.startedAt), f = msOf(r.finishedAt)
  return s !== undefined && f !== undefined ? f - s : undefined
}

function ArchivedRunView({ namespace, uid, onClose }: { namespace: string; uid: string; onClose(): void }) {
  const q = useArchivedRun(namespace, uid)
  const { cluster } = useWorkflowCluster()
  const toast = useToast()
  const refresh = useInvalidateWorkflows()
  type ArchivedTab = 'graph' | 'io' | 'yaml'
  const [tab, setTab] = useState<ArchivedTab>('graph')
  const archivedTabs: Array<{ id: ArchivedTab; label: string }> = [{ id: 'graph', label: 'Graph' }, { id: 'io', label: 'Inputs & outputs' }, { id: 'yaml', label: 'YAML' }]
  const run = q.data
  const graph = useMemo(() => (run ? runGraph(run, run.status?.nodes ?? {}) : null), [run])
  const act = async (what: 'retry' | 'resubmit') => {
    try {
      const w = what === 'retry' ? await retryArchived(namespace, uid, {}, cluster) : await resubmitArchived(namespace, uid, {}, cluster)
      toast.success(what === 'retry' ? 'Retrying the archived run' : `Resubmitted as ${w.workflow?.name ?? 'a new run'}`, w.warning ? { description: w.warning } : undefined)
      refresh()
    } catch (e) {
      toast.error(`Could not ${what}`, { description: e instanceof Error ? e.message : String(e) })
    }
  }
  return (
    <Drawer
      widthKey="workflow-archived"
      eyebrow={`Archived run · ${namespace}`}
      title={run?.metadata.name ?? uid}
      badge={run?.status?.phase ? <PhaseBadge phase={run.status.phase} /> : null}
      onClose={onClose}
      actions={run ? (
        <Can check={canResource(WORKFLOWS, 'create', { namespace })}>
          {run.status?.phase === 'Failed' || run.status?.phase === 'Error' ? <Button size="sm" variant="secondary" onClick={() => act('retry')}>Retry</Button> : null}
          <Button size="sm" variant="ghost" onClick={() => act('resubmit')}>Resubmit</Button>
        </Can>
      ) : null}
    >
      {q.isLoading ? <Loading /> : q.error ? (
        <div className="p-5"><ErrorNote title="Could not read this archived run" error={q.error} /></div>
      ) : run ? (
        <div className="space-y-4 p-4 sm:p-5">
          <p className="text-xs text-content-subtle">
            {run.status?.startedAt ? `Started ${formatAbsolute(run.status.startedAt)}` : ''}
            {run.status?.finishedAt ? ` · finished ${formatAbsolute(run.status.finishedAt)}` : ''}
            {run.status?.message ? ` · ${run.status.message}` : ''}
          </p>
          <Tabs tabs={archivedTabs} value={tab} onChange={(t) => setTab(t as ArchivedTab)} ariaLabel="Archived run">
            {() => (
              <div className="pt-3">
                {tab === 'graph' ? (
                  graph && graph.nodes.length ? (
                    <Suspense fallback={<Loading label="Loading the graph…" />}>
                      <WorkflowCanvas mode="run" graph={graph} now={msOf(run.status?.finishedAt) ?? Date.now()} />
                    </Suspense>
                  ) : <EmptyState compact title="This run recorded no steps" />
                ) : null}
                {tab === 'io' ? (
                  <div className="space-y-3 text-xs">
                    <div className="rounded-xl border border-edge-default bg-surface-raised p-3">
                      <div className="mb-1 font-medium text-content-muted">Arguments</div>
                      <ParamTable params={run.spec?.arguments?.parameters ?? []} />
                    </div>
                    {Object.values(run.status?.nodes ?? {}).filter((n) => n.outputs?.parameters?.length).map((n) => (
                      <div key={n.id} className="rounded-xl border border-edge-default bg-surface-raised p-3">
                        <div className="mb-1 font-mono">{n.displayName ?? n.name}</div>
                        <ParamTable params={n.outputs!.parameters!} />
                      </div>
                    ))}
                    <p className="text-content-subtle">Logs of archived runs come from Loki within its retention; open the run's steps from Discover → Logs with the run's pod names.</p>
                  </div>
                ) : null}
                {tab === 'yaml' ? <YamlView value={toYaml(run as unknown as Record<string, unknown>)} ariaLabel="Archived run YAML" /> : null}
              </div>
            )}
          </Tabs>
        </div>
      ) : null}
    </Drawer>
  )
}

function CompareDialog({ namespace, uids, onClose }: { namespace: string; uids: string[]; onClose(): void }) {
  const { cluster, key } = useWorkflowCluster()
  const results = useQueries({
    queries: uids.slice(0, 2).map((uid) => ({ queryKey: ['workflows', 'archived', key, namespace, uid], queryFn: () => getArchived(namespace, uid, cluster), staleTime: 5 * 60_000, retry: false })),
  })
  const [a, b] = results.map((r) => r.data) as [Workflow | undefined, Workflow | undefined]
  const cmp = a && b ? compareRuns(a, b) : null
  const fmtDelta = (d?: number) => (d === undefined ? '—' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${shortDuration(Math.abs(d))}`)
  return (
    <Modal open onClose={onClose} width="xl" title="Compare two runs" footer={<div className="flex justify-end"><Button variant="ghost" onClick={onClose}>Close</Button></div>}>
      {results.some((r) => r.isLoading) ? <Loading /> : results.some((r) => r.error) ? <ErrorNote title="Could not read both runs" error={results.find((r) => r.error)?.error} /> : cmp ? (
        <div className="space-y-4 text-xs">
          <div className="grid grid-cols-2 gap-3">
            {[cmp.a, cmp.b].map((x, i) => (
              <div key={i} className="rounded-lg border border-edge-default p-3">
                <div className="font-mono text-content">{x.name}</div>
                <div className="mt-1 flex items-center gap-2"><PhaseBadge phase={x.phase} /> <span className="tabular-nums text-content-muted">{shortDuration(x.durationMs)}</span></div>
              </div>
            ))}
          </div>
          <div>
            <div className="mb-1 font-medium text-content-muted">Parameters that differ</div>
            {cmp.params.length ? (
              <table className="w-full text-left">
                <thead><tr className="text-content-subtle"><th className="py-1">Name</th><th>A</th><th>B</th></tr></thead>
                <tbody>{cmp.params.map((p) => <tr key={p.name} className="border-t border-edge-subtle font-mono"><td className="py-1 pr-2">{p.name}</td><td className="pr-2">{p.a ?? '—'}</td><td>{p.b ?? '—'}</td></tr>)}</tbody>
              </table>
            ) : <p className="text-content-subtle">Same parameters.</p>}
          </div>
          <div>
            <div className="mb-1 font-medium text-content-muted">Steps</div>
            <table className="w-full text-left">
              <thead><tr className="text-content-subtle"><th className="py-1">Step</th><th>A</th><th>B</th><th className="text-right">Δ</th></tr></thead>
              <tbody>
                {cmp.steps.map((s) => (
                  <tr key={s.step} className="border-t border-edge-subtle">
                    <td className="py-1 pr-2 font-mono">{s.step}</td>
                    <td className="pr-2">{s.aPhase ?? '—'} {s.aMs !== undefined ? `· ${shortDuration(s.aMs)}` : ''}</td>
                    <td className="pr-2">{s.bPhase ?? '—'} {s.bMs !== undefined ? `· ${shortDuration(s.bMs)}` : ''}</td>
                    <td className={`text-right tabular-nums ${s.deltaMs && s.deltaMs > 0 ? 'text-rose-600 dark:text-rose-400' : s.deltaMs && s.deltaMs < 0 ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>{fmtDelta(s.deltaMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}
