import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  StatusBadge,
  type StatusKind,
  Textarea,
  usePlaneWorkspace,
  useToast,
} from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import {
  planeError,
  priorityKind,
  useCreateIntake,
  useDeleteIntake,
  useIntake,
  useProject,
  useUpdateIntake,
  useUpdateProject,
} from '../data/plane.ts'
import { IssueSearch } from '../components/issue-search.tsx'
import { IssueDrawer } from '../components/issue-drawer.tsx'

/**
 * Intake — the project's triage queue (Plane "Intake", formerly Inbox).
 *
 * Requests land here as pending work items. A triager accepts them (they join
 * the backlog in the project's default state), declines them, snoozes them
 * until a date, or marks them as a duplicate of an existing issue. Everything
 * goes through Plane's public `intake-issues` API; intake has to be switched
 * on for the project, and this page offers that when it is off.
 */

type Tab = 'pending' | 'snoozed' | 'accepted' | 'declined' | 'duplicate' | 'all'
const TAB_STATUS: Record<Tab, plane.IntakeStatus | undefined> = {
  pending: -2,
  snoozed: 0,
  accepted: 1,
  declined: -1,
  duplicate: 2,
  all: undefined,
}
const STATUS_META: Record<plane.IntakeStatus, { label: string; kind: StatusKind }> = {
  [-2]: { label: 'pending', kind: 'progressing' },
  [-1]: { label: 'declined', kind: 'failed' },
  [0]: { label: 'snoozed', kind: 'paused' },
  [1]: { label: 'accepted', kind: 'healthy' },
  [2]: { label: 'duplicate', kind: 'unknown' },
}

