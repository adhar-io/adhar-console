import { useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  DataTable,
  EmptyState,
  Input,
  Select,
  Spinner,
  StatusBadge,
  useToast,
  useToolPublicUrl,
  type Column,
  type StatusKind,
  useOverlayDismiss,
} from '@adhar-console/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar-console/utils'
import {
  CanvasBtn,
  edgeBetween,
  GraphCanvas,
  layoutLayers,
  statusHex,
  type CanvasEdge,
} from '../components/canvas.tsx'
import { CrdMissing } from '../components/crd-missing.tsx'
import {
  durationSecs,
  fetchNodeLogs,
  fmtDuration,
  isCrdMissing,
  isNotFound,
  levelNodes,
  nodeList,
  useCronWorkflows,
  useWorkflow,
  useWorkflows,
  useWorkflowTemplates,
  type CronWorkflow,
  type Workflow,
  type WorkflowNode,
  type WorkflowTemplate,
} from '../data/workflows.ts'

/**
 * Argo Workflows workbench.
 *
 * The platform splits execution in two: Tekton runs CI — build, test, publish
 * on a commit — and lives under Platform → CI / CD. Everything else that is a
 * DAG of containers runs on Argo Workflows, and this is where those runs,
 * their templates and their schedules are read.
 *
 * Read-only by design. `K8sClient` has generic list/get but no generic delete
 * or patch, so retry / stop / resubmit / delete are not offered here at all
 * rather than offered as buttons that cannot work; the Argo UI deep link is the
 * honest route to those.
 */

const ARGO_INSTALL_DOCS = 'https://argo-workflows.readthedocs.io/en/stable/quick-start/'
const ARGO_WRITING_DOCS = 'https://argo-workflows.readthedocs.io/en/stable/workflow-concepts/'

const PHASE_KIND: Record<string, StatusKind> = {
  Succeeded: 'healthy',
  Running: 'progressing',
  Pending: 'info',
  Failed: 'failed',
  Error: 'failed',
  Omitted: 'unknown',
  Skipped: 'unknown',
}

const PHASES = ['Running', 'Succeeded', 'Failed', 'Pending'] as const

type Tab = 'workflows' | 'templates' | 'cron'
type PhaseFilter = 'all' | 'Running' | 'Succeeded' | 'Failed' | 'Pending'

const NODE_W = 208
const NODE_H = 76
const COL_GAP = 72
const ROW_GAP = 20

