import { useEffect, useMemo, useState } from 'react'
import { EmptyIcon } from '../components/empty-icon.tsx'
import { Button, type Column, DataTable, EmptyState, Field, Input, Markdown, Modal, Select, StatusBadge, type StatusKind, Tabs, Textarea, useToast } from '@adhar/shell-ui'
import type { plane } from '@adhar/api-clients'
import { useLabels, useModules, useProject } from '../data/plane.ts'
import { toWorkItem, useDefineNotify, useModulesIssueIds, usePlanIssues } from '../data/planning-plane.ts'
import { newId, storeError, toReleases, useIssuePoints, usePatchRelease, useProjectMeta, useReleaseDocs, useRemoveRelease } from '../data/planning-store.ts'
import { type Release, releaseBurndown, releaseHealth, type ReleaseHealth, releaseNotes, releaseProgress } from '../data/planning-releases.ts'
import { dayKey, startOfDay, toMs, wallItems, wallNow, type WorkItem } from '../data/planning-model.ts'
import { planningHref, usePlanningParams, useSetPlanningParams } from '../data/planning-nav.ts'
import { safeUrl } from '../data/work-text.ts'
import { ItemList, PickItemsModal } from '../components/cycle-detail.tsx'
import { DayLineChart, fmtDate, fmtRange, IDEAL_COLOR, Loading, Meter, Notice, ProblemState, SectionTitle, SidePanel, Stat, usePeople, useSeriesColor } from '../components/planning-ui.tsx'

/**
 * Releases (versions). Plane has no versions, so a release is a console
 * document (`define.release`): a project, dates, a status and the Plane work
 * items it ships ("fix version" links by Plane id). Progress, burndown and
 * release notes come from those items' live Plane state; a deployment link
 * points at Deliver's releases / Kargo freight.
 */

const HEALTH: Record<ReleaseHealth, { label: string; kind: StatusKind }> = {
  released: { label: 'Released', kind: 'healthy' },
  archived: { label: 'Archived', kind: 'unknown' },
  overdue: { label: 'Overdue', kind: 'degraded' },
  'due-soon': { label: 'Due soon', kind: 'paused' },
  'on-schedule': { label: 'On schedule', kind: 'progressing' },
  unscheduled: { label: 'Unscheduled', kind: 'info' },
}

