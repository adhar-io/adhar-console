import { useMemo, useState } from 'react'
import { EmptyIcon } from '../components/empty-icon.tsx'
import { Button, type Column, DataTable, EmptyState, Field, Input, SearchInput, Select, StatusBadge, type StatusKind, Tabs, useToast } from '@adhar/shell-ui'
import type { plane } from '@adhar/api-clients'
import { planeError, useArchivedModules, useDeleteModule, useModuleLifecycle, useModules, useProject, useProjectMembers } from '../data/plane.ts'
import { toWorkItem, useEpicActions, useModulesIssueIds, usePlanIssues } from '../data/planning-plane.ts'
import { storeError, toReleases, useEpicMetas, useIssuePoints, useOkrRefs, usePatchEpicMeta, useProjectMeta, useReleaseDocs } from '../data/planning-store.ts'
import { burnupByCreation, isDone, toMs, wallItems, wallNow } from '../data/planning-model.ts'
import { planningHref, usePlanningParams, useSetPlanningParams } from '../data/planning-nav.ts'
import { ArchivedSection } from '../components/archived-section.tsx'
import { CreateModuleModal } from '../components/create-forms.tsx'
import { ItemList, PickItemsModal } from '../components/cycle-detail.tsx'
import { IssueDrawer } from '../components/issue-drawer.tsx'
import { Avatar, DayLineChart, fmtDate, fmtRange, Loading, Meter, Notice, ProblemState, SectionTitle, SidePanel, Stat, usePeople, useSeriesColor } from '../components/planning-ui.tsx'

/**
 * Epics (Plane modules): progress, target dates, lead, status, child work
 * items, epic burnup, linked OKRs and releases. Plane holds the epic and its
 * membership; OKR links are console-side (`define.epic`), and releases link
 * epics from their own documents.
 */

export const EPIC_STATUS: Record<plane.Module['status'], { label: string; kind: StatusKind }> = {
  backlog: { label: 'Backlog', kind: 'unknown' },
  planned: { label: 'Planned', kind: 'info' },
  'in-progress': { label: 'In progress', kind: 'progressing' },
  paused: { label: 'Paused', kind: 'paused' },
  completed: { label: 'Completed', kind: 'healthy' },
  cancelled: { label: 'Cancelled', kind: 'failed' },
}

const progressOf = (m: plane.Module) => {
  const total = (m.total_issues ?? 0) - (m.cancelled_issues ?? 0)
  return { total, done: m.completed_issues ?? 0, pct: total ? Math.round(((m.completed_issues ?? 0) / total) * 100) : 0 }
}