export function WorkflowList() {
  const argoUrl = useToolPublicUrl('argo-workflows')
  const [tab, setTab] = useState<Tab>('workflows')
  const [search, setSearch] = useState('')
  const [phaseF, setPhaseF] = useState<PhaseFilter>('all')
  const [nsF, setNsF] = useState('all')
  const [open, setOpen] = useState<{ namespace: string; name: string } | null>(null)

  // Workflows always load — the stats strip reads from them whichever tab is
  // showing. Templates and cron load only when asked for.
  const wfq = useWorkflows()
  const tplq = useWorkflowTemplates(tab === 'templates')
  const cronq = useCronWorkflows(tab === 'cron')

  const workflows = useMemo(() => wfq.data ?? [], [wfq.data])
  const templates = useMemo(() => tplq.data ?? [], [tplq.data])
  const crons = useMemo(() => cronq.data ?? [], [cronq.data])

  const stats = useMemo(() => {
    const s = { total: workflows.length, running: 0, succeeded: 0, failed: 0, pending: 0 }
    for (const w of workflows) {
      const p = w.status?.phase
      if (p === 'Running') s.running++
      else if (p === 'Succeeded') s.succeeded++
      else if (p === 'Failed' || p === 'Error') s.failed++
      else s.pending++
    }
    return s
  }, [workflows])

  /** Namespaces present in whatever the active tab is listing. */
  const namespaces = useMemo(() => {
    const src: Array<{ metadata: { namespace?: string } }> =
      tab === 'templates' ? templates : tab === 'cron' ? crons : workflows
    return [...new Set(src.map((o) => o.metadata.namespace).filter((n): n is string => !!n))].sort()
  }, [tab, workflows, templates, crons])

  const q = search.trim().toLowerCase()
  const matches = (...fields: Array<string | undefined>) =>
    !q || fields.some((f) => f?.toLowerCase().includes(q))
  const inNs = (ns?: string) => nsF === 'all' || ns === nsF

  const wfRows = useMemo(
    () =>
      workflows.filter((w) => {
        const p = w.status?.phase
        const phaseOk = phaseF === 'all' ||
          (phaseF === 'Failed' ? p === 'Failed' || p === 'Error'
            : phaseF === 'Pending' ? p !== 'Running' && p !== 'Succeeded' && p !== 'Failed' && p !== 'Error'
            : p === phaseF)
        return phaseOk && inNs(w.metadata.namespace) &&
          matches(w.metadata.name, w.metadata.namespace, w.spec?.entrypoint)
      }),
    // `matches` / `inNs` close over search + nsF, which are in the dep list.
    [workflows, phaseF, nsF, q],
  )

  const tplRows = useMemo(
    () =>
      templates.filter((t) =>
        inNs(t.metadata.namespace) && matches(t.metadata.name, t.metadata.namespace, t.spec?.entrypoint)
      ),
    [templates, nsF, q],
  )

  const cronRows = useMemo(
    () =>
      crons.filter((c) =>
        inNs(c.metadata.namespace) &&
        matches(c.metadata.name, c.metadata.namespace, scheduleOf(c), c.spec?.workflowSpec?.entrypoint)
      ),
    [crons, nsF, q],
  )

  // A 404 for the CRD path is not an error the user can act on by retrying —
  // the operator simply isn't installed.
  if (isCrdMissing(wfq.error)) {
    return (
      <CrdMissing
        tool='Argo Workflows'
        href={ARGO_INSTALL_DOCS}
        action={argoUrl ? <ExternalLink href={argoUrl}>Open Argo Workflows</ExternalLink> : undefined}
      />
    )
  }

  if (wfq.error) {
    return (
      <EmptyState
        title="Couldn't load workflows"
        description={wfq.error instanceof Error ? wfq.error.message : 'The apiserver rejected the request.'}
      />
    )
  }

  const activeQ = tab === 'templates' ? tplq : tab === 'cron' ? cronq : wfq

  return (
    <div className='space-y-4'>
      {/* ── stats · each tile is also the phase filter ── */}
      <div className='grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5'>
        <StatTile
          label='Workflows'
          value={stats.total}
          hint='all namespaces'
          active={phaseF === 'all' && tab === 'workflows'}
          onClick={() => {
            setTab('workflows')
            setPhaseF('all')
          }}
        />
        <PhaseTile label='Running' count={stats.running} tone='progressing' phase='Running' active={phaseF} setTab={setTab} setPhase={setPhaseF} />
        <PhaseTile label='Succeeded' count={stats.succeeded} tone='healthy' phase='Succeeded' active={phaseF} setTab={setTab} setPhase={setPhaseF} />
        <PhaseTile label='Failed' count={stats.failed} tone={stats.failed ? 'failed' : undefined} phase='Failed' active={phaseF} setTab={setTab} setPhase={setPhaseF} />
        <PhaseTile label='Pending' count={stats.pending} tone={stats.pending ? 'info' : undefined} phase='Pending' active={phaseF} setTab={setTab} setPhase={setPhaseF} />
      </div>

      {/* ── search · filters · kind switcher ── */}
      <div className='flex flex-wrap items-center gap-2 rounded-2xl border border-edge-default bg-surface-raised px-3 py-2 shadow-sm'>
        <div className='inline-flex items-center rounded-lg border border-edge-default bg-surface-sunken/60 p-0.5'>
          <TabBtn on={tab === 'workflows'} onClick={() => setTab('workflows')}>Workflows</TabBtn>
          <TabBtn on={tab === 'templates'} onClick={() => setTab('templates')}>Templates</TabBtn>
          <TabBtn on={tab === 'cron'} onClick={() => setTab('cron')}>Cron</TabBtn>
        </div>
        <div className='min-w-48 flex-1'>
          <Input
            type='search'
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder='Search name, namespace, entrypoint…'
            aria-label='Search'
          />
        </div>
        {tab === 'workflows' ? (
          <Select
            value={phaseF}
            onChange={(e) => setPhaseF(e.currentTarget.value as PhaseFilter)}
            aria-label='Phase'
            title='Phase'
            options={[
              { value: 'all', label: 'Phase: all' },
              ...PHASES.map((p) => ({ value: p, label: p })),
            ]}
          />
        ) : null}
        <Select
          value={nsF}
          onChange={(e) => setNsF(e.currentTarget.value)}
          aria-label='Namespace'
          title='Namespace'
          options={[
            { value: 'all', label: 'Namespace: all' },
            ...namespaces.map((n) => ({ value: n, label: n })),
          ]}
        />
        {argoUrl ? (
          <ExternalLink className='ml-auto' href={tab === 'templates' ? `${argoUrl}/workflow-templates` : tab === 'cron' ? `${argoUrl}/cron-workflows` : `${argoUrl}/workflows`}>
            Argo Workflows
          </ExternalLink>
        ) : null}
      </div>

      {tab === 'workflows' ? (
        <DataTable<Workflow>
          tableId='develop.argo.workflows'
          loading={wfq.isLoading}
          features={{ columns: true, density: true, export: true }}
          defaultSort={{ key: 'started', dir: 'desc' }}
          columns={workflowColumns()}
          rows={wfRows}
          rowKey={(w) => `${w.metadata.namespace ?? ''}/${w.metadata.name}`}
          onRowClick={(w) => setOpen({ namespace: w.metadata.namespace ?? '', name: w.metadata.name })}
          empty={
            <WorkflowsEmpty
              filtered={workflows.length > 0}
              argoUrl={argoUrl}
              templateCount={templates.length}
            />
          }
        />
      ) : tab === 'templates' ? (
        <DataTable<WorkflowTemplate>
          tableId='develop.argo.workflowtemplates'
          loading={tplq.isLoading}
          features={{ columns: true, density: true, export: true }}
          columns={templateColumns(argoUrl)}
          rows={tplRows}
          rowKey={(t) => `${t.metadata.namespace ?? ''}/${t.metadata.name}`}
          empty={
            isCrdMissing(tplq.error)
              ? <EmptyState compact title='WorkflowTemplates are not registered on this cluster' />
              : (
                <EmptyState
                  compact
                  title={templates.length ? 'No matching templates' : 'No workflow templates'}
                  description={
                    templates.length
                      ? 'Relax the search or the namespace filter.'
                      : 'A WorkflowTemplate is a reusable workflow definition — submit it by name, or reference it from a CronWorkflow, instead of pasting the same spec into every run.'
                  }
                />
              )
          }
        />
      ) : (
        <DataTable<CronWorkflow>
          tableId='develop.argo.cronworkflows'
          loading={cronq.isLoading}
          features={{ columns: true, density: true, export: true }}
          columns={cronColumns(argoUrl)}
          rows={cronRows}
          rowKey={(c) => `${c.metadata.namespace ?? ''}/${c.metadata.name}`}
          empty={
            isCrdMissing(cronq.error)
              ? <EmptyState compact title='CronWorkflows are not registered on this cluster' />
              : (
                <EmptyState
                  compact
                  title={crons.length ? 'No matching cron workflows' : 'No cron workflows'}
                  description={
                    crons.length
                      ? 'Relax the search or the namespace filter.'
                      : 'A CronWorkflow runs a workflow on a schedule — nightly backfills, periodic reports, housekeeping.'
                  }
                />
              )
          }
        />
      )}

      {activeQ.isFetching && !activeQ.isLoading ? (
        <div className='flex items-center gap-2 text-[11px] text-content-subtle'>
          <Spinner /> refreshing
        </div>
      ) : null}

      {open
        ? (
          <WorkflowDrawer
            namespace={open.namespace}
            name={open.name}
            argoUrl={argoUrl}
            onClose={() => setOpen(null)}
          />
        )
        : null}
    </div>
  )
}