export function Releases({ projectId }: { projectId?: string }) {
  const docs = useReleaseDocs()
  const issues = usePlanIssues(projectId)
  const params = useSetPlanningParams()
  const p = usePlanningParams()
  const notify = useDefineNotify(projectId)
  const [status, setStatus] = useState('open')
  const [creating, setCreating] = useState(false)
  const all = useMemo(() => toReleases(docs.data, projectId), [docs.data, projectId])
  const items = useMemo(() => new Map((issues.data ?? []).map((i) => [i.id, toWorkItem(i)] as const)), [issues.data])

  // Due-soon notifications, once per release per day (keyed), when enabled.
  useEffect(() => {
    for (const r of all) {
      const prog = releaseProgress(r, items)
      if (releaseHealth(r, prog) === 'due-soon') {
        notify('releaseDue', { title: `Release due: ${r.name}`, description: `${prog.open} open work items, due ${fmtDate(r.release_date)}`, key: `define:release-due:${r.id}:${dayKey(Date.now())}`, href: planningHref('releases', { release: r.id }) })
      }
    }
  }, [all, items, notify])

  if (!projectId) return <EmptyState icon={<EmptyIcon name="folder" />} title="Pick a project" />
  if (docs.isLoading) return <Loading label="Loading releases…" />
  if (docs.isError) return <ProblemState error={docs.error} onRetry={() => docs.refetch()} />

  const rows = all
    .filter((r) => status === 'all' || (status === 'open' ? r.status === 'unreleased' : r.status === status))
    .sort((a, b) => (a.release_date ?? '9999').localeCompare(b.release_date ?? '9999'))
  const open = all.find((r) => r.id === p.release)
  const columns: Column<Release>[] = [
    { key: 'name', header: 'Release', pinned: true, value: (r) => r.name, cell: (r) => <span className="font-medium text-content">{r.name}</span> },
    {
      key: 'health',
      header: 'Status',
      value: (r) => releaseHealth(r, releaseProgress(r, items)),
      cell: (r) => {
        const h = releaseHealth(r, releaseProgress(r, items))
        return <StatusBadge kind={HEALTH[h].kind}>{HEALTH[h].label}</StatusBadge>
      },
    },
    { key: 'dates', header: 'Dates', value: (r) => r.release_date ?? '', cell: (r) => <span className="text-content-muted">{fmtRange(r.start_date, r.release_date)}</span> },
    {
      key: 'progress',
      header: 'Progress',
      value: (r) => releaseProgress(r, items).pct,
      cell: (r) => {
        const pr = releaseProgress(r, items)
        return (
          <span className="flex items-center gap-2">
            <Meter value={pr.pct} className="w-24" label="Progress" />
            <span className="text-[11px] tabular-nums text-content-muted">{pr.done}/{pr.total}</span>
          </span>
        )
      },
    },
    { key: 'deploy', header: 'Deployment', value: (r) => r.deliver?.freight ?? r.deliver?.app ?? '', cell: (r) => (r.deliver?.app || r.deliver?.freight ? <span className="text-content-muted">{[r.deliver.app, r.deliver.stage, r.deliver.freight].filter(Boolean).join(' · ')}</span> : <span className="text-content-subtle">—</span>) },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[{ value: 'open', label: 'Unreleased' }, { value: 'released', label: 'Released' }, { value: 'archived', label: 'Archived' }, { value: 'all', label: 'All' }]}
        />
        <Button variant="primary" onClick={() => setCreating(true)}>New release</Button>
      </div>
      {all.length === 0
        ? <EmptyState icon={<EmptyIcon name="release" />} title="No releases yet" description="A release groups the work items that ship together, tracks its date and generates release notes." action={<Button variant="primary" size="sm" onClick={() => setCreating(true)}>New release</Button>} />
        : <DataTable tableId="define-releases" columns={columns} rows={rows} rowKey={(r) => r.id} onRowClick={(r) => params({ release: r.id }, { push: true })} empty={<EmptyState compact title="No releases in this view" />} />}
      {creating ? <ReleaseForm projectId={projectId} onClose={() => setCreating(false)} onSaved={(id) => params({ release: id }, { push: true })} /> : null}
      {open ? <ReleaseDetail projectId={projectId} release={open} items={items} plan={issues.data ?? []} onClose={() => params({ release: undefined })} /> : null}
    </div>
  )
}

function ReleaseForm({ projectId, release, onClose, onSaved }: { projectId: string; release?: Release; onClose(): void; onSaved?(id: string): void }) {
  const save = usePatchRelease()
  const modules = useModules(projectId)
  const toast = useToast()
  const [name, setName] = useState(release?.name ?? '')
  const [description, setDescription] = useState(release?.description ?? '')
  const [start, setStart] = useState(release?.start_date ?? '')
  const [date, setDate] = useState(release?.release_date ?? '')
  const [epics, setEpics] = useState<string[]>(release?.epics ?? [])
  return (
    <Modal
      open
      onClose={onClose}
      title={release ? `Edit ${release.name}` : 'New release'}
      description="Kept in the console; its work items stay in Plane."
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!name.trim() || (!!start && !!date && date < start)}
            loading={save.isPending}
            onClick={() => {
              const id = release?.id ?? newId('rel')
              save.mutate({
                id,
                fn: (cur) => ({
                  ...(cur ?? { project: projectId, status: 'unreleased', issues: [] }),
                  project: projectId,
                  name: name.trim(),
                  description: description.trim() || undefined,
                  start_date: start || null,
                  release_date: date || null,
                  epics,
                  status: cur?.status ?? 'unreleased',
                  issues: cur?.issues ?? [],
                }),
              }, {
                onSuccess: () => {
                  toast.success(release ? 'Release saved' : `Created ${name.trim()}`)
                  onSaved?.(id)
                  onClose()
                },
                onError: (e) => toast.error(storeError(e)),
              })
            }}
          >
            {release ? 'Save' : 'Create release'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="v1.4.0" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start">
            <Input type="date" value={start ?? ''} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Release date" error={start && date && date < start ? 'Before the start.' : undefined}>
            <Input type="date" value={date ?? ''} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Description">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Highlights, audience, risks" />
        </Field>
        <Field label="Epics" hint="Their work items can be added in one step from the release.">
          <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto pt-1">
            {(modules.data ?? []).length
              ? (modules.data ?? []).map((m) => (
                <label key={m.id} className="inline-flex items-center gap-1.5 rounded-full border border-edge-default px-2.5 py-1 text-[12px] text-content">
                  <input type="checkbox" checked={epics.includes(m.id)} onChange={(e) => setEpics(e.target.checked ? [...epics, m.id] : epics.filter((x) => x !== m.id))} />
                  {m.name}
                </label>
              ))
              : <span className="text-[12px] text-content-subtle">No epics in this project.</span>}
          </div>
        </Field>
      </div>
    </Modal>
  )
}

