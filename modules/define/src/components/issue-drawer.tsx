import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, DrawerWidenButton, useDrawerWidth, useOverlayDismiss, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import { memberDisplayName, planeError, useCreateIssue, useDeleteIssue, useIssue, usePlaneLink, useProjects } from '../data/plane.ts'
import { useProjectIssues, useScopeMeta, type WorkItem } from '../data/work-hooks.ts'
import { useMembers } from '../data/plane.ts'
import { issueKey } from '../data/work-ql.ts'
import { useWorkRules, useWorkRulesCtx, viewOf, WorkRulesProvider } from '../data/work-rules.ts'
import { IssueSearch } from './issue-search.tsx'
import { RichEditor, RichView } from './rich-editor.tsx'
import {
  AssigneesField,
  DateField,
  EpicField,
  EstimateField,
  type FieldData,
  LabelsField,
  PriorityField,
  SprintField,
  StateField,
  useItemEditor,
} from './issue-fields.tsx'
import {
  AttachmentsPanel,
  ChecklistPanel,
  CommentsPanel,
  DevelopmentPanel,
  HistoryPanel,
  LinksPanel,
  type PanelCtx,
  RelationsPanel,
  Section,
  SubtasksPanel,
  WatchButton,
  WorklogPanel,
} from './issue-panels.tsx'
import { Avatar, IconClose, IconCopy, IconExternal, IconTrash, InlineLoading, PlaneErrorState } from './work-ui.tsx'

/**
 * The work-item drawer (or full page, with Expand): Plane's fields plus the
 * Jira/Trello extras — sub-tasks, checklists, dependencies, links,
 * attachments, the Development panel (Gitea + Argo CD), comments with
 * @mentions, history and time tracking. Opening it from a list puts
 * `?issue=<project>/<id>` on the URL so it can be shared.
 *
 * Props are unchanged from the original drawer so Cycles, Modules, Intake
 * and the project panel keep opening it the same way.
 */

interface Props {
  projectId: string
  issueId: string
  onClose(): void
  /** Open another item of the same project (sub-task, relation). */
  onPick(id: string): void
  /** Open an item in another project; defaults to `onPick` when absent. */
  onPickIn?(projectId: string, id: string): void
}

type Tab = 'comments' | 'history' | 'worklog'

