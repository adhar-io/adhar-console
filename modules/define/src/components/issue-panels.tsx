import { type ReactNode, useMemo, useRef, useState } from 'react'
import { Button, useOptionalUser, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import {
  memberDisplayName,
  planeError,
  useActivities,
  useComments,
  useCreateComment,
  useCreateIssue,
  useCreateLink,
  useCreateRelation,
  useDeleteLink,
  useLinks,
  useProjectMembers,
  useRelations,
} from '../data/plane.ts'
import { useAttachments, usePatchWork, usePlaneMe, type WorkItem } from '../data/work-hooks.ts'
import {
  type ChecklistDoc,
  checklistProgress,
  formatMinutes,
  KINDS,
  newId,
  parseDuration,
  storeError,
  useDocById,
  usePutDoc,
  type WatchDoc,
  type WorklogDoc,
} from '../data/work-store.ts'
import { attributedActor, markdownToHtml, mentionHandle, withAttribution } from '../data/work-text.ts'
import { localDay } from '../data/work-time.ts'
import { useWorkRulesCtx, viewOf } from '../data/work-rules.ts'
import { branchHref, commitHref, prHref, useBranchesAndCommitsFor, useDeploymentsFor, usePullRequestsFor } from '../data/work-dev.ts'
import { navigateTo } from '../data/work-nav.ts'
import { IssueSearch } from './issue-search.tsx'
import { RichView } from './rich-editor.tsx'
import {
  Avatar,
  ConsoleSide,
  IconBranch,
  IconCheck,
  IconClip,
  IconCommit,
  IconLink,
  IconPr,
  IconRocket,
  InlineLoading,
  ProgressBar,
  StateDot,
} from './work-ui.tsx'

/**
 * The sections of the work-item drawer. Each one reads and writes its own
 * data so the drawer stays a layout, and each says plainly where the data
 * lives: in Plane, or console-side when Plane's public API has no home for it.
 */

export interface PanelCtx {
  item: WorkItem
  projectId: string
  itemKey: string
  states: plane.State[]
  stateById: Map<string, plane.State>
  memberById: Map<string, plane.Member>
  /** Every loaded item of the project (sub-tasks, relation titles). */
  siblings: WorkItem[]
  keyOf(i: Pick<WorkItem, 'project' | 'sequence_id'>): string
  onPick(projectId: string, issueId: string): void
  planeUrl: string
}

export function Section({ title, count, action, children, tag }: { title: string; count?: number | string; action?: ReactNode; children: ReactNode; tag?: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-content-subtle">{title}</h4>
        {count !== undefined && count !== 0 && count !== '' ? <span className="text-[11px] tabular-nums text-content-subtle">{count}</span> : null}
        {tag}
        <span className="ml-auto flex items-center gap-1">{action}</span>
      </div>
      {children}
    </section>
  )
}

const linkBtn = 'rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-content-muted hover:bg-surface-sunken hover:text-content'
const inputCls = 'h-8 w-full rounded-md border border-edge-default bg-surface-app px-2 text-[12.5px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none'

/* ───── sub-tasks ───── */

export function SubtasksPanel({ c }: { c: PanelCtx }) {
  const toast = useToast()
  const create = useCreateIssue(c.projectId)
  const patch = usePatchWork()
  const rules = useWorkRulesCtx()
  const [adding, setAdding] = useState<'new' | 'link' | null>(null)
  const [name, setName] = useState('')
  const children = c.siblings.filter((i) => i.parent === c.item.id)
  const groupOf = (s: string) => c.stateById.get(s)?.group
  const done = children.filter((i) => groupOf(i.state) === 'completed').length
  const active = children.filter((i) => groupOf(i.state) !== 'cancelled').length
  const defaultState = c.states.find((s) => s.project === c.projectId && s.default)?.id ?? c.states.find((s) => s.project === c.projectId)?.id
  return (
    <Section
      title="Sub-tasks"
      count={children.length ? `${done}/${active}` : undefined}
      action={
        <>
          <button type="button" className={linkBtn} onClick={() => setAdding(adding === 'new' ? null : 'new')}>+ New</button>
          <button type="button" className={linkBtn} onClick={() => setAdding(adding === 'link' ? null : 'link')}>Link existing</button>
        </>
      }
    >
      {active ? <ProgressBar value={done} total={active} tone="emerald" /> : null}
      {adding === 'new' ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            create.mutate({ name: name.trim(), parent: c.item.id, state: defaultState, priority: 'none' } as Partial<plane.Issue>, {
              onSuccess: (s) => {
                rules?.automate('created', undefined, viewOf(s as WorkItem))
                toast.success(`Created sub-task ${c.keyOf(s)}`)
                setName('')
              },
              onError: (e2) => toast.error(planeError(e2, "Couldn't create the sub-task.")),
            })
          }}
        >
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Sub-task title" className={inputCls} />
          <Button size="sm" variant="primary" type="submit" loading={create.isPending} disabled={!name.trim()}>Add</Button>
        </form>
      ) : null}
      {adding === 'link' ? (
        <IssueSearch
          autoFocus
          exclude={[c.item.id, ...children.map((x) => x.id)]}
          placeholder="Make an existing item a sub-task — title or KEY-123"
          onPick={(h) =>
            patch.mutate({ projectId: h.project_id, id: h.id, patch: { parent: c.item.id } }, {
              onSuccess: () => {
                toast.success(`${h.project__identifier}-${h.sequence_id} is now a sub-task`)
                setAdding(null)
              },
              onError: (e) => toast.error(planeError(e, "Couldn't link the sub-task.")),
            })}
        />
      ) : null}
      {children.length ? (
        <ul className="divide-y divide-edge-subtle rounded-lg border border-edge-default">
          {children.map((s) => {
            const st = c.stateById.get(s.state)
            const who = s.assignees.map((id) => c.memberById.get(id)).filter(Boolean) as plane.Member[]
            return (
              <li key={s.id} className="group flex items-center gap-2 px-2.5 py-1.5 text-[13px]">
                <StateDot state={st} />
                <button type="button" onClick={() => c.onPick(s.project, s.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <span className="shrink-0 font-mono text-[11px] text-content-subtle">{c.keyOf(s)}</span>
                  <span className={cn('truncate', st?.group === 'completed' || st?.group === 'cancelled' ? 'text-content-muted line-through' : 'text-content')}>{s.name}</span>
                </button>
                {who[0] ? <Avatar member={who[0]} size={18} /> : null}
                <button
                  type="button"
                  title="Detach (stays an item, no longer a sub-task)"
                  onClick={() => patch.mutate({ projectId: s.project, id: s.id, patch: { parent: null } }, { onError: (e) => toast.error(planeError(e, "Couldn't detach the sub-task.")) })}
                  className="text-[11px] text-content-subtle opacity-0 hover:text-rose-600 group-hover:opacity-100 focus:opacity-100"
                >
                  Detach
                </button>
              </li>
            )
          })}
        </ul>
      ) : adding ? null : <p className="text-[12px] text-content-subtle">Break the work down — sub-tasks are Plane work items whose parent is this one.</p>}
    </Section>
  )
}