export function Intake({ projectId }: { projectId?: string }) {
  const project = useProject(projectId)
  const all = useIntake(projectId)
  const [tab, setTab] = useState<Tab>('pending')
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [openIssue, setOpenIssue] = useState<string | null>(null)
  const updateProject = useUpdateProject()
  const qc = useQueryClient()
  const slug = usePlaneWorkspace()
  const toast = useToast()

  const items = useMemo(() => [...(all.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)), [all.data])
  const counts = useMemo(() => {
    const m = new Map<plane.IntakeStatus, number>()
    for (const i of items) m.set(i.status, (m.get(i.status) ?? 0) + 1)
    return m
  }, [items])
  const shown = TAB_STATUS[tab] === undefined ? items : items.filter((i) => i.status === TAB_STATUS[tab])
  const current = shown.find((i) => i.issue === selected) ?? shown[0]

  if (!projectId) return <EmptyState title="Pick a project" />
  const p = project.data
  const enabled = p ? Boolean(p.intake_view ?? p.inbox_view) : true

  if (p && !enabled) {
    return (
      <EmptyState
        title={`Intake is off for ${p.name}`}
        description="Intake is a triage queue: requests arrive as pending items, and someone accepts, declines, snoozes or merges them before they reach the backlog. Turn it on to use it here and in Plane."
        action={
          <Button
            variant="primary"
            loading={updateProject.isPending}
            onClick={() =>
              updateProject.mutate(
                { id: p.id, patch: { intake_view: true } },
                {
                  onSuccess: () => {
                    qc.invalidateQueries({ queryKey: ['plane', 'project', slug, p.id] })
                    qc.invalidateQueries({ queryKey: ['plane', 'intake', slug, p.id] })
                    toast.success('Intake turned on')
                  },
                  onError: (e) => toast.error(planeError(e, "Couldn't turn on intake.")),
                },
              )}
          >
            Turn on intake
          </Button>
        }
      />
    )
  }

  const TABS: Array<[Tab, string, number | undefined]> = [
    ['pending', 'Pending', counts.get(-2)],
    ['snoozed', 'Snoozed', counts.get(0)],
    ['accepted', 'Accepted', counts.get(1)],
    ['declined', 'Declined', counts.get(-1)],
    ['duplicate', 'Duplicate', counts.get(2)],
    ['all', 'All', items.length],
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg border border-edge-default bg-surface-raised p-1 shadow-sm" role="tablist">
          {TABS.map(([id, label, n]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => {
                setTab(id)
                setSelected(null)
              }}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                tab === id ? 'bg-content text-surface-raised' : 'text-content-muted hover:bg-surface-sunken hover:text-content',
              )}
            >
              {label}
              {n ? <span className={cn('tabular-nums', tab === id ? 'opacity-70' : 'text-content-subtle')}>{n}</span> : null}
            </button>
          ))}
        </div>
        <Button variant="primary" size="sm" className="ml-auto" onClick={() => setCreating(true)}>+ New request</Button>
      </div>

      {all.isLoading ? (
        <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm"><Spinner size={14} /> Loading intake…</div>
      ) : all.isError ? (
        <EmptyState title="Couldn't load intake" description={planeError(all.error)} />
      ) : shown.length === 0 ? (
        <EmptyState
          title={tab === 'pending' ? 'Nothing to triage' : `No ${tab} requests`}
          description={tab === 'pending' ? 'New requests appear here until someone accepts, declines, snoozes or merges them.' : undefined}
          action={tab === 'pending' ? <Button size="sm" onClick={() => setCreating(true)}>Submit a request</Button> : undefined}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <ul className="max-h-[70vh] divide-y divide-edge-subtle overflow-y-auto rounded-xl border border-edge-default bg-surface-raised shadow-sm">
            {shown.map((i) => {
              const d = i.issue_detail
              const on = current?.issue === i.issue
              return (
                <li key={i.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(i.issue)}
                    className={cn('flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors', on ? 'bg-brand-50/60 dark:bg-brand-500/10' : 'hover:bg-surface-sunken/50')}
                  >
                    <span className="flex items-center gap-2">
                      {p ? <span className="font-mono text-[11px] text-content-subtle">{p.identifier}-{d?.sequence_id ?? '?'}</span> : null}
                      <StatusBadge kind={STATUS_META[i.status].kind}>{STATUS_META[i.status].label}</StatusBadge>
                      <span className="ml-auto text-[11px] text-content-subtle">{formatRelative(i.created_at)}</span>
                    </span>
                    <span className="line-clamp-2 text-[13px] font-medium text-content">{d?.name ?? 'Untitled request'}</span>
                    {d?.priority && d.priority !== 'none' ? <span className="self-start"><StatusBadge kind={priorityKind(d.priority)} dot={false}>{d.priority}</StatusBadge></span> : null}
                  </button>
                </li>
              )
            })}
          </ul>
          {current ? (
            <IntakeDetail key={current.issue} projectId={projectId} identifier={p?.identifier} item={current} onOpenIssue={() => setOpenIssue(current.issue)} />
          ) : null}
        </div>
      )}

      <NewRequestModal projectId={projectId} open={creating} onClose={() => setCreating(false)} onCreated={(i) => { setTab('pending'); setSelected(i.issue) }} />
      {openIssue ? <IssueDrawer projectId={projectId} issueId={openIssue} onClose={() => setOpenIssue(null)} onPick={setOpenIssue} /> : null}
    </div>
  )
}

const SNOOZE: Array<[string, number]> = [['Tomorrow', 1], ['Next week', 7], ['In two weeks', 14], ['Next month', 30]]