/* ─────────── columns ─────────── */

function workflowColumns(): Column<Workflow>[] {
  return [
    {
      key: 'name',
      header: 'Workflow',
      pinned: true,
      minWidth: 200,
      value: (w) => w.metadata.name,
      cell: (w) => (
        <div className='min-w-0'>
          <div className='truncate font-medium text-content'>{w.metadata.name}</div>
          <code className='truncate text-[11px] text-content-subtle'>{w.spec?.entrypoint ?? '—'}</code>
        </div>
      ),
    },
    {
      key: 'namespace',
      header: 'Namespace',
      filter: 'select',
      value: (w) => w.metadata.namespace ?? '',
      cell: (w) => <span className='text-content-muted'>{w.metadata.namespace ?? '—'}</span>,
    },
    {
      key: 'phase',
      header: 'Phase',
      filter: 'select',
      value: (w) => w.status?.phase ?? 'Unknown',
      cell: (w) => {
        const phase = w.status?.phase
        return (
          <span title={w.status?.message}>
            <StatusBadge kind={phase ? (PHASE_KIND[phase] ?? 'unknown') : 'unknown'}>
              {phase ?? 'Unknown'}
            </StatusBadge>
          </span>
        )
      },
    },
    {
      key: 'progress',
      header: 'Progress',
      width: 140,
      value: (w) => progressFraction(w.status?.progress) ?? -1,
      cell: (w) => <ProgressBar progress={w.status?.progress} />,
    },
    {
      key: 'duration',
      header: 'Duration',
      numeric: true,
      value: (w) => durationSecs(w.status?.startedAt, w.status?.finishedAt) ?? -1,
      cell: (w) => fmtDuration(durationSecs(w.status?.startedAt, w.status?.finishedAt)),
    },
    {
      key: 'started',
      header: 'Started',
      value: (w) => (w.status?.startedAt ? new Date(w.status.startedAt).getTime() : 0),
      cell: (w) =>
        w.status?.startedAt
          ? <span title={formatAbsolute(w.status.startedAt)}>{formatRelative(w.status.startedAt)}</span>
          : '—',
    },
  ]
}