/* ───── checklists (console-side) ───── */

export function ChecklistPanel({ c }: { c: PanelCtx }) {
  const toast = useToast()
  const { doc, isError, error } = useDocById<ChecklistDoc>(KINDS.checklist, c.item.id)
  const put = usePutDoc<ChecklistDoc>(KINDS.checklist)
  const [newItem, setNewItem] = useState<Record<string, string>>({})
  const lists = doc?.data.lists ?? []
  const prog = checklistProgress(doc?.data)
  const save = (fn: (lists: ChecklistDoc['lists']) => ChecklistDoc['lists']) =>
    put.mutate(
      { id: c.item.id, update: (prev) => ({ projectId: c.projectId, issueId: c.item.id, lists: fn(prev?.lists ?? lists) }) },
      { onError: (e) => toast.error(storeError(e)) },
    )
  return (
    <Section
      title="Checklists"
      count={prog.total ? `${prog.done}/${prog.total}` : undefined}
      tag={<ConsoleSide title="Plane has no checklists — kept by the console, keyed to this item" />}
      action={<button type="button" className={linkBtn} onClick={() => save((ls) => [...ls, { id: newId(), title: 'Checklist', items: [] }])}>+ Checklist</button>}
    >
      {isError ? <p className="text-[12px] text-rose-700 dark:text-rose-300">{storeError(error)}</p> : null}
      {prog.total ? <ProgressBar value={prog.done} total={prog.total} tone="emerald" /> : null}
      {lists.map((l) => (
        <div key={l.id} className="rounded-lg border border-edge-default p-2">
          <div className="mb-1 flex items-center gap-2">
            <input
              defaultValue={l.title}
              aria-label="Checklist title"
              onBlur={(e) => e.target.value.trim() && e.target.value !== l.title && save((ls) => ls.map((x) => (x.id === l.id ? { ...x, title: e.target.value.trim() } : x)))}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] font-semibold text-content focus:outline-none"
            />
            <button type="button" className="text-[11px] text-content-subtle hover:text-rose-600" onClick={() => confirm(`Delete checklist "${l.title}"?`) && save((ls) => ls.filter((x) => x.id !== l.id))}>Delete</button>
          </div>
          <ul className="space-y-0.5">
            {l.items.map((it) => (
              <li key={it.id} className="group flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={it.done}
                  onChange={() => save((ls) => ls.map((x) => (x.id === l.id ? { ...x, items: x.items.map((y) => (y.id === it.id ? { ...y, done: !y.done } : y)) } : x)))}
                  className="h-3.5 w-3.5 accent-emerald-600"
                  aria-label={it.text}
                />
                <span className={cn('flex-1', it.done ? 'text-content-muted line-through' : 'text-content')}>{it.text}</span>
                <button type="button" aria-label="Remove" className="text-content-subtle opacity-0 hover:text-rose-600 group-hover:opacity-100" onClick={() => save((ls) => ls.map((x) => (x.id === l.id ? { ...x, items: x.items.filter((y) => y.id !== it.id) } : x)))}>×</button>
              </li>
            ))}
          </ul>
          <form
            className="mt-1"
            onSubmit={(e) => {
              e.preventDefault()
              const text = (newItem[l.id] ?? '').trim()
              if (!text) return
              save((ls) => ls.map((x) => (x.id === l.id ? { ...x, items: [...x.items, { id: newId(), text, done: false }] } : x)))
              setNewItem((m) => ({ ...m, [l.id]: '' }))
            }}
          >
            <input value={newItem[l.id] ?? ''} onChange={(e) => setNewItem((m) => ({ ...m, [l.id]: e.target.value }))} placeholder="Add an item ↵" className={cn(inputCls, 'h-7')} />
          </form>
        </div>
      ))}
      {!lists.length && !isError ? <p className="text-[12px] text-content-subtle">Trello-style to-dos for small steps that don't merit a sub-task.</p> : null}
    </Section>
  )
}