function ReleaseDetail({ projectId, release, items, plan, onClose }: { projectId: string; release: Release; items: Map<string, WorkItem>; plan: plane.PlanIssue[]; onClose(): void }) {
  const save = usePatchRelease()
  const remove = useRemoveRelease()
  const project = useProject(projectId)
  const labels = useLabels(projectId)
  const modules = useModules(projectId)
  const epicIds = useModulesIssueIds(projectId, release.epics ?? [])
  const pts = useIssuePoints(projectId)
  const pmeta = useProjectMeta(projectId)
  const notify = useDefineNotify(projectId)
  const { people } = usePeople()
  const color = useSeriesColor()
  const toast = useToast()
  const [tab, setTab] = useState('overview')
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const identifier = project.data?.identifier ?? ''
  const prog = releaseProgress(release, items)
  const health = releaseHealth(release, prog)
  const burn = releaseBurndown(release, new Map(wallItems([...items.values()]).map((i) => [i.id, i])), wallNow())
  const planBy = new Map(plan.map((i) => [i.id, i]))
  const inRelease = release.issues.map((id) => planBy.get(id)).filter((i): i is plane.PlanIssue => !!i)
  const missing = release.issues.length - inRelease.length
  const epicName = (id: string) => modules.data?.find((m) => m.id === id)?.name ?? 'an epic'
  const notes = useMemo(
    () =>
      releaseNotes({
        release,
        items: new Map(inRelease.map((i) => [i.id, { ...toWorkItem(i), name: i.name, sequence_id: i.sequence_id }])),
        identifier,
        labelName: (id) => labels.data?.find((l) => l.id === id)?.name ?? '',
        epicName,
      }),
    [release, inRelease.length, identifier, labels.data, modules.data, items],
  )
  const write = (fn: (cur: Omit<Release, 'id'>) => Omit<Release, 'id'>, msg: string) =>
    save.mutate({ id: release.id, fn: (cur) => fn((cur ?? release) as Omit<Release, 'id'>) }, { onSuccess: () => toast.success(msg), onError: (e) => toast.error(storeError(e)) })
  const epicItemIds = [...new Set([...(epicIds.ids.values())].flatMap((v) => v ?? []))].filter((id) => !release.issues.includes(id))
  const today = startOfDay(wallNow())
  const due = toMs(release.release_date)

  return (
    <SidePanel
      widthId="define.release"
      onClose={onClose}
      eyebrow={<>Release <StatusBadge kind={HEALTH[health].kind}>{HEALTH[health].label}</StatusBadge></>}
      title={release.name}
      meta={<span>{fmtRange(release.start_date, release.release_date)}{release.released_at ? ` · released ${fmtDate(release.released_at)}` : ''}</span>}
      actions={
        <>
          <Button size="sm" onClick={() => setEditing(true)}>Edit</Button>
          {release.status === 'unreleased'
            ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  if (prog.open && !confirm(`${prog.open} work items are not done. Mark ${release.name} released anyway?`)) return
                  write((c) => ({ ...c, status: 'released', released_at: new Date().toISOString(), notes: c.notes ?? notes }), `${release.name} released`)
                  notify('releaseShipped', { title: `Released ${release.name}`, description: `${prog.done} work items shipped`, key: `define:release:${release.id}`, href: planningHref('releases', { release: release.id }) })
                }}
              >
                Mark released
              </Button>
            )
            : <Button size="sm" onClick={() => write((c) => ({ ...c, status: 'unreleased', released_at: null }), 'Release reopened')}>Reopen</Button>}
          {release.status !== 'archived' ? <Button size="sm" onClick={() => write((c) => ({ ...c, status: 'archived' }), 'Release archived')}>Archive</Button> : null}
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              if (!confirm(`Delete ${release.name}? Its work items stay in Plane.`)) return
              remove.mutate(release.id, { onSuccess: onClose, onError: (e) => toast.error(storeError(e)) })
            }}
          >
            Delete
          </Button>
        </>
      }
    >
      <Tabs
        ariaLabel="Release"
        value={tab}
        onChange={setTab}
        tabs={[{ id: 'overview', label: 'Overview' }, { id: 'items', label: 'Work items', badge: { kind: 'unknown', value: release.issues.length } }, { id: 'notes', label: 'Release notes' }, { id: 'deploy', label: 'Deployment' }]}
      >
        {(active) => (
          <div className="space-y-6 pt-4">
            {active === 'items'
              ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[12px] text-content-muted">{prog.done} of {prog.total} done{prog.cancelled ? ` · ${prog.cancelled} cancelled` : ''}{missing ? ` · ${missing} no longer in Plane` : ''}</span>
                    <span className="flex gap-2">
                      {epicItemIds.length ? <Button size="sm" onClick={() => write((c) => ({ ...c, issues: [...new Set([...(c.issues ?? []), ...epicItemIds])] }), `Added ${epicItemIds.length} from its epics`)}>Add {epicItemIds.length} from epics</Button> : null}
                      <Button size="sm" onClick={() => setAdding(true)}>Add work items</Button>
                    </span>
                  </div>
                  {inRelease.length
                    ? (
                      <ItemList
                        projectId={projectId}
                        items={inRelease}
                        people={people}
                        identifier={identifier}
                        points={pts.points}
                        scale={pmeta.data?.estimate?.values}
                        action={(i) => <button type="button" className="text-[11px] text-content-subtle hover:text-content" onClick={() => write((c) => ({ ...c, issues: (c.issues ?? []).filter((x) => x !== i.id) }), 'Removed from the release')}>Remove</button>}
                      />
                    )
                    : <EmptyState compact title="No work items in this release" description="Add work items (their fix version), or add everything in the release's epics." />}
                </>
              )
              : active === 'notes'
              ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[12px] text-content-muted">Generated from the release's work items: done items grouped by label (feature / bug), open ones listed separately.</p>
                    <span className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => {
                          void navigator.clipboard?.writeText(notes)
                          toast.success('Release notes copied')
                        }}
                      >
                        Copy Markdown
                      </Button>
                      <Button size="sm" variant="primary" onClick={() => write((c) => ({ ...c, notes }), 'Release notes saved')}>Save as published notes</Button>
                    </span>
                  </div>
                  <div className="rounded-xl border border-edge-default bg-surface-raised p-4 text-[13px]">
                    <Markdown text={notes} />
                  </div>
                  {release.notes && release.notes !== notes ? <Notice>The saved notes differ from what the work items say now — save again to update them.</Notice> : null}
                </>
              )
              : active === 'deploy'
              ? <DeployLink release={release} onSave={(deliver) => write((c) => ({ ...c, deliver }), 'Deployment link saved')} />
              : (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat label="Progress" value={`${prog.pct}%`} hint={`${prog.done} of ${prog.total}`} />
                    <Stat label="Open" value={prog.open} tone={prog.open && health === 'overdue' ? 'bad' : undefined} />
                    <Stat label="Release date" value={fmtDate(release.release_date)} />
                    <Stat label="Epics" value={(release.epics ?? []).length} hint={(release.epics ?? []).map(epicName).join(', ') || undefined} />
                  </div>
                  {release.description ? <p className="text-[13px] text-content-muted">{release.description}</p> : null}
                  <section>
                    <SectionTitle>Burndown</SectionTitle>
                    {burn
                      ? (
                        <DayLineChart
                          days={burn.days}
                          height={200}
                          markers={[...(today >= burn.days[0] && today <= burn.days[burn.days.length - 1] ? [{ t: today, label: 'Today' }] : []), ...(due !== undefined ? [{ t: startOfDay(due), label: 'Release' }] : [])]}
                          series={[{ name: 'Open work items', values: burn.remaining, color: color(0) }, { name: 'Ideal', values: burn.ideal, color: IDEAL_COLOR, dashed: true }]}
                        />
                      )
                      : <EmptyState compact title="Nothing to chart" description="Add work items and a release date." />}
                    <p className="mt-2 text-[11px] text-content-subtle">Open items per day, from Plane completion dates, over the release's current scope.</p>
                  </section>
                </>
              )}
          </div>
        )}
      </Tabs>
      {editing ? <ReleaseForm projectId={projectId} release={release} onClose={() => setEditing(false)} /> : null}
      {adding
        ? (
          <PickItemsModal
            title={`Add to ${release.name}`}
            items={plan.filter((i) => !release.issues.includes(i.id) && i.state_group !== 'cancelled')}
            identifier={identifier}
            busy={save.isPending}
            onClose={() => setAdding(false)}
            onPick={(ids) => {
              write((c) => ({ ...c, issues: [...new Set([...(c.issues ?? []), ...ids])] }), `Added ${ids.length} work item${ids.length === 1 ? '' : 's'}`)
              setAdding(false)
            }}
          />
        )
        : null}
    </SidePanel>
  )
}