function templateColumns(argoUrl: string): Column<WorkflowTemplate>[] {
  const cols: Column<WorkflowTemplate>[] = [
    {
      key: 'name',
      header: 'Template',
      pinned: true,
      minWidth: 200,
      value: (t) => t.metadata.name,
      cell: (t) => <span className='font-medium text-content'>{t.metadata.name}</span>,
    },
    {
      key: 'namespace',
      header: 'Namespace',
      filter: 'select',
      value: (t) => t.metadata.namespace ?? '',
      cell: (t) => <span className='text-content-muted'>{t.metadata.namespace ?? '—'}</span>,
    },
    {
      key: 'entrypoint',
      header: 'Entrypoint',
      value: (t) => t.spec?.entrypoint ?? '',
      cell: (t) => <code className='text-[11px] text-content-muted'>{t.spec?.entrypoint ?? '—'}</code>,
    },
    {
      key: 'steps',
      header: 'Templates',
      numeric: true,
      value: (t) => t.spec?.templates?.length ?? 0,
      cell: (t) => t.spec?.templates?.length ?? 0,
    },
    {
      key: 'created',
      header: 'Created',
      value: (t) => (t.metadata.creationTimestamp ? new Date(t.metadata.creationTimestamp).getTime() : 0),
      cell: (t) =>
        t.metadata.creationTimestamp
          ? <span title={formatAbsolute(t.metadata.creationTimestamp)}>{formatRelative(t.metadata.creationTimestamp)}</span>
          : '—',
    },
  ]
  if (argoUrl) {
    cols.push({
      key: 'open',
      header: '',
      width: 56,
      sortable: false,
      filter: false,
      align: 'right',
      cell: (t) => (
        <ExternalLink
          bare
          href={`${argoUrl}/workflow-templates/${encodeURIComponent(t.metadata.namespace ?? '')}/${encodeURIComponent(t.metadata.name)}`}
        >
          Open
        </ExternalLink>
      ),
    })
  }
  return cols
}

function cronColumns(argoUrl: string): Column<CronWorkflow>[] {
  const cols: Column<CronWorkflow>[] = [
    {
      key: 'name',
      header: 'Cron workflow',
      pinned: true,
      minWidth: 200,
      value: (c) => c.metadata.name,
      cell: (c) => <span className='font-medium text-content'>{c.metadata.name}</span>,
    },
    {
      key: 'namespace',
      header: 'Namespace',
      filter: 'select',
      value: (c) => c.metadata.namespace ?? '',
      cell: (c) => <span className='text-content-muted'>{c.metadata.namespace ?? '—'}</span>,
    },
    {
      key: 'schedule',
      header: 'Schedule',
      value: (c) => scheduleOf(c) ?? '',
      cell: (c) => (
        <span className='flex items-center gap-1.5'>
          <code className='text-[11px] text-content'>{scheduleOf(c) ?? '—'}</code>
          {c.spec?.timezone ? <span className='text-[10px] text-content-subtle'>{c.spec.timezone}</span> : null}
        </span>
      ),
    },
    {
      key: 'suspended',
      header: 'State',
      filter: 'select',
      value: (c) => (c.spec?.suspend ? 'Suspended' : 'Active'),
      cell: (c) => (
        <StatusBadge kind={c.spec?.suspend ? 'paused' : 'healthy'}>
          {c.spec?.suspend ? 'Suspended' : 'Active'}
        </StatusBadge>
      ),
    },
    {
      key: 'entrypoint',
      header: 'Entrypoint',
      value: (c) => c.spec?.workflowSpec?.entrypoint ?? '',
      cell: (c) => (
        <code className='text-[11px] text-content-muted'>{c.spec?.workflowSpec?.entrypoint ?? '—'}</code>
      ),
    },
    {
      key: 'last',
      header: 'Last run',
      value: (c) => (c.status?.lastScheduledTime ? new Date(c.status.lastScheduledTime).getTime() : 0),
      cell: (c) =>
        c.status?.lastScheduledTime
          ? <span title={formatAbsolute(c.status.lastScheduledTime)}>{formatRelative(c.status.lastScheduledTime)}</span>
          : 'never',
    },
  ]
  if (argoUrl) {
    cols.push({
      key: 'open',
      header: '',
      width: 56,
      sortable: false,
      filter: false,
      align: 'right',
      cell: (c) => (
        <ExternalLink
          bare
          href={`${argoUrl}/cron-workflows/${encodeURIComponent(c.metadata.namespace ?? '')}/${encodeURIComponent(c.metadata.name)}`}
        >
          Open
        </ExternalLink>
      ),
    })
  }
  return cols
}