export function IssueDrawer({ projectId, issueId, onClose, onPick, onPickIn }: Props) {
  const list = useProjectIssues(projectId)
  const fromList = list.data?.find((i) => i.id === issueId)
  // Only read the single item when the project list can't supply it.
  const single = useIssue(projectId, !fromList && (list.isFetched || list.isError) ? issueId : undefined)
  const item = (fromList ?? single.data) as WorkItem | undefined
  const meta = useScopeMeta([projectId])
  const members = useMembers()
  const projects = useProjects()
  const project = projects.data?.find((p) => p.id === projectId)
  // Rules + points: the page's provider when there is one (Issues/Board/Backlog), else this project's.
  const ctxRules = useWorkRulesCtx()
  const ownRules = useWorkRules([projectId], meta.states)
  const rules = ctxRules ?? ownRules
  const edit = useItemEditor(rules)
  const remove = useDeleteIssue(projectId)
  const duplicate = useCreateIssue(projectId)
  const toast = useToast()
  // Wide mode (header toggle, shared by every side drawer); remembered.
  const width = useDrawerWidth('define.issue', { base: 'max-w-5xl' })
  const expanded = width.wide
  const [editingDesc, setEditingDesc] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [tab, setTab] = useState<Tab>('comments')
  const [parentPick, setParentPick] = useState(false)

  useOverlayDismiss(true, () => {
    if (!editingDesc && !editingTitle) onClose()
  })

  const data: FieldData = useMemo(() => ({
    states: meta.states,
    labels: meta.labels,
    cycles: meta.cycles,
    modules: meta.modules,
    members: members.data ?? [],
    stateById: new Map(meta.states.map((s) => [s.id, s])),
    labelById: new Map(meta.labels.map((l) => [l.id, l])),
    memberById: new Map((members.data ?? []).map((m) => [m.member?.id ?? m.id, m])),
    cycleById: new Map(meta.cycles.map((c) => [c.id, c])),
    moduleById: new Map(meta.modules.map((m) => [m.id, m])),
  }), [meta, members.data])

  const projList = (projects.data ?? []).map((p) => ({ id: p.id, identifier: p.identifier, name: p.name }))
  const keyOf = (i: Pick<WorkItem, 'project' | 'sequence_id'>) => issueKey(i, projList)
  const key = item ? keyOf(item) : ''
  const planeUrl = usePlaneLink(`projects/${projectId}/issues/${issueId}`)
  const pick = (p: string, id: string) => (p === projectId ? onPick(id) : onPickIn ? onPickIn(p, id) : onPick(id))
  const parent = item?.parent ? list.data?.find((i) => i.id === item.parent) : undefined

  useEffect(() => setEditingDesc(false), [issueId])

  const copy = (text: string, what: string) => {
    navigator.clipboard?.writeText(text).then(() => toast.success(`Copied ${what}`), () => toast.error(`Couldn't copy the ${what}`))
  }

  if (typeof document === 'undefined') return null

  const ctx: PanelCtx | undefined = item
    ? { item, projectId, itemKey: key, states: meta.states, stateById: data.stateById, memberById: data.memberById, siblings: (list.data ?? []) as WorkItem[], keyOf, onPick: pick, planeUrl }
    : undefined
  const lite = !fromList // single-item read carries no sprint/epic when the list failed

  return createPortal(
    <WorkRulesProvider value={rules}>
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label={item ? `${key} ${item.name}` : 'Work item'}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]" onClick={onClose} />
      <aside className={cn('relative flex h-full w-full flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl', width.className)}>
        <header className="flex items-center gap-2 border-b border-edge-default bg-surface-raised px-4 py-2.5 sm:px-6">
          <nav className="flex min-w-0 items-center gap-1.5 text-[12px] text-content-muted" aria-label="Breadcrumb">
            <span className="truncate">{project?.name ?? 'Project'}</span>
            {parent ? (
              <>
                <span aria-hidden>/</span>
                <button type="button" onClick={() => onPick(parent.id)} className="truncate font-mono text-[11.5px] hover:text-content hover:underline">{keyOf(parent)}</button>
              </>
            ) : null}
            <span aria-hidden>/</span>
            <button type="button" title="Copy key" onClick={() => key && copy(key, 'key')} className="inline-flex items-center gap-1 font-mono text-[11.5px] font-semibold text-content hover:underline">
              {key || '…'} <IconCopy size={11} />
            </button>
            {edit.pending ? <InlineLoading label="saving" /> : null}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {ctx ? <WatchButton c={ctx} /> : null}
            {planeUrl ? <a href={planeUrl} target="_blank" rel="noreferrer" title="Open in Plane" className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"><IconExternal size={14} /></a> : null}
            {item ? (
              <IconBtn
                title="Duplicate"
                onClick={() =>
                  duplicate.mutate({ name: `${item.name} (copy)`, state: item.state, priority: item.priority, assignees: item.assignees, labels: item.labels, description_html: item.description_html, parent: item.parent ?? null, cycle: item.cycle ?? null, module: item.module ?? null } as Partial<plane.Issue>, {
                    onSuccess: (n) => {
                      rules.automate('created', undefined, viewOf(n as WorkItem))
                      toast.success(`Duplicated as ${keyOf(n)}`)
                      onPick(n.id)
                    },
                    onError: (e) => toast.error(planeError(e, "Couldn't duplicate.")),
                  })}
              >
                <IconCopy size={14} />
              </IconBtn>
            ) : null}
            {item ? (
              <IconBtn
                title="Delete"
                danger
                onClick={() => {
                  if (!confirm(`Delete ${key} “${item.name}”? Plane deletes it permanently.`)) return
                  remove.mutate(item.id, { onSuccess: () => { toast.success(`Deleted ${key}`); onClose() }, onError: (e) => toast.error(planeError(e, "Couldn't delete — Plane allows it only for admins and the creator.")) })
                }}
              >
                <IconTrash size={14} />
              </IconBtn>
            ) : null}
            <DrawerWidenButton wide={width.wide} onToggle={width.toggle} />
            <IconBtn title="Close (Esc)" onClick={onClose}><IconClose /></IconBtn>
          </div>
        </header>

        {!item ? (
          <div className="flex-1 overflow-y-auto p-6">
            {single.isError && !fromList ? <PlaneErrorState error={single.error} what="this work item" /> : list.isError && !single.isLoading && !single.data ? <PlaneErrorState error={list.error} what="this work item" /> : (
              <div className="space-y-3">
                <div className="h-7 w-2/3 animate-pulse rounded bg-surface-sunken" />
                <div className="h-24 animate-pulse rounded bg-surface-sunken" />
                <div className="h-40 animate-pulse rounded bg-surface-sunken" />
              </div>
            )}
          </div>
        ) : (
          <div className={cn('grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:overflow-hidden', expanded ? 'md:grid-cols-[1fr_340px]' : 'md:grid-cols-[1fr_300px]')}>
            <div className="min-w-0 space-y-6 px-4 py-5 sm:px-6 md:overflow-y-auto">
              {editingTitle ? (
                <input
                  autoFocus
                  defaultValue={item.name}
                  aria-label="Title"
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    if (v && v !== item.name) edit.patch(item, { name: v })
                    setEditingTitle(false)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      setEditingTitle(false)
                    }
                  }}
                  className="w-full rounded-md border border-brand-400 bg-surface-raised px-2 py-1 text-xl font-semibold tracking-tight text-content focus:outline-none"
                />
              ) : (
                <h2 className="-mx-2 cursor-text rounded-md px-2 py-1 text-xl font-semibold tracking-tight text-content hover:bg-surface-sunken" onClick={() => setEditingTitle(true)} title="Click to rename">{item.name}</h2>
              )}

              <Section title="Description" action={!editingDesc ? <Button size="xs" variant="ghost" onClick={() => setEditingDesc(true)}>Edit</Button> : null}>
                {editingDesc ? (
                  <RichEditor
                    initial={item.description_html}
                    onCancel={() => setEditingDesc(false)}
                    onSave={(html) => {
                      edit.patch(item, { description_html: html || '<p></p>' })
                      setEditingDesc(false)
                    }}
                  />
                ) : item.description_html && item.description_stripped !== '' ? (
                  <div onDoubleClick={() => setEditingDesc(true)}><RichView html={item.description_html} nameOf={(id) => (data.memberById.get(id) ? memberDisplayName(data.memberById.get(id)) : undefined)} /></div>
                ) : (
                  <button type="button" onClick={() => setEditingDesc(true)} className="block w-full rounded-lg border border-dashed border-edge-default px-3 py-4 text-left text-[13px] text-content-subtle hover:bg-surface-sunken">Add a description…</button>
                )}
              </Section>

              {ctx ? (
                <>
                  <SubtasksPanel c={ctx} />
                  <ChecklistPanel c={ctx} />
                  <RelationsPanel c={ctx} />
                  <LinksPanel c={ctx} />
                  <AttachmentsPanel c={ctx} />
                  <DevelopmentPanel c={ctx} />
                  <section className="space-y-3">
                    <div role="tablist" className="flex gap-1 border-b border-edge-default">
                      {(['comments', 'history', 'worklog'] as Tab[]).map((t) => (
                        <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('-mb-px border-b-2 px-2.5 pb-1.5 text-[12.5px] font-medium', tab === t ? 'border-brand-500 text-content' : 'border-transparent text-content-muted hover:text-content')}>
                          {t === 'comments' ? 'Comments' : t === 'history' ? 'History' : 'Work log'}
                        </button>
                      ))}
                    </div>
                    {tab === 'comments' ? <CommentsPanel c={ctx} /> : tab === 'history' ? <HistoryPanel c={ctx} /> : <WorklogPanel c={ctx} />}
                  </section>
                </>
              ) : null}
            </div>

            <aside className="space-y-1 border-t border-edge-subtle bg-surface-raised px-4 py-4 md:overflow-y-auto md:border-l md:border-t-0">
              <Prop label="Status"><StateField item={item} data={data} edit={edit} /></Prop>
              <Prop label="Priority"><PriorityField item={item} edit={edit} /></Prop>
              <Prop label="Assignees"><AssigneesField item={item} data={data} edit={edit} /></Prop>
              <Prop label="Labels"><LabelsField item={item} data={data} edit={edit} /></Prop>
              <Prop label="Estimate"><EstimateField item={item} edit={edit} /></Prop>
              <Prop label="Start"><DateField item={item} field="start_date" edit={edit} /></Prop>
              <Prop label="Due"><DateField item={item} field="target_date" edit={edit} groupOf={data.stateById.get(item.state)?.group} /></Prop>
              <Prop label="Sprint"><SprintField item={item} data={data} edit={edit} lite={lite} /></Prop>
              <Prop label="Epic"><EpicField item={item} data={data} edit={edit} lite={lite} /></Prop>
              <Prop label="Parent">
                {parentPick ? (
                  <div className="space-y-1">
                    <IssueSearch autoFocus project={projectId} exclude={[item.id]} placeholder="Parent — title or KEY-123" onPick={(h) => { edit.patch(item, { parent: h.id }, `Parent set to ${h.project__identifier}-${h.sequence_id}`); setParentPick(false) }} />
                    <div className="flex gap-1">
                      {item.parent ? <Button size="xs" variant="ghost" onClick={() => { edit.patch(item, { parent: null }); setParentPick(false) }}>Remove parent</Button> : null}
                      <Button size="xs" variant="ghost" onClick={() => setParentPick(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <button type="button" onClick={() => setParentPick(true)} className="flex h-7 w-full items-center rounded-md px-1.5 text-left text-[12.5px] hover:bg-surface-sunken">
                    {parent ? <span className="truncate"><span className="font-mono text-[11px] text-content-subtle">{keyOf(parent)}</span> {parent.name}</span> : item.parent ? <span className="text-content-muted">Another project's item</span> : <span className="text-content-subtle">None</span>}
                  </button>
                )}
              </Prop>
              <div className="my-3 border-t border-edge-subtle" />
              {ctx ? <Prop label="Time"><div className="px-1.5"><WorklogPanel c={ctx} compact /></div></Prop> : null}
              <Prop label="Created">
                <span className="flex items-center gap-1.5 px-1.5 text-[12px] text-content-muted">
                  {item.created_by && data.memberById.get(item.created_by) ? <Avatar member={data.memberById.get(item.created_by)} size={16} /> : null}
                  <span title={item.created_at}>{formatRelative(item.created_at)}</span>
                </span>
              </Prop>
              {item.updated_at ? <Prop label="Updated"><span className="px-1.5 text-[12px] text-content-muted" title={item.updated_at}>{formatRelative(item.updated_at)}</span></Prop> : null}
              {item.completed_at ? <Prop label="Resolved"><span className="px-1.5 text-[12px] text-content-muted">{formatRelative(item.completed_at)}</span></Prop> : null}
              {lite ? <p className="pt-2 text-[11px] text-content-subtle">Sprint and epic need the project's item list, which couldn't load.</p> : null}
            </aside>
          </div>
        )}
      </aside>
    </div>,
    </WorkRulesProvider>,
    document.body,
  )
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_1fr] items-center gap-1">
      <span className="text-[11.5px] text-content-subtle">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function IconBtn({ title, onClick, children, danger, className }: { title: string; onClick(): void; children: ReactNode; danger?: boolean; className?: string }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} className={cn('flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken', danger ? 'hover:text-rose-600' : 'hover:text-content', className)}>
      {children}
    </button>
  )
}