function DeployLink({ release, onSave }: { release: Release; onSave(d: Release['deliver']): void }) {
  const [app, setApp] = useState(release.deliver?.app ?? '')
  const [stage, setStage] = useState(release.deliver?.stage ?? '')
  const [freight, setFreight] = useState(release.deliver?.freight ?? '')
  const [url, setUrl] = useState(release.deliver?.url ?? '')
  return (
    <div className="space-y-4">
      <p className="text-[12px] text-content-muted">
        Point this release at what deploys it: an Argo CD application, a Kargo stage and the freight promoted for it. The console does not infer this — it is the link you record.{' '}
        <a href={planningHref('releases', {}, 'deliver')} className="text-brand-700 hover:underline dark:text-brand-300">Deliver › Releases</a> ·{' '}
        <a href={planningHref('stages', {}, 'deliver')} className="text-brand-700 hover:underline dark:text-brand-300">Kargo stages</a>
      </p>
      <form
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          onSave({ app: app.trim() || undefined, stage: stage.trim() || undefined, freight: freight.trim() || undefined, url: url.trim() || undefined })
        }}
      >
        <Field label="Argo CD application"><Input value={app} onChange={(e) => setApp(e.target.value)} placeholder="checkout-web" /></Field>
        <Field label="Kargo stage"><Input value={stage} onChange={(e) => setStage(e.target.value)} placeholder="prod" /></Field>
        <Field label="Kargo freight"><Input value={freight} onChange={(e) => setFreight(e.target.value)} placeholder="freight name or alias" /></Field>
        <Field label="Link" hint="Any URL — a Deliver page, a changelog, a tag."><Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" /></Field>
        <div className="flex items-center justify-end gap-2 sm:col-span-2">
          {release.deliver?.url && safeUrl(release.deliver.url, 'href') ? <a href={safeUrl(release.deliver.url, 'href')} target="_blank" rel="noreferrer" className="text-[12px] text-brand-700 hover:underline dark:text-brand-300">Open link ↗</a> : null}
          {release.deliver?.app ? <a href={planningHref('apps', {}, 'deliver')} className="text-[12px] text-brand-700 hover:underline dark:text-brand-300">Open app in Deliver</a> : null}
          <Button type="submit" size="sm" variant="primary">Save link</Button>
        </div>
      </form>
    </div>
  )
}