/* ─────────── detail drawer ─────────── */

function WorkflowDrawer({
  namespace,
  name,
  argoUrl,
  onClose,
}: {
  namespace: string
  name: string
  argoUrl: string
  onClose(): void
}) {
  const q = useWorkflow(namespace, name)
  const wf = q.data
  const [selected, setSelected] = useState<string | null>(null)
  const [onlyProblems, setOnlyProblems] = useState(false)

  const nodes = useMemo(() => nodeList(wf), [wf])

  const graph = useMemo(() => {
    const level = levelNodes(nodes)
    const layout = layoutLayers(
      nodes.map((n) => ({ id: n.id, level: level.get(n.id) ?? 0 })),
      { nodeWidth: NODE_W, nodeHeight: NODE_H, colGap: COL_GAP, rowGap: ROW_GAP },
    )
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const edges: CanvasEdge[] = []
    for (const n of nodes) {
      const from = layout.pos.get(n.id)
      if (!from) continue
      for (const childId of n.children ?? []) {
        const to = layout.pos.get(childId)
        if (!to || !byId.has(childId)) continue
        edges.push({
          ...edgeBetween(from, to, layout.nodeWidth, layout.nodeHeight),
          kind: PHASE_KIND[n.phase ?? ''] ?? 'unknown',
          // Dashes run out of a step that is still executing.
          flowing: n.phase === 'Running',
        })
      }
    }
    return { layout, edges }
  }, [nodes])

  /** Only the phases actually present — the legend never invents states. */
  const legend = useMemo(() => {
    const seen = new Map<StatusKind, string>()
    for (const n of nodes) if (n.phase) seen.set(PHASE_KIND[n.phase] ?? 'unknown', n.phase)
    return [...seen].map(([kind, label]) => ({ kind, label })).sort((a, b) => a.label.localeCompare(b.label))
  }, [nodes])

  const node = selected ? nodes.find((n) => n.id === selected) ?? null : null
  const phase = wf?.status?.phase
  const wfUrl = argoUrl
    ? `${argoUrl}/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`
    : ''

  const problem = (n: WorkflowNode) => n.phase === 'Failed' || n.phase === 'Error'

  useOverlayDismiss(true, onClose)

  return createPortal(
    <div className='fixed inset-0 z-50 flex justify-end' role='dialog' aria-modal='true' aria-label={`Workflow ${name}`}>
      <button type='button' aria-label='Close' className='absolute inset-0 bg-scrim/40 backdrop-blur-[2px]' onClick={onClose} />
      <aside className='relative flex h-full w-full max-w-5xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl'>
        <header className='flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4'>
          <div className='min-w-0'>
            <div className='flex flex-wrap items-center gap-2'>
              <h2 className='truncate text-lg font-semibold tracking-tight text-content'>{name}</h2>
              <StatusBadge kind={phase ? (PHASE_KIND[phase] ?? 'unknown') : 'unknown'}>
                {phase ?? 'Unknown'}
              </StatusBadge>
            </div>
            <div className='mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-content-muted'>
              <span>{namespace}</span>
              {wf?.spec?.entrypoint ? <span className='font-mono'>{wf.spec.entrypoint}</span> : null}
              <span>{fmtDuration(durationSecs(wf?.status?.startedAt, wf?.status?.finishedAt))}</span>
              {wf?.status?.startedAt
                ? <span title={formatAbsolute(wf.status.startedAt)}>started {formatRelative(wf.status.startedAt)}</span>
                : null}
              {wf?.status?.progress ? <span>{wf.status.progress} steps</span> : null}
            </div>
            {wf?.status?.message
              ? <p className='mt-1.5 max-w-2xl text-xs text-content-muted'>{wf.status.message}</p>
              : null}
          </div>
          <div className='flex shrink-0 items-center gap-1.5'>
            {wfUrl ? <ExternalLink href={wfUrl}>Argo Workflows</ExternalLink> : null}
            <button
              type='button'
              onClick={onClose}
              aria-label='Close'
              className='flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content'
            >
              ✕
            </button>
          </div>
        </header>

        <div className='min-h-0 flex-1 space-y-4 overflow-y-auto p-6'>
          {q.isLoading
            ? <div className='flex items-center gap-2 text-sm text-content-muted'><Spinner /> Loading workflow…</div>
            : isNotFound(q.error)
            ? <EmptyState compact title='Workflow no longer exists' description='It may have been garbage-collected by the workflow controller.' />
            : q.error
            ? <EmptyState compact title="Couldn't load this workflow" description={q.error instanceof Error ? q.error.message : undefined} />
            : nodes.length === 0
            ? (
              <EmptyState
                compact
                title={wf?.status?.compressedNodes ? 'Node graph is compressed' : 'No steps recorded yet'}
                description={wf?.status?.compressedNodes
                  ? (
                    <>
                      The controller stored this run's node map gzipped, which the console cannot inflate.
                      {wfUrl ? <> Open it in <a className='text-brand-700 underline dark:text-brand-300' href={wfUrl} target='_blank' rel='noreferrer'>Argo Workflows ↗</a>.</> : null}
                    </>
                  )
                  : 'The controller has not scheduled any nodes for this workflow yet.'}
              />
            )
            : (
              <>
                <GraphCanvas
                  width={graph.layout.width}
                  height={graph.layout.height}
                  edges={graph.edges}
                  legend={legend}
                  className='h-[440px]'
                  ariaLabel={`Workflow graph — ${nodes.length} nodes`}
                  toolbar={
                    <CanvasBtn
                      label='Only failed steps'
                      active={onlyProblems}
                      onClick={() => setOnlyProblems((v) => !v)}
                    >
                      !
                    </CanvasBtn>
                  }
                >
                  {nodes.map((n) => {
                    const p = graph.layout.pos.get(n.id)
                    if (!p) return null
                    return (
                      <div
                        key={n.id}
                        className={cn(
                          'adhar-node-in absolute transition-opacity',
                          onlyProblems && !problem(n) && 'opacity-30',
                        )}
                        style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                      >
                        <NodeCard node={n} selected={selected === n.id} onClick={() => setSelected(n.id)} />
                      </div>
                    )
                  })}
                </GraphCanvas>

                {/* Keyed by node so a previous step's logs never linger under a new selection. */}
                <StepDetail key={node?.id ?? 'none'} node={node} namespace={namespace} workflowUrl={wfUrl} />
              </>
            )}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function NodeCard({ node, selected, onClick }: { node: WorkflowNode; selected: boolean; onClick(): void }) {
  const kind = PHASE_KIND[node.phase ?? ''] ?? 'unknown'
  return (
    <button
      type='button'
      onClick={onClick}
      title={node.name}
      className={cn(
        'flex h-full w-full flex-col items-start gap-1 rounded-xl border bg-surface-raised px-3 py-2 text-left shadow-sm transition-colors',
        selected ? 'border-brand-400 ring-2 ring-brand-400/25' : 'border-edge-default hover:border-edge-strong',
      )}
      style={{ borderLeft: `3px solid ${statusHex(kind)}` }}
    >
      <span className='w-full truncate text-[12px] font-medium text-content'>
        {node.displayName || node.name}
      </span>
      <span className='flex w-full items-center gap-1.5 text-[10px] text-content-subtle'>
        <span className='h-1.5 w-1.5 shrink-0 rounded-full' style={{ background: statusHex(kind) }} />
        <span className='truncate'>{node.phase ?? 'Unknown'}</span>
        {node.type ? <span className='truncate'>· {node.type}</span> : null}
      </span>
      <span className='truncate text-[10px] tabular-nums text-content-subtle'>
        {fmtDuration(durationSecs(node.startedAt, node.finishedAt))}
      </span>
    </button>
  )
}

/**
 * The selected step.
 *
 * Logs are only fetched when Argo itself recorded the pod name on the node.
 * Pod naming changed between Argo versions (v1 uses the node id, v2 uses
 * `<workflow>-<template>-<hash>`) and the node does not always carry it, so
 * anything else would be a guess that 404s — the Argo UI link is the honest
 * fallback.
 */
function StepDetail({
  node,
  namespace,
  workflowUrl,
}: {
  node: WorkflowNode | null
  namespace: string
  workflowUrl: string
}) {
  const toast = useToast()
  const [logs, setLogs] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  if (!node) {
    return (
      <div className='rounded-xl border border-dashed border-edge-strong bg-surface-sunken/40 px-4 py-6 text-center text-xs text-content-subtle'>
        Select a step in the graph to see its phase, timings and message.
      </div>
    )
  }

  const podName = node.type === 'Pod' ? node.podName : undefined
  const nodeUrl = workflowUrl
    ? `${workflowUrl}?nodeId=${encodeURIComponent(node.id)}&sidePanel=${encodeURIComponent(`logs:${node.id}:main`)}`
    : ''

  const loadLogs = async () => {
    if (!podName) return
    setLoading(true)
    try {
      setLogs(await fetchNodeLogs(namespace, podName))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not read logs for this step')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className='rounded-xl border border-edge-default bg-surface-raised'>
      <div className='flex flex-wrap items-start justify-between gap-3 border-b border-edge-subtle px-4 py-3'>
        <div className='min-w-0'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='truncate text-sm font-medium text-content'>{node.displayName || node.name}</span>
            <StatusBadge kind={PHASE_KIND[node.phase ?? ''] ?? 'unknown'}>{node.phase ?? 'Unknown'}</StatusBadge>
          </div>
          <code className='mt-0.5 block truncate text-[10.5px] text-content-subtle'>{node.id}</code>
        </div>
        <div className='flex shrink-0 items-center gap-1.5'>
          {podName
            ? (
              <button
                type='button'
                onClick={loadLogs}
                disabled={loading}
                className='inline-flex h-8 items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2 text-xs font-medium text-content hover:border-brand-400 hover:text-brand-700 disabled:opacity-50'
              >
                {loading ? <Spinner /> : null} {logs === null ? 'Load logs' : 'Reload logs'}
              </button>
            )
            : null}
          {nodeUrl ? <ExternalLink href={nodeUrl}>Logs in Argo</ExternalLink> : null}
        </div>
      </div>

      <dl className='grid grid-cols-2 gap-x-6 gap-y-2 px-4 py-3 text-[11.5px] sm:grid-cols-4'>
        <Fact label='Type' value={node.type ?? '—'} />
        <Fact label='Template' value={node.templateName ?? node.templateRef?.template ?? node.templateRef?.name ?? '—'} mono />
        <Fact label='Started' value={node.startedAt ? formatAbsolute(node.startedAt) : '—'} />
        <Fact label='Finished' value={node.finishedAt ? formatAbsolute(node.finishedAt) : node.phase === 'Running' ? 'running' : '—'} />
        <Fact label='Duration' value={fmtDuration(durationSecs(node.startedAt, node.finishedAt))} />
        {node.progress ? <Fact label='Progress' value={node.progress} /> : null}
        {node.hostNodeName ? <Fact label='Host node' value={node.hostNodeName} mono /> : null}
        {podName ? <Fact label='Pod' value={podName} mono /> : null}
      </dl>

      {node.message
        ? (
          <p className='border-t border-edge-subtle px-4 py-3 text-xs leading-relaxed text-content-muted'>
            {node.message}
          </p>
        )
        : null}

      {logs !== null
        ? (
          <pre className='max-h-72 overflow-auto border-t border-edge-subtle bg-surface-sunken/60 px-4 py-3 font-mono text-[11px] leading-relaxed text-content-muted'>
            {logs || 'The container produced no output.'}
          </pre>
        )
        : null}

      {!podName && !node.message
        ? (
          <p className='border-t border-edge-subtle px-4 py-3 text-xs text-content-subtle'>
            Argo did not record a pod for this step, so the console cannot read its logs directly.
            {nodeUrl ? ' Open it in Argo Workflows for the container output.' : ''}
          </p>
        )
        : null}
    </div>
  )
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className='min-w-0'>
      <dt className='text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>{label}</dt>
      <dd className={cn('truncate text-content', mono && 'font-mono text-[11px]')} title={value}>{value}</dd>
    </div>
  )
}

/* ─────────── empty state ─────────── */

function WorkflowsEmpty({
  filtered,
  argoUrl,
  templateCount,
}: {
  filtered: boolean
  argoUrl: string
  templateCount: number
}) {
  if (filtered) {
    return (
      <EmptyState compact title='No matching workflows' description='Relax the phase, namespace or search filter.' />
    )
  }
  return (
    <EmptyState
      title='No workflows have run yet'
      description={
        <>
          Argo Workflows runs everything on this platform that is a DAG of containers but isn't CI —
          data backfills, ML training, scheduled housekeeping, fan-out batch jobs. CI itself is Tekton
          and lives under Platform → CI / CD.
          {templateCount > 0
            ? <> This cluster already has {templateCount} workflow template{templateCount === 1 ? '' : 's'} you can submit from.</>
            : (
              <>
                {' '}Start by writing a <code className='font-mono'>Workflow</code> or a reusable{' '}
                <code className='font-mono'>WorkflowTemplate</code>.
              </>
            )}{' '}
          <a className='text-brand-700 underline dark:text-brand-300' href={ARGO_WRITING_DOCS} target='_blank' rel='noreferrer'>
            Workflow concepts ↗
          </a>
        </>
      }
      action={argoUrl ? <ExternalLink href={`${argoUrl}/workflows`}>Open Argo Workflows</ExternalLink> : undefined}
    />
  )
}

/* ─────────── small parts ─────────── */

function StatTile({
  label,
  value,
  hint,
  tone,
  active = false,
  onClick,
}: {
  label: string
  value: number | string
  hint?: string
  tone?: StatusKind
  active?: boolean
  onClick?(): void
}) {
  const toneText: Record<string, string> = {
    healthy: 'text-emerald-600 dark:text-emerald-300',
    degraded: 'text-amber-600 dark:text-amber-300',
    failed: 'text-rose-600 dark:text-rose-300',
    progressing: 'text-indigo-600 dark:text-indigo-300',
    info: 'text-sky-600 dark:text-sky-300',
  }
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={!onClick}
      aria-pressed={onClick ? active : undefined}
      className={cn(
        'flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors',
        active
          ? 'border-brand-300 bg-brand-50/70 dark:border-brand-500/40 dark:bg-brand-500/10'
          : 'border-edge-default bg-surface-raised hover:border-edge-strong',
        !onClick && 'cursor-default',
      )}
    >
      <span className='text-[10px] font-semibold uppercase tracking-wider text-content-subtle'>{label}</span>
      <span className={cn('text-xl font-semibold leading-none tabular-nums tracking-tight', tone ? toneText[tone] : 'text-content')}>
        {value}
      </span>
      {hint ? <span className='truncate text-[10.5px] text-content-subtle'>{hint}</span> : null}
    </button>
  )
}

function PhaseTile({
  label,
  count,
  tone,
  phase,
  active,
  setTab,
  setPhase,
}: {
  label: string
  count: number
  tone?: StatusKind
  phase: PhaseFilter
  active: PhaseFilter
  setTab(t: Tab): void
  setPhase(p: PhaseFilter): void
}) {
  return (
    <StatTile
      label={label}
      value={count}
      tone={tone}
      active={active === phase}
      onClick={() => {
        setTab('workflows')
        setPhase(active === phase ? 'all' : phase)
      }}
    />
  )
}

function TabBtn({ on, onClick, children }: { on: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      type='button'
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
        on ? 'bg-surface-raised text-content shadow-sm' : 'text-content-subtle hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

function ProgressBar({ progress }: { progress?: string }) {
  const frac = progressFraction(progress)
  if (frac === undefined) return <span className='text-content-subtle'>—</span>
  return (
    <span className='flex items-center gap-2'>
      <span className='h-1.5 w-16 overflow-hidden rounded-full bg-surface-sunken'>
        <span
          className='block h-full rounded-full bg-brand-500'
          style={{ width: `${Math.round(frac * 100)}%` }}
        />
      </span>
      <span className='text-[11px] tabular-nums text-content-muted'>{progress}</span>
    </span>
  )
}

function ExternalLink({
  href,
  children,
  className,
  bare = false,
}: {
  href: string
  children: ReactNode
  className?: string
  /** Text-only, for use inside a table cell. */
  bare?: boolean
}) {
  return (
    <a
      href={href}
      target='_blank'
      rel='noreferrer'
      onClick={(e) => e.stopPropagation()}
      className={cn(
        bare
          ? 'text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300'
          : 'inline-flex h-8 items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2 text-xs font-medium text-content hover:border-brand-400 hover:text-brand-700',
        className,
      )}
    >
      {children} <span aria-hidden>↗</span>
    </a>
  )
}

/* ─────────── helpers ─────────── */

/** Argo reports progress as `done/total`. */
function progressFraction(progress?: string): number | undefined {
  if (!progress) return undefined
  const [done, total] = progress.split('/').map((n) => Number(n))
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return undefined
  return Math.min(1, Math.max(0, done / total))
}

/** Argo ≥ 3.6 moved the single `schedule` to a `schedules` list. */
function scheduleOf(c: CronWorkflow): string | undefined {
  return c.spec?.schedules?.join(', ') || c.spec?.schedule
}

export default WorkflowList