function IntakeDetail({ projectId, identifier, item, onOpenIssue }: { projectId: string; identifier?: string; item: plane.IntakeItem; onOpenIssue(): void }) {
  const update = useUpdateIntake(projectId)
  const remove = useDeleteIntake(projectId)
  const toast = useToast()
  const [mode, setMode] = useState<null | 'snooze' | 'duplicate'>(null)
  const d = item.issue_detail
  const act = (label: string, patch: Parameters<typeof update.mutate>[0]['patch']) =>
    update.mutate({ issue: item.issue, patch }, {
      onSuccess: () => {
        toast.success(label)
        setMode(null)
      },
      onError: (e) => toast.error(planeError(e, `${label} failed.`)),
    })
  const pending = item.status === -2 || item.status === 0

  return (
    <article className="rounded-xl border border-edge-default bg-surface-raised shadow-sm">
      <header className="border-b border-edge-subtle px-5 py-4">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-content-subtle">
          <span className="font-mono">{identifier}-{d?.sequence_id ?? '?'}</span>
          <StatusBadge kind={STATUS_META[item.status].kind}>{STATUS_META[item.status].label}</StatusBadge>
          <span>submitted {formatRelative(item.created_at)}{item.source ? ` · via ${item.source.replace('_', ' ')}` : ''}</span>
          {item.status === 0 && item.snoozed_till ? <span>· back {formatRelative(item.snoozed_till)}</span> : null}
        </div>
        <h3 className="mt-1.5 text-[17px] font-semibold leading-snug text-content">{d?.name ?? 'Untitled request'}</h3>
      </header>
      <div className="px-5 py-4">
        {d?.description_html && d.description_html !== '<p></p>' ? (
          <div className="prose-sm max-w-none text-[13px] leading-relaxed text-content [&_a]:text-brand-700 [&_p]:my-1.5" dangerouslySetInnerHTML={{ __html: d.description_html }} />
        ) : (
          <p className="text-[13px] italic text-content-subtle">No description.</p>
        )}
      </div>

      {mode === 'snooze' ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-edge-subtle px-5 py-3">
          <span className="text-[12px] text-content-muted">Snooze until</span>
          {SNOOZE.map(([label, days]) => (
            <Button
              key={label}
              size="xs"
              onClick={() => act(`Snoozed until ${label.toLowerCase()}`, { status: 0, snoozed_till: new Date(Date.now() + days * 86_400_000).toISOString() })}
            >
              {label}
            </Button>
          ))}
          <Button size="xs" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
        </div>
      ) : mode === 'duplicate' ? (
        <div className="space-y-2 border-t border-edge-subtle px-5 py-3">
          <div className="text-[12px] text-content-muted">Duplicate of which existing issue?</div>
          <IssueSearch
            autoFocus
            project={projectId}
            exclude={[item.issue]}
            onPick={(h) => act(`Marked as duplicate of ${h.project__identifier}-${h.sequence_id}`, { status: 2, duplicate_to: h.id })}
          />
          <Button size="xs" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
        </div>
      ) : null}

      <footer className="flex flex-wrap items-center gap-2 border-t border-edge-subtle px-5 py-3">
        {pending ? (
          <>
            <Button variant="primary" size="sm" loading={update.isPending} onClick={() => act('Accepted — added to the backlog', { status: 1 })}>Accept</Button>
            <Button size="sm" onClick={() => act('Declined', { status: -1 })}>Decline</Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('snooze')}>Snooze…</Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('duplicate')}>Duplicate of…</Button>
          </>
        ) : item.status === 1 ? (
          <Button variant="primary" size="sm" onClick={onOpenIssue}>Open issue</Button>
        ) : (
          <Button size="sm" onClick={() => act('Moved back to pending', { status: -2, snoozed_till: null })}>Reopen</Button>
        )}
        <button
          type="button"
          onClick={() => {
            if (!confirm('Delete this request? A request that was not accepted is removed with its work item.')) return
            remove.mutate(item.issue, { onSuccess: () => toast.success('Request deleted'), onError: (e) => toast.error(planeError(e, "Couldn't delete the request.")) })
          }}
          className="ml-auto text-[12px] font-medium text-rose-700 hover:underline dark:text-rose-300"
        >
          Delete
        </button>
      </footer>
    </article>
  )
}

function NewRequestModal({ projectId, open, onClose, onCreated }: { projectId: string; open: boolean; onClose(): void; onCreated(i: plane.IntakeItem): void }) {
  const create = useCreateIntake(projectId)
  const toast = useToast()
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [priority, setPriority] = useState<plane.Priority>('none')
  const reset = () => {
    setName('')
    setDesc('')
    setPriority('none')
  }
  const submit = () => {
    if (!name.trim()) return
    const html = desc.trim() ? desc.trim().split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('') : '<p></p>'
    create.mutate({ name: name.trim(), description_html: html, priority }, {
      onSuccess: (item) => {
        toast.success('Request submitted for triage')
        reset()
        onClose()
        onCreated(item)
      },
      onError: (e) => toast.error(planeError(e, "Couldn't submit the request.")),
    })
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New request"
      description="It lands in Intake as pending until someone triages it."
      footer={
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={!name.trim()} loading={create.isPending} onClick={submit}>Submit request</Button>
        </div>
      }
    >
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <Field label="Title" required>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="What is needed, in one line" />
        </Field>
        <Field label="Details">
          <Textarea rows={5} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Context, steps to reproduce, who asked…" />
        </Field>
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value as plane.Priority)} options={['none', 'low', 'medium', 'high', 'urgent'].map((v) => ({ value: v, label: v }))} />
        </Field>
      </form>
    </Modal>
  )
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