export function Modules({ projectId }: { projectId?: string }) {
  const q = useModules(projectId)
  const params = usePlanningParams()
  const setParams = useSetPlanningParams()
  const metas = useEpicMetas()
  const releases = useReleaseDocs()
  const okrs = useOkrRefs()
  const { people } = usePeople()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('active')
  const [createOpen, setCreateOpen] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const archived = useArchivedModules(projectId, showArchived)
  const life = useModuleLifecycle(projectId)

  const metaBy = useMemo(() => new Map((metas.data ?? []).map((d) => [d.id, d.data])), [metas.data])
  const rel = useMemo(() => toReleases(releases.data, projectId), [releases.data, projectId])
  const open = (q.data ?? []).find((m) => m.id === params.epic)

  if (!projectId) return <EmptyState icon={<EmptyIcon name="folder" />} title="Pick a project" />
  if (q.isLoading) return <Loading label="Loading epics…" />
  if (q.isError) return <ProblemState error={q.error} onRetry={() => q.refetch()} />

  const f = search.trim().toLowerCase()
  const rows = (q.data ?? []).filter((m) =>
    (status === 'all' || (status === 'active' ? m.status !== 'completed' && m.status !== 'cancelled' : m.status === status)) &&
    (!f || m.name.toLowerCase().includes(f) || (m.description ?? '').toLowerCase().includes(f))
  )
  const now = Date.now()
  const columns: Column<plane.Module>[] = [
    {
      key: 'name',
      header: 'Epic',
      pinned: true,
      value: (m) => m.name,
      cell: (m) => (
        <span className="min-w-0">
          <span className="block truncate font-medium text-content">{m.name}</span>
          {m.description ? <span className="block truncate text-[11px] text-content-subtle">{m.description}</span> : null}
        </span>
      ),
    },
    { key: 'status', header: 'Status', value: (m) => EPIC_STATUS[m.status]?.label ?? m.status, cell: (m) => <StatusBadge kind={EPIC_STATUS[m.status]?.kind ?? 'unknown'}>{EPIC_STATUS[m.status]?.label ?? m.status}</StatusBadge> },
    {
      key: 'progress',
      header: 'Progress',
      value: (m) => progressOf(m).pct,
      cell: (m) => {
        const p = progressOf(m)
        return (
          <span className="flex items-center gap-2">
            <Meter value={p.pct} className="w-24" label="Progress" />
            <span className="text-[11px] tabular-nums text-content-muted">{p.done}/{p.total}</span>
          </span>
        )
      },
    },
    {
      key: 'lead',
      header: 'Lead',
      value: (m) => people.get(m.lead ?? '')?.name ?? '',
      cell: (m) => {
        const l = people.get(m.lead ?? '')
        return l ? <span className="inline-flex items-center gap-1.5"><Avatar person={l} size={18} />{l.name}</span> : <span className="text-content-subtle">—</span>
      },
    },
    {
      key: 'target',
      header: 'Target',
      value: (m) => m.target_date ?? '',
      cell: (m) => {
        const late = m.target_date && (toMs(m.target_date) ?? 0) + 86_400_000 < now && m.status !== 'completed' && m.status !== 'cancelled'
        return <span className={late ? 'font-medium text-rose-700 dark:text-rose-300' : 'text-content-muted'}>{fmtDate(m.target_date)}{late ? ' · late' : ''}</span>
      },
    },
    { key: 'items', header: 'Work items', numeric: true, value: (m) => m.total_issues ?? 0, cell: (m) => m.total_issues ?? 0 },
    { key: 'okrs', header: 'OKRs', numeric: true, value: (m) => metaBy.get(m.id)?.okrs?.length ?? 0, cell: (m) => metaBy.get(m.id)?.okrs?.length || '—' },
    { key: 'releases', header: 'Releases', value: (m) => rel.filter((r) => r.epics?.includes(m.id)).map((r) => r.name).join(', '), cell: (m) => rel.filter((r) => r.epics?.includes(m.id)).map((r) => r.name).join(', ') || '—' },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 basis-56"><SearchInput value={search} onChange={setSearch} placeholder="Search epics…" block /></div>
        <Select
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[{ value: 'active', label: 'Open epics' }, { value: 'all', label: 'All statuses' }, ...Object.entries(EPIC_STATUS).map(([value, m]) => ({ value, label: m.label }))]}
        />
        <Button variant="primary" onClick={() => setCreateOpen(true)}>New epic</Button>
      </div>
      {(q.data ?? []).length === 0
        ? <EmptyState icon={<EmptyIcon name="epic" />} title="No epics yet" description="Epics group the work items of one deliverable, with a lead, dates and progress." />
        : (
          <DataTable
            tableId="define-epics"
            columns={columns}
            rows={rows}
            rowKey={(m) => m.id}
            onRowClick={(m) => setParams({ epic: m.id }, { push: true })}
            features={{ columns: true, density: true }}
            defaultSort={{ key: 'target', dir: 'asc' }}
            empty={<EmptyState compact title="No epics match" />}
          />
        )}
      <ArchivedSection
        noun="epic"
        open={showArchived}
        onToggle={() => setShowArchived((v) => !v)}
        loading={archived.isLoading}
        items={(archived.data ?? []).map((m) => ({ id: m.id, name: m.name, archived_at: m.archived_at, meta: fmtRange(m.start_date, m.target_date) }))}
        onRestore={(id) => life.unarchive.mutateAsync(id)}
        restoring={life.unarchive.isPending}
      />
      {open
        ? <EpicDetail projectId={projectId} epic={open} okrs={okrs.refs} okrsError={okrs.error} meta={metaBy.get(open.id)} releases={rel.filter((r) => r.epics?.includes(open.id))} onClose={() => setParams({ epic: undefined })} />
        : null}
      <CreateModuleModal projectId={projectId} open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(m) => setParams({ epic: m.id }, { push: true })} />
    </div>
  )
}