/* ───── relations ───── */

const RELATION_GROUPS: Array<{ key: plane.RelationType; label: string; tone: string }> = [
  { key: 'blocked_by', label: 'Blocked by', tone: 'text-rose-700 dark:text-rose-300' },
  { key: 'blocking', label: 'Blocks', tone: 'text-amber-700 dark:text-amber-300' },
  { key: 'relates_to', label: 'Relates to', tone: 'text-content-muted' },
  { key: 'duplicate', label: 'Duplicates', tone: 'text-content-muted' },
  { key: 'start_before', label: 'Starts before', tone: 'text-content-muted' },
  { key: 'start_after', label: 'Starts after', tone: 'text-content-muted' },
  { key: 'finish_before', label: 'Finishes before', tone: 'text-content-muted' },
  { key: 'finish_after', label: 'Finishes after', tone: 'text-content-muted' },
]
const ADDABLE: Array<[plane.RelationType, string]> = [
  ['blocked_by', 'Blocked by'],
  ['blocking', 'Blocks'],
  ['relates_to', 'Relates to'],
  ['duplicate', 'Duplicates'],
]

export function RelationsPanel({ c }: { c: PanelCtx }) {
  const rel = useRelations(c.projectId, c.item.id)
  const create = useCreateRelation(c.projectId, c.item.id)
  const toast = useToast()
  const [adding, setAdding] = useState<plane.RelationType | null>(null)
  const byId = useMemo(() => new Map(c.siblings.map((i) => [i.id, i])), [c.siblings])
  const groups = RELATION_GROUPS.map((g) => ({ ...g, items: rel.data?.[g.key] ?? [] })).filter((g) => g.items.length)
  const total = groups.reduce((n, g) => n + g.items.length, 0)
  const openBlocker = (rel.data?.blocked_by ?? []).some((r) => {
    const st = c.stateById.get(byId.get(r.issue_id)?.state ?? '')
    return !st || (st.group !== 'completed' && st.group !== 'cancelled')
  })
  return (
    <Section title="Dependencies" count={total || undefined}>
      {openBlocker ? <div className="rounded-md bg-rose-50 px-2.5 py-1.5 text-[12px] text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">Blocked — at least one blocking item is still open.</div> : null}
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-0.5 text-[11px] text-content-subtle">Add</span>
        {ADDABLE.map(([k, label]) => (
          <button key={k} type="button" aria-pressed={adding === k} onClick={() => setAdding(adding === k ? null : k)} className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', adding === k ? 'border-content bg-content text-surface-raised' : 'border-edge-default text-content-muted hover:border-edge-strong hover:text-content')}>
            {label}
          </button>
        ))}
      </div>
      {adding ? (
        <IssueSearch
          autoFocus
          exclude={[c.item.id]}
          placeholder={`${ADDABLE.find(([k]) => k === adding)?.[1]} — search title or KEY-123…`}
          onPick={(h) =>
            create.mutate({ type: adding, issues: [h.id] }, {
              onSuccess: () => {
                toast.success(`Linked ${h.project__identifier}-${h.sequence_id}`)
                setAdding(null)
              },
              onError: (e) => toast.error(planeError(e, "Couldn't add the dependency.")),
            })}
        />
      ) : null}
      {rel.isLoading ? <InlineLoading /> : rel.isError ? <p className="text-[12px] text-rose-700 dark:text-rose-300">{planeError(rel.error)}</p> : groups.length ? (
        <div className="space-y-2">
          {groups.map((g) => (
            <div key={g.key}>
              <div className={cn('mb-1 text-[10.5px] font-semibold uppercase tracking-wider', g.tone)}>{g.label}</div>
              <ul className="divide-y divide-edge-subtle rounded-lg border border-edge-default">
                {g.items.map((r) => {
                  const it = byId.get(r.issue_id)
                  const st = it ? c.stateById.get(it.state) : undefined
                  return (
                    <li key={`${g.key}-${r.issue_id}`}>
                      <button type="button" onClick={() => c.onPick(r.project_id, r.issue_id)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-sunken/60">
                        {st ? <StateDot state={st} /> : null}
                        <span className="font-mono text-[11px] text-content-subtle">{it ? c.keyOf(it) : 'other project'}</span>
                        <span className="min-w-0 flex-1 truncate text-content">{it?.name ?? 'Open to see the item'}</span>
                        {st ? <span className="text-[11px] text-content-subtle">{st.name}</span> : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
          <p className="text-[11px] text-content-subtle">
            Plane's public API can add dependencies but not remove them.{' '}
            {c.planeUrl ? <a href={c.planeUrl} target="_blank" rel="noreferrer" className="underline">Remove one in Plane</a> : 'Remove one in Plane.'}
          </p>
        </div>
      ) : adding ? null : <p className="text-[12px] text-content-subtle">No dependencies.</p>}
    </Section>
  )
}

/* ───── links + attachments ───── */

export function LinksPanel({ c }: { c: PanelCtx }) {
  const links = useLinks(c.projectId, c.item.id)
  const create = useCreateLink(c.projectId, c.item.id)
  const remove = useDeleteLink(c.projectId, c.item.id)
  const toast = useToast()
  const [adding, setAdding] = useState(false)
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const valid = /^https?:\/\/\S+$/i.test(url.trim())
  const list = links.data ?? []
  return (
    <Section title="Links" count={list.length || undefined} action={<button type="button" className={linkBtn} onClick={() => setAdding((a) => !a)}>{adding ? 'Cancel' : '+ Link'}</button>}>
      {adding ? (
        <form
          className="grid grid-cols-1 gap-2 sm:grid-cols-[1.4fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault()
            if (!valid) return
            create.mutate({ url: url.trim(), title: title.trim() || undefined }, {
              onSuccess: () => {
                setUrl('')
                setTitle('')
                setAdding(false)
              },
              onError: (e2) => toast.error(planeError(e2, "Couldn't add the link.")),
            })
          }}
        >
          <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" aria-label="URL" className={inputCls} />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" aria-label="Title" className={inputCls} />
          <Button variant="primary" size="sm" type="submit" disabled={!valid} loading={create.isPending}>Add</Button>
        </form>
      ) : null}
      {list.length ? (
        <ul className="divide-y divide-edge-subtle rounded-lg border border-edge-default">
          {list.map((l) => {
            let host = l.url
            try {
              host = new URL(l.url).host
            } catch { /* keep */ }
            return (
              <li key={l.id} className="group flex items-center gap-2 px-2.5 py-1.5 text-[13px]">
                <span className="text-content-subtle"><IconLink /></span>
                <a href={l.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-brand-700 hover:underline dark:text-brand-300">{l.title || l.url}</a>
                <span className="hidden truncate text-[11px] text-content-subtle sm:inline">{host}</span>
                <button type="button" aria-label="Remove link" onClick={() => remove.mutate(l.id, { onError: (e) => toast.error(planeError(e, "Couldn't remove the link.")) })} className="text-content-subtle opacity-0 hover:text-rose-600 group-hover:opacity-100 focus:opacity-100">×</button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </Section>
  )
}

export function AttachmentsPanel({ c }: { c: PanelCtx }) {
  const q = useAttachments(c.projectId, c.item.id)
  const list = q.data ?? []
  const size = (n?: number) => (!n ? '' : n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
  return (
    <Section
      title="Attachments"
      count={list.length || undefined}
      action={c.planeUrl ? <a href={c.planeUrl} target="_blank" rel="noreferrer" className={linkBtn}>Upload in Plane ↗</a> : null}
    >
      {q.isLoading ? <InlineLoading /> : q.isError ? <p className="text-[12px] text-content-subtle">{planeError(q.error)}</p> : list.length ? (
        <ul className="divide-y divide-edge-subtle rounded-lg border border-edge-default">
          {list.map((a) => (
            <li key={a.id} className="flex items-center gap-2 px-2.5 py-1.5 text-[13px]">
              <span className="text-content-subtle"><IconClip /></span>
              <span className="min-w-0 flex-1 truncate text-content">{a.attributes?.name ?? 'file'}</span>
              <span className="text-[11px] text-content-subtle">{size(a.attributes?.size ?? a.size)}</span>
              {a.created_at ? <span className="hidden text-[11px] text-content-subtle sm:inline">{formatRelative(a.created_at)}</span> : null}
            </li>
          ))}
        </ul>
      ) : <p className="text-[12px] text-content-subtle">No files. Plane uploads go straight to its object storage through a signed URL the console can't proxy, so add and download files in Plane.</p>}
    </Section>
  )
}

/* ───── development (Gitea + Argo CD) ───── */

export function DevelopmentPanel({ c }: { c: PanelCtx }) {
  const prs = usePullRequestsFor(c.itemKey)
  const [scan, setScan] = useState(false)
  const repos = [...new Set((prs.data ?? []).map((p) => p.repo))]
  const bc = useBranchesAndCommitsFor(c.itemKey, repos, scan)
  const dep = useDeploymentsFor(prs.data)
  const go = (href: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    navigateTo(href)
  }
  const merged = (prs.data ?? []).filter((p) => p.merged).length
  return (
    <Section
      title="Development"
      count={prs.data?.length || undefined}
      action={<button type="button" className={linkBtn} onClick={() => setScan(true)} disabled={scan && bc.isFetching}>{scan ? (bc.isFetching ? 'Scanning…' : 'Rescan') : 'Scan branches & commits'}</button>}
    >
      <p className="text-[11.5px] text-content-subtle">Gitea pull requests, branches and commits that mention <code className="font-mono text-content">{c.itemKey}</code> — put the key in a branch name, PR title or commit message to link them.</p>
      {prs.isLoading ? <InlineLoading label="Searching pull requests…" /> : prs.isError ? <p className="text-[12px] text-content-subtle">{(prs.error as Error).message}</p> : prs.data?.length ? (
        <ul className="divide-y divide-edge-subtle rounded-lg border border-edge-default">
          {prs.data.map((p) => (
            <li key={`${p.repo}#${p.number}`} className="flex items-center gap-2 px-2.5 py-1.5 text-[13px]">
              <span className={p.merged ? 'text-violet-600 dark:text-violet-400' : p.state === 'open' ? 'text-emerald-600 dark:text-emerald-400' : 'text-content-subtle'}><IconPr /></span>
              <a href={prHref(p.repo, p.number)} onClick={go(prHref(p.repo, p.number))} className="min-w-0 flex-1 truncate text-content hover:underline">
                <span className="font-mono text-[11px] text-content-subtle">{p.repo}#{p.number}</span> {p.title}
              </a>
              <span className={cn('rounded-full px-1.5 text-[10.5px] font-semibold', p.merged ? 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300' : p.state === 'open' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-surface-sunken text-content-muted')}>
                {p.merged ? 'merged' : p.state}
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="text-[12px] text-content-subtle">No pull requests mention {c.itemKey}.</p>}

      {scan ? (
        bc.isLoading ? <InlineLoading label="Scanning recent repositories…" /> : bc.isError ? <p className="text-[12px] text-content-subtle">{(bc.error as Error).message}</p> : (
          <div className="space-y-1.5">
            {bc.data?.branches.map((b) => (
              <a key={`${b.repo}:${b.name}`} href={branchHref(b.repo, b.name)} onClick={go(branchHref(b.repo, b.name))} className="flex items-center gap-2 text-[12.5px] text-content hover:underline">
                <span className="text-content-subtle"><IconBranch /></span>
                <span className="font-mono text-[11.5px]">{b.repo}:{b.name}</span>
              </a>
            ))}
            {bc.data?.commits.slice(0, 10).map((cm) => (
              <a key={cm.sha} href={commitHref(cm.repo, cm.sha)} onClick={go(commitHref(cm.repo, cm.sha))} className="flex items-center gap-2 text-[12.5px] text-content hover:underline">
                <span className="text-content-subtle"><IconCommit /></span>
                <span className="shrink-0 font-mono text-[11px] text-content-subtle">{cm.repo}@{cm.sha.slice(0, 7)}</span>
                <span className="truncate">{cm.message}</span>
              </a>
            ))}
            {!bc.data?.branches.length && !bc.data?.commits.length ? <p className="text-[12px] text-content-subtle">No branches or recent commits mention {c.itemKey} in {bc.data?.scanned.length ?? 0} repositories.</p> : null}
          </div>
        )
      ) : null}

      {merged ? (
        <div className="space-y-1.5 rounded-lg border border-edge-default p-2.5">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-content-subtle"><IconRocket /> Deployments</div>
          {dep.isLoading ? <InlineLoading label="Checking Argo CD…" /> : dep.isError ? <p className="text-[12px] text-content-subtle">{(dep.error as Error).message}</p> : (
            <>
              {dep.data?.deployments.map((d) => (
                <div key={`${d.app}#${d.pr}`} className="flex items-center gap-2 text-[12.5px]">
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', d.deployed === true ? 'bg-emerald-500' : d.deployed === false ? 'bg-amber-500' : 'bg-slate-400')} />
                  <span className="font-medium text-content">{d.app}</span>
                  <span className="text-content-subtle">{d.namespace}</span>
                  <span className="ml-auto text-[11.5px] text-content-muted">{d.deployed === true ? `has ${d.repo}#${d.pr}` : d.deployed === false ? `not yet — ${d.sync}` : 'unknown revision'}</span>
                </div>
              ))}
              {dep.data?.prsWithoutDirectApp ? (
                <p className="text-[11.5px] text-content-subtle">
                  {dep.data.prsWithoutDirectApp} merged PR{dep.data.prsWithoutDirectApp === 1 ? ' is' : 's are'} in a repo no Argo CD app deploys directly (GitOps / image promotion).{' '}
                  <a href="/deliver" onClick={go('/deliver')} className="underline">Follow it in Deliver</a>.
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </Section>
  )
}

/* ───── comments ───── */

export function CommentsPanel({ c }: { c: PanelCtx }) {
  const q = useComments(c.projectId, c.item.id)
  const create = useCreateComment(c.projectId, c.item.id)
  const members = useProjectMembers(c.projectId)
  const user = useOptionalUser()
  const toast = useToast()
  const [draft, setDraft] = useState('')
  const [preview, setPreview] = useState(false)
  const [mention, setMention] = useState<{ q: string; at: number } | null>(null)
  const [active, setActive] = useState(0)
  const ta = useRef<HTMLTextAreaElement>(null)
  const targets = useMemo(
    () => (members.data ?? []).map((m) => ({ id: m.id, name: m.display_name || [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || 'member', handle: mentionHandle(m.display_name || m.email?.split('@')[0] || m.id) })),
    [members.data],
  )
  const nameOf = (id: string) => targets.find((t) => t.id === id)?.name ?? (c.memberById.get(id) ? memberDisplayName(c.memberById.get(id)) : undefined)
  const hits = mention ? targets.filter((t) => `${t.handle} ${t.name}`.toLowerCase().includes(mention.q.toLowerCase())).slice(0, 6) : []
  const html = markdownToHtml(draft, targets)

  const onType = (v: string, caret: number) => {
    setDraft(v)
    const m = /(^|\s)@([A-Za-z0-9._-]*)$/.exec(v.slice(0, caret))
    setMention(m ? { q: m[2], at: caret - m[2].length - 1 } : null)
    setActive(0)
  }
  const pickMention = (t: { handle: string }) => {
    if (!mention) return
    const caret = ta.current?.selectionStart ?? draft.length
    const next = `${draft.slice(0, mention.at)}@${t.handle} ${draft.slice(caret)}`
    setDraft(next)
    setMention(null)
    requestAnimationFrame(() => {
      const pos = mention.at + t.handle.length + 2
      ta.current?.focus()
      ta.current?.setSelectionRange(pos, pos)
    })
  }
  const submit = () => {
    if (!draft.trim()) return
    create.mutate({ comment_html: withAttribution(html, user) }, {
      onSuccess: () => {
        setDraft('')
        setPreview(false)
      },
      onError: (e) => toast.error(planeError(e, "Couldn't post the comment.")),
    })
  }
  const comments = (q.data ?? []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at))
  return (
    <div className="space-y-3">
      {q.isLoading ? <InlineLoading /> : q.isError ? <p className="text-[12px] text-rose-700 dark:text-rose-300">{planeError(q.error)}</p> : null}
      <ul className="space-y-2.5">
        {comments.map((cm) => {
          const via = attributedActor(cm.comment_html)
          const m = c.memberById.get(cm.actor)
          const name = via ?? (m ? memberDisplayName(m) : cm.actor_detail?.display_name ?? 'Unknown')
          return (
            <li key={cm.id} className="flex gap-2.5">
              <Avatar member={via ? ({ id: cm.id, display_name: via, member: { id: cm.id, email: '', display_name: via } } as plane.Member) : m} size={26} title={name} />
              <div className="min-w-0 flex-1 rounded-lg border border-edge-subtle bg-surface-raised px-3 py-2">
                <div className="flex items-baseline gap-2 text-[12px]">
                  <span className="font-semibold text-content">{name}</span>
                  {via ? <span className="text-[10.5px] text-content-subtle">via console</span> : null}
                  <span className="ml-auto text-[11px] text-content-subtle" title={cm.created_at}>{formatRelative(cm.created_at)}</span>
                </div>
                <RichView html={(cm.comment_html ?? '').replace(/<p data-adhar-actor[^>]*>[\s\S]*?<\/p>/, '')} nameOf={nameOf} className="mt-1" />
              </div>
            </li>
          )
        })}
        {!q.isLoading && !comments.length ? <li className="text-[12px] text-content-subtle">No comments yet.</li> : null}
      </ul>
      <div className="relative rounded-lg border border-edge-default bg-surface-raised focus-within:border-brand-400">
        <div className="flex gap-1 border-b border-edge-subtle px-2 pt-1.5">
          <button type="button" onClick={() => setPreview(false)} className={cn('rounded-t px-2 pb-1 text-[11.5px] font-medium', !preview ? 'text-content' : 'text-content-subtle')}>Write</button>
          <button type="button" onClick={() => setPreview(true)} className={cn('rounded-t px-2 pb-1 text-[11.5px] font-medium', preview ? 'text-content' : 'text-content-subtle')}>Preview</button>
        </div>
        {preview ? (
          <RichView html={html || '<p>Nothing to preview.</p>'} nameOf={nameOf} className="min-h-20 px-3 py-2" />
        ) : (
          <textarea
            ref={ta}
            value={draft}
            onChange={(e) => onType(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onKeyDown={(e) => {
              if (mention && hits.length) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setActive((a) => Math.min(a + 1, hits.length - 1))
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setActive((a) => Math.max(a - 1, 0))
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  pickMention(hits[active])
                  return
                }
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setMention(null)
                  return
                }
              }
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
            rows={3}
            placeholder="Comment — Markdown, @mention project members. ⌘↵ to post"
            aria-label="Comment"
            className="block w-full resize-y bg-transparent px-3 py-2 text-[13px] text-content placeholder:text-content-subtle focus:outline-none"
          />
        )}
        {mention && hits.length && !preview ? (
          <ul className="absolute left-2 top-full z-30 mt-1 w-64 rounded-lg border border-edge-default bg-surface-raised p-1 shadow-xl">
            {hits.map((t, i) => (
              <li key={t.id}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pickMention(t)} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px]', i === active ? 'bg-surface-sunken' : '')}>
                  <span className="font-medium text-content">@{t.handle}</span>
                  <span className="truncate text-content-subtle">{t.name}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center justify-between gap-2 border-t border-edge-subtle px-2 py-1.5">
          <span className="text-[11px] text-content-subtle">Plane notifies @mentioned members. Posted as the console's Plane user, signed with your name.</span>
          <Button size="xs" variant="primary" onClick={submit} loading={create.isPending} disabled={!draft.trim()}>Comment</Button>
        </div>
      </div>
    </div>
  )
}

/* ───── history ───── */

export function HistoryPanel({ c }: { c: PanelCtx }) {
  const q = useActivities(c.projectId, c.item.id)
  const me = usePlaneMe()
  if (q.isLoading) return <InlineLoading />
  if (q.isError) return <p className="text-[12px] text-rose-700 dark:text-rose-300">{planeError(q.error)}</p>
  const acts = (q.data ?? []).slice().sort((a, b) => b.created_at.localeCompare(a.created_at))
  return (
    <div className="space-y-2">
      {me.data ? <p className="text-[11.5px] text-content-subtle">Changes made from the console are recorded by Plane as <strong className="text-content-muted">{me.data.display_name ?? me.data.email}</strong> — the console's integration user.</p> : null}
      <ol className="relative space-y-2.5 border-l border-edge-default pl-4">
        {acts.map((a) => {
          const m = c.memberById.get(a.actor)
          const who = m ? memberDisplayName(m) : a.actor_detail?.display_name ?? 'Someone'
          return (
            <li key={a.id} className="relative text-[12.5px] text-content-muted">
              <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-brand-500 ring-4 ring-surface-raised" />
              <span className="font-medium text-content">{who}</span> {a.verb}
              {a.field ? <> <span className="text-content">{a.field.replace(/_/g, ' ')}</span></> : null}
              {a.old_value ? <> from <code className="rounded bg-surface-sunken px-1 text-[11px]">{a.old_value}</code></> : null}
              {a.new_value ? <> to <code className="rounded bg-surface-sunken px-1 text-[11px]">{a.new_value}</code></> : null}
              <span className="ml-2 text-[11px] text-content-subtle" title={a.created_at}>{formatRelative(a.created_at)}</span>
            </li>
          )
        })}
        {!acts.length ? <li className="text-[12px] text-content-subtle">No history yet.</li> : null}
      </ol>
    </div>
  )
}

/* ───── worklog (console-side) ───── */

export function WorklogPanel({ c, compact }: { c: PanelCtx; compact?: boolean }) {
  const user = useOptionalUser()
  const toast = useToast()
  const { doc, isError, error } = useDocById<WorklogDoc>(KINDS.worklog, c.item.id)
  const put = usePutDoc<WorklogDoc>(KINDS.worklog)
  const [spent, setSpent] = useState('')
  const [date, setDate] = useState(() => localDay())
  const [note, setNote] = useState('')
  const [remaining, setRemaining] = useState('')
  const d = doc?.data
  const logged = (d?.entries ?? []).reduce((n, e) => n + e.minutes, 0)
  const original = d?.originalMinutes ?? null
  const remain = d?.remainingMinutes ?? (original !== null ? Math.max(0, original - logged) : null)
  const base = (prev?: WorklogDoc): WorklogDoc => prev ?? { projectId: c.projectId, issueId: c.item.id, entries: [] }
  const save = (fn: (p: WorklogDoc) => WorklogDoc, ok?: string) =>
    put.mutate({ id: c.item.id, update: (prev) => fn(base(prev)) }, { onSuccess: () => ok && toast.success(ok), onError: (e) => toast.error(storeError(e)) })

  const summary = (
    <div className="space-y-1.5">
      <ProgressBar value={logged} total={Math.max(logged + (remain ?? 0), original ?? 0, 1)} tone={original !== null && logged > original ? 'rose' : 'brand'} />
      <div className="flex flex-wrap gap-x-3 text-[11.5px] text-content-muted">
        <span><strong className="text-content">{formatMinutes(logged)}</strong> logged</span>
        <span><strong className="text-content">{formatMinutes(remain)}</strong> remaining</span>
        <span><strong className="text-content">{formatMinutes(original)}</strong> original</span>
      </div>
    </div>
  )
  if (compact) return summary
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2"><ConsoleSide title="Plane's public API has no worklogs — time is kept by the console, keyed to this item" /></div>
      {isError ? <p className="text-[12px] text-rose-700 dark:text-rose-300">{storeError(error)}</p> : null}
      {summary}
      <form
        className="grid grid-cols-2 gap-2 sm:grid-cols-[110px_140px_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault()
          const m = parseDuration(spent)
          if (!m || !user) {
            toast.error('Enter time like 1h 30m, 45m or 2d')
            return
          }
          save((p) => ({ ...p, entries: [...p.entries, { id: newId(), minutes: m, note: note.trim() || undefined, date, by: user.email, byName: user.name }], remainingMinutes: p.remainingMinutes != null ? Math.max(0, p.remainingMinutes - m) : p.remainingMinutes }), `Logged ${formatMinutes(m)}`)
          setSpent('')
          setNote('')
        }}
      >
        <input value={spent} onChange={(e) => setSpent(e.target.value)} placeholder="1h 30m" aria-label="Time spent" className={inputCls} />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" className={inputCls} />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did you do? (optional)" aria-label="Note" className={cn(inputCls, 'col-span-2 sm:col-span-1')} />
        <Button size="sm" variant="primary" type="submit" disabled={!spent.trim()} className="col-span-2 sm:col-span-1">Log time</Button>
      </form>
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-content-muted">
        <span>Original estimate</span>
        <input
          key={`o${original}`}
          defaultValue={original !== null ? formatMinutes(original) : ''}
          placeholder="e.g. 2d"
          onBlur={(e) => {
            const v = e.target.value.trim() === '' ? null : parseDuration(e.target.value)
            if (v === undefined) return toast.error('Enter time like 4h or 2d')
            if (v !== original) save((p) => ({ ...p, originalMinutes: v }))
          }}
          className={cn(inputCls, 'w-24')}
          aria-label="Original estimate"
        />
        <span>Remaining</span>
        <input
          key={`r${d?.remainingMinutes}`}
          value={remaining || (d?.remainingMinutes != null ? formatMinutes(d.remainingMinutes) : '')}
          onChange={(e) => setRemaining(e.target.value)}
          placeholder="auto"
          onBlur={(e) => {
            const v = e.target.value.trim() === '' ? null : parseDuration(e.target.value)
            setRemaining('')
            if (v === undefined) return toast.error('Enter time like 4h or 2d')
            if (v !== (d?.remainingMinutes ?? null)) save((p) => ({ ...p, remainingMinutes: v }))
          }}
          className={cn(inputCls, 'w-24')}
          aria-label="Remaining estimate"
        />
      </div>
      <ul className="divide-y divide-edge-subtle rounded-lg border border-edge-default">
        {(d?.entries ?? []).slice().sort((a, b) => b.date.localeCompare(a.date)).map((e) => (
          <li key={e.id} className="group flex items-center gap-2 px-2.5 py-1.5 text-[12.5px]">
            <span className="w-16 shrink-0 font-medium tabular-nums text-content">{formatMinutes(e.minutes)}</span>
            <span className="shrink-0 text-content-subtle">{e.date}</span>
            <span className="min-w-0 flex-1 truncate text-content-muted">{e.byName ?? e.by}{e.note ? ` — ${e.note}` : ''}</span>
            {user && e.by === user.email ? (
              <button type="button" className="text-[11px] text-content-subtle opacity-0 hover:text-rose-600 group-hover:opacity-100" onClick={() => save((p) => ({ ...p, entries: p.entries.filter((x) => x.id !== e.id) }))}>Delete</button>
            ) : null}
          </li>
        ))}
        {!d?.entries.length ? <li className="px-2.5 py-2 text-[12px] text-content-subtle">No time logged.</li> : null}
      </ul>
    </div>
  )
}

/* ───── watchers (console-side) ───── */

export function WatchButton({ c }: { c: PanelCtx }) {
  const user = useOptionalUser()
  const toast = useToast()
  const { doc } = useDocById<WatchDoc>(KINDS.watch, c.item.id)
  const put = usePutDoc<WatchDoc>(KINDS.watch)
  const watchers = doc?.data.watchers ?? []
  const on = !!user && watchers.some((w) => w.email === user.email)
  return (
    <button
      type="button"
      disabled={!user}
      title={`${watchers.length ? `Watching: ${watchers.map((w) => w.name ?? w.email).join(', ')}. ` : ''}Console-side list — Plane's public API has no subscribers, so Plane won't email watchers.`}
      onClick={() =>
        user && put.mutate({
          id: c.item.id,
          update: (prev) => {
            const list = prev?.watchers ?? []
            return { projectId: c.projectId, issueId: c.item.id, watchers: list.some((w) => w.email === user.email) ? list.filter((w) => w.email !== user.email) : [...list, { email: user.email, name: user.name }] }
          },
        }, { onError: (e) => toast.error(storeError(e)) })}
      className={cn('inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] font-medium', on ? 'text-brand-700 dark:text-brand-300' : 'text-content-muted hover:bg-surface-sunken hover:text-content')}
    >
      {on ? <IconCheck /> : null}
      {on ? 'Watching' : 'Watch'}
      {watchers.length ? <span className="rounded-full bg-surface-sunken px-1.5 text-[10.5px]">{watchers.length}</span> : null}
    </button>
  )
}