function EpicDetail({ projectId, epic, okrs, okrsError, meta, releases, onClose }: {
  projectId: string
  epic: plane.Module
  okrs: Array<{ id: string; title: string; quarter?: string }>
  okrsError: unknown
  meta?: { okrs?: string[] } | null
  releases: Array<{ id: string; name: string; status: string; release_date?: string | null }>
  onClose(): void
}) {
  const ids = useModulesIssueIds(projectId, [epic.id])
  const issues = usePlanIssues(projectId)
  const project = useProject(projectId)
  const members = useProjectMembers(projectId)
  const pts = useIssuePoints(projectId)
  const pmeta = useProjectMeta(projectId)
  const actions = useEpicActions(projectId)
  const remove = useDeleteModule(projectId)
  const life = useModuleLifecycle(projectId)
  const patchMeta = usePatchEpicMeta()
  const { people } = usePeople()
  const color = useSeriesColor()
  const toast = useToast()
  const [tab, setTab] = useState('overview')
  const [adding, setAdding] = useState(false)
  const [openIssue, setOpenIssue] = useState<string | null>(null)
  const [start, setStart] = useState(epic.start_date ?? '')
  const [target, setTarget] = useState(epic.target_date ?? '')
  const identifier = project.data?.identifier ?? ''

  const byId = useMemo(() => new Map((issues.data ?? []).map((i) => [i.id, i])), [issues.data])
  const children = useMemo(() => (ids.ids.get(epic.id) ?? []).map((id) => byId.get(id)).filter((i): i is plane.PlanIssue => !!i), [ids.ids, epic.id, byId])
  const items = useMemo(() => children.map(toWorkItem), [children])
  const burn = useMemo(() => burnupByCreation({ items: wallItems(items), start: epic.start_date, end: epic.target_date, now: wallNow() }), [items, epic.start_date, epic.target_date])
  const p = progressOf(epic)
  const linkedOkrs = meta?.okrs ?? []
  const save = (patch: Partial<plane.Module>, msg: string) =>
    actions.update.mutate({ module: epic.id, patch }, { onSuccess: () => toast.success(msg), onError: (e) => toast.error(planeError(e, "Couldn't update the epic.")) })
  const inEpic = new Set(children.map((i) => i.id))

  return (
    <SidePanel
      widthId="define.epic"
      onClose={onClose}
      eyebrow={<>Epic <StatusBadge kind={EPIC_STATUS[epic.status]?.kind ?? 'unknown'}>{EPIC_STATUS[epic.status]?.label ?? epic.status}</StatusBadge></>}
      title={epic.name}
      meta={<span>{fmtRange(epic.start_date, epic.target_date)}{epic.description ? ` · ${epic.description}` : ''}</span>}
      actions={
        <>
          <Button
            size="sm"
            loading={life.archive.isPending}
            onClick={() =>
              life.archive.mutate(epic.id, {
                onSuccess: () => {
                  toast.success(`Archived ${epic.name}`)
                  onClose()
                },
                onError: (e) => toast.error(planeError(e, "Couldn't archive the epic.")),
              })}
          >
            Archive
          </Button>
          <Button
            size="sm"
            variant="danger"
            loading={remove.isPending}
            onClick={() => {
              if (!confirm(`Delete "${epic.name}"? Its work items stay in the project.`)) return
              remove.mutate(epic.id, { onSuccess: onClose, onError: (e) => toast.error(planeError(e, "Couldn't delete the epic.")) })
            }}
          >
            Delete
          </Button>
        </>
      }
    >
      <Tabs
        ariaLabel="Epic"
        value={tab}
        onChange={setTab}
        tabs={[{ id: 'overview', label: 'Overview' }, { id: 'items', label: 'Work items', badge: { kind: 'unknown', value: epic.total_issues ?? children.length } }, { id: 'links', label: 'OKRs & releases' }]}
      >
        {(active) => (
          <div className="space-y-6 pt-4">
            {active === 'items'
              ? (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] text-content-muted">{children.filter((i) => isDone(i)).length} of {children.length} done</span>
                    <Button size="sm" onClick={() => setAdding(true)}>Add work items</Button>
                  </div>
                  {ids.loading || issues.isLoading ? <Loading label="Loading work items…" /> : ids.error ? <ProblemState error={ids.error} /> : children.length
                    ? (
                      <ItemList
                        projectId={projectId}
                        items={children}
                        people={people}
                        identifier={identifier}
                        points={pts.points}
                        scale={pmeta.data?.estimate?.values}
                        onOpen={setOpenIssue}
                        action={(i) => (
                          <button
                            type="button"
                            className="text-[11px] text-content-subtle hover:text-content"
                            onClick={() => actions.removeIssue.mutate({ module: epic.id, issue: i.id }, { onSuccess: () => toast.success('Removed from the epic'), onError: (e) => toast.error(planeError(e, "Couldn't remove it.")) })}
                          >
                            Remove
                          </button>
                        )}
                      />
                    )
                    : <EmptyState compact title="No work items in this epic" />}
                </>
              )
              : active === 'links'
              ? (
                <>
                  <section>
                    <SectionTitle>Linked OKRs</SectionTitle>
                    {okrsError ? <Notice tone="warn">{storeError(okrsError)}</Notice> : okrs.length === 0
                      ? <p className="text-[12px] text-content-subtle">No objectives yet. Create them on the OKRs page.</p>
                      : (
                        <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
                          {okrs.map((o) => (
                            <li key={o.id} className="flex items-center gap-3 px-4 py-2">
                              <input
                                type="checkbox"
                                aria-label={`Link ${o.title}`}
                                checked={linkedOkrs.includes(o.id)}
                                onChange={(e) =>
                                  patchMeta.mutate({
                                    id: epic.id,
                                    fn: (cur) => {
                                      const set = new Set(cur?.okrs ?? [])
                                      if (e.target.checked) set.add(o.id)
                                      else set.delete(o.id)
                                      return { ...(cur ?? { project: projectId }), project: projectId, okrs: [...set] }
                                    },
                                  }, { onError: (er) => toast.error(storeError(er)) })}
                              />
                              <span className="min-w-0 flex-1 truncate text-[13px] text-content">{o.title}</span>
                              {o.quarter ? <span className="text-[11px] text-content-subtle">{o.quarter}</span> : null}
                              <a href={planningHref('okrs', { objective: o.id })} className="text-[11px] text-brand-700 hover:underline dark:text-brand-300">Open</a>
                            </li>
                          ))}
                        </ul>
                      )}
                  </section>
                  <section>
                    <SectionTitle>Releases</SectionTitle>
                    {releases.length
                      ? (
                        <ul className="space-y-1 text-[13px]">
                          {releases.map((r) => (
                            <li key={r.id} className="flex items-center gap-2">
                              <a href={planningHref('releases', { release: r.id })} className="text-brand-700 hover:underline dark:text-brand-300">{r.name}</a>
                              <span className="text-[11px] text-content-subtle">{r.status} · {fmtDate(r.release_date)}</span>
                            </li>
                          ))}
                        </ul>
                      )
                      : <p className="text-[12px] text-content-subtle">No release includes this epic. Add it from a release on the Releases page.</p>}
                  </section>
                </>
              )
              : (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat label="Progress" value={`${p.pct}%`} hint={`${p.done} of ${p.total}`} />
                    <Stat label="In progress" value={epic.started_issues ?? 0} />
                    <Stat label="Not started" value={(epic.unstarted_issues ?? 0) + (epic.backlog_issues ?? 0)} />
                    <Stat label="Target" value={fmtDate(epic.target_date)} />
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Field label="Status">
                      <Select value={epic.status} onChange={(e) => save({ status: e.target.value as plane.Module['status'] }, 'Status updated')} options={Object.entries(EPIC_STATUS).map(([value, m]) => ({ value, label: m.label }))} />
                    </Field>
                    <Field label="Lead">
                      <Select
                        value={epic.lead ?? ''}
                        onChange={(e) => save({ lead: e.target.value || null }, 'Lead updated')}
                        options={[{ value: '', label: 'No lead' }, ...(members.data ?? []).map((m) => ({ value: m.id, label: m.display_name || m.email || m.id }))]}
                      />
                    </Field>
                    <Field label="Start">
                      <Input type="date" value={start ?? ''} onChange={(e) => setStart(e.target.value)} onBlur={() => start !== (epic.start_date ?? '') && save({ start_date: start || null }, 'Start date saved')} />
                    </Field>
                    <Field label="Target">
                      <Input type="date" value={target ?? ''} onChange={(e) => setTarget(e.target.value)} onBlur={() => target !== (epic.target_date ?? '') && save({ target_date: target || null }, 'Target date saved')} />
                    </Field>
                  </div>
                  <section>
                    <SectionTitle>Burnup</SectionTitle>
                    {ids.loading || issues.isLoading ? <Loading label="Loading…" /> : burn
                      ? (
                        <>
                          <DayLineChart days={burn.days} height={200} series={[{ name: 'Scope', values: burn.scope, color: color(1) }, { name: 'Completed', values: burn.completed, color: color(0) }]} />
                          <p className="mt-2 text-[11px] text-content-subtle">Scope counts each work item from its creation date (Plane does not say when it joined the epic); completion dates come from Plane.</p>
                        </>
                      )
                      : <EmptyState compact title="No work items to chart yet" />}
                  </section>
                </>
              )}
          </div>
        )}
      </Tabs>
      {adding
        ? (
          <PickItemsModal
            title={`Add to ${epic.name}`}
            items={(issues.data ?? []).filter((i) => !inEpic.has(i.id) && i.state_group !== 'cancelled')}
            identifier={identifier}
            busy={actions.addIssues.isPending}
            onClose={() => setAdding(false)}
            onPick={(sel) =>
              actions.addIssues.mutate({ module: epic.id, issues: sel }, {
                onSuccess: () => {
                  toast.success(`Added ${sel.length} to ${epic.name}`)
                  setAdding(false)
                },
                onError: (e) => toast.error(planeError(e, "Couldn't add to the epic.")),
              })}
          />
        )
        : null}
      {openIssue ? <IssueDrawer projectId={projectId} issueId={openIssue} onClose={() => setOpenIssue(null)} onPick={setOpenIssue} /> : null}
    </SidePanel>
  )
}
