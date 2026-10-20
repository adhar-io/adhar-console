import { useState } from 'react'
import { Button, Modal, useToast } from '@adhar/shell-ui'
import { usePatchSprintMeta } from '../data/planning-store.ts'
import type { plane } from '@adhar/api-clients'
import {
  memberDisplayName,
  memberInitials,
  planeError,
  useCreateCycle,
  useCreateModule,
  useCreateProject,
  useCreateView,
  useInviteMember,
  useLabels,
  useMembers,
  useStates,
} from '../data/plane.ts'
import {
  buildIssueQuery,
  issueQueryChips,
  type IssueGroupBy,
  type IssueSortBy,
  type SavedIssueQuery,
} from '../data/view-query.ts'

/**
 * Lightweight create-modal forms for every Plane entity Adhar can manage.
 * Each lives behind a `Modal` from shell-ui so they all share the same
 * keyboard / scroll-lock / styling.
 */

/* ───── Project ───── */

export function CreateProjectModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose(): void
  onCreated?(p: plane.Project): void
}) {
  const create = useCreateProject()
  const toast = useToast()
  const [name, setName] = useState('')
  const [identifier, setIdentifier] = useState('')
  const [emoji, setEmoji] = useState('')
  const [description, setDescription] = useState('')

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    create.mutate(
      {
        name: trimmed,
        identifier:
          identifier.trim() || trimmed.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase(),
        emoji: emoji || null,
        description: description || undefined,
      },
      {
        onError: (e) => toast.error(planeError(e, "Couldn't create the project.")),
        onSuccess: (p) => {
          toast.success(`Created project ${p.name}.`)
          onCreated?.(p)
          setName('')
          setIdentifier('')
          setEmoji('')
          setDescription('')
          onClose()
        },
      },
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New project"
      description="Projects scope issues, cycles, modules, and pages."
      branded
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            loading={create.isPending}
            disabled={!name.trim()}
          >
            Create project
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Adhar Console"
            className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Identifier">
            <input
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value.toUpperCase().slice(0, 6))}
              placeholder="CON"
              className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 font-mono text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
          </Field>
          <Field label="Emoji">
            <input
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              placeholder="🛰️"
              className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
          </Field>
        </div>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Optional — what this project ships."
            className="block w-full resize-y rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
      </div>
    </Modal>
  )
}

/* ───── Cycle ───── */

export function CreateCycleModal({
  projectId,
  open,
  onClose,
  onCreated,
}: {
  projectId?: string
  open: boolean
  onClose(): void
  onCreated?(c: plane.Cycle): void
}) {
  const create = useCreateCycle(projectId)
  const sprintMeta = usePatchSprintMeta()
  const toast = useToast()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [goal, setGoal] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')

  const submit = () => {
    if (!projectId || !name.trim()) return
    create.mutate(
      {
        name: name.trim(),
        description: description || undefined,
        start_date: start || null,
        end_date: end || null,
      },
      {
        onError: (e) => toast.error(planeError(e, "Couldn't create the sprint.")),
        onSuccess: (c) => {
          toast.success(`Created sprint ${c.name}.`)
          // The goal is console-side (Plane cycles have no goal field).
          if (goal.trim()) sprintMeta.mutate({ id: c.id, fn: (cur) => ({ ...(cur ?? { project: projectId! }), project: projectId!, goal: goal.trim() }) }, { onError: () => toast.error('The sprint was created, but its goal could not be saved (console database unavailable).') })
          onCreated?.(c)
          setName('')
          setGoal('')
          setDescription('')
          setStart('')
          setEnd('')
          onClose()
        },
      },
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New sprint"
      description="A Plane cycle. Give it dates now, or leave them empty and start it from the sprint when the team commits."
      branded
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            loading={create.isPending}
            disabled={!name.trim() || !projectId || Boolean(start) !== Boolean(end) || (Boolean(start && end) && end < start)}
          >
            Create sprint
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sprint 12 — Auth & Platform polish"
            className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Start date">
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm"
            />
          </Field>
          <Field label="End date">
            <input
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm"
            />
          </Field>
        </div>
        <p className="-mt-2 text-[11px] text-content-subtle">
          {Boolean(start) !== Boolean(end)
            ? 'Plane needs both dates, or neither for a draft cycle.'
            : start && end && end < start
              ? 'The end date is before the start date.'
              : 'Leave both empty to save a draft sprint.'}
        </p>
        <Field label="Sprint goal" hint="What the team commits to deliver. Kept in the console.">
          <input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Ship team switching end to end"
            className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Notes for this sprint"
            className="block w-full resize-y rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
      </div>
    </Modal>
  )
}

/* ───── Module ───── */

export function CreateModuleModal({
  projectId,
  open,
  onClose,
  onCreated,
}: {
  projectId?: string
  open: boolean
  onClose(): void
  onCreated?(m: plane.Module): void
}) {
  const create = useCreateModule(projectId)
  const toast = useToast()
  const members = useMembers()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [start, setStart] = useState('')
  const [target, setTarget] = useState('')
  const [lead, setLead] = useState<string>('')

  const submit = () => {
    if (!projectId || !name.trim()) return
    create.mutate(
      {
        name: name.trim(),
        description: description || undefined,
        start_date: start || null,
        target_date: target || null,
        lead: lead || null,
        status: 'planned',
        members: lead ? [lead] : [],
      },
      {
        onError: (e) => toast.error(planeError(e, "Couldn't create the epic.")),
        onSuccess: (m) => {
          toast.success(`Created epic ${m.name}.`)
          onCreated?.(m)
          setName('')
          setDescription('')
          setStart('')
          setTarget('')
          setLead('')
          onClose()
        },
      },
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New epic"
      description="A Plane module: a deliverable that groups related work items, with a lead, dates and progress."
      branded
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            loading={create.isPending}
            disabled={!name.trim() || !projectId}
          >
            Create epic
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Identity & Auth"
            className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="block w-full resize-y rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Start date">
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Target date">
            <input
              type="date"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm"
            />
          </Field>
        </div>
        <Field label="Lead">
          <select
            value={lead}
            onChange={(e) => setLead(e.target.value)}
            className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm"
          >
            <option value="">No lead</option>
            {(members.data ?? []).map((m) => (
              <option key={m.id} value={m.member?.id ?? m.id}>
                {memberDisplayName(m)}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  )
}

/* ───── Saved view ───── */

export function CreateViewModal({
  projectId,
  open,
  onClose,
  initialQuery,
  onCreated,
}: {
  projectId?: string
  open: boolean
  onClose(): void
  /** Seed the filter form — e.g. the Issues board's live filters. */
  initialQuery?: SavedIssueQuery
  onCreated?(v: plane.View): void
}) {
  const create = useCreateView(projectId)
  const toast = useToast()
  const states = useStates(projectId)
  const labels = useLabels(projectId)
  const members = useMembers()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  // Editable filter criteria — seeded from the board when saving live filters.
  const [priority, setPriority] = useState<plane.Priority | ''>(initialQuery?.priority ?? '')
  const [state, setState] = useState<string>(initialQuery?.state ?? '')
  const [label, setLabel] = useState<string>(initialQuery?.label ?? '')
  const [assignee, setAssignee] = useState<string>(initialQuery?.assignee ?? '')
  const [groupBy, setGroupBy] = useState<IssueGroupBy>(initialQuery?.group_by ?? 'state')
  const [sortBy, setSortBy] = useState<IssueSortBy>(initialQuery?.sort_by ?? 'updated')

  const draft: SavedIssueQuery = {
    priority: priority || undefined,
    state: state || undefined,
    label: label || undefined,
    assignee: assignee || undefined,
    group_by: groupBy,
    sort_by: sortBy,
  }
  const query = buildIssueQuery(draft)
  const chips = issueQueryChips(query, {
    states: states.data,
    labels: labels.data,
    members: members.data,
  })

  const submit = () => {
    if (!projectId || !name.trim()) return
    create.mutate(
      {
        name: name.trim(),
        description: description || undefined,
        query_data: query,
      },
      {
        onError: (e) => toast.error(planeError(e, "Couldn't create the view.")),
        onSuccess: (v) => {
          toast.success(`Created view ${v.name}.`)
          onCreated?.(v)
          setName('')
          setDescription('')
          onClose()
        },
      },
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save filters as view"
      description="Pick the filter, group-by, and sort this view should re-apply on the Issues board. Views are saved to your console profile."
      branded
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            loading={create.isPending}
            disabled={!name.trim() || !projectId}
          >
            Save view
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My open issues"
            className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this view shows"
            className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Priority">
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as plane.Priority | '')}
              className={VIEW_SELECT}
            >
              <option value="">Any priority</option>
              {(['urgent', 'high', 'medium', 'low', 'none'] as plane.Priority[]).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="State">
            <select
              value={state}
              onChange={(e) => setState(e.target.value)}
              className={VIEW_SELECT}
            >
              <option value="">Any state</option>
              {(states.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Label">
            <select
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className={VIEW_SELECT}
            >
              <option value="">Any label</option>
              {(labels.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Assignee">
            <select
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              className={VIEW_SELECT}
            >
              <option value="">Anyone</option>
              {(members.data ?? []).map((m) => (
                <option key={m.id} value={m.member?.id ?? m.id}>
                  {memberDisplayName(m)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Group by">
            <select
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as IssueGroupBy)}
              className={VIEW_SELECT}
            >
              {(['state', 'priority', 'assignee', 'label', 'cycle', 'module'] as IssueGroupBy[]).map(
                (g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ),
              )}
            </select>
          </Field>
          <Field label="Sort by">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as IssueSortBy)}
              className={VIEW_SELECT}
            >
              {(['updated', 'created', 'priority', 'target', 'estimate'] as IssueSortBy[]).map(
                (s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ),
              )}
            </select>
          </Field>
        </div>

        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
            Filters captured
          </div>
          {chips.length === 0 ? (
            <div className="rounded-lg border border-dashed border-edge-default bg-surface-sunken/40 px-3 py-3 text-xs text-content-subtle">
              No filters selected — this view will show all issues, grouped by state.
            </div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {chips.map((chip) => (
                <span
                  key={chip.key}
                  className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] font-medium text-content-muted"
                >
                  <span className="text-content-subtle">{chip.key}</span>
                  <span className="text-content">{chip.value}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

const VIEW_SELECT =
  'block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm capitalize focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20'

/* ───── Invite member ───── */

export function InviteMemberModal({
  open,
  onClose,
}: {
  open: boolean
  onClose(): void
}) {
  const invite = useInviteMember()
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<number>(15)

  const submit = () => {
    const to = email.trim()
    if (!to) return
    invite.mutate(
      { email: to, role },
      {
        onSuccess: () => {
          toast.success(`Invitation sent to ${to}.`)
          setEmail('')
          setRole(15)
          onClose()
        },
        onError: (e) => toast.error(planeError(e, 'Couldn\'t send the invitation.')),
      },
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite member"
      description="Sends an email invitation through Plane's workspace flow."
      branded
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            loading={invite.isPending}
            disabled={!email.trim()}
          >
            Send invite
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Email">
          <input
            autoFocus
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
            className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
        <Field label="Role">
          <select
            value={role}
            onChange={(e) => setRole(Number(e.target.value))}
            className="block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-sm"
          >
            <option value={20}>Admin · full workspace access</option>
            <option value={15}>Member · default contributor</option>
            <option value={5}>Guest · limited access</option>
          </select>
        </Field>
      </div>
    </Modal>
  )
}

/* ───── shared atom ───── */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
        {label}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  )
}

/* Re-export so callers don't need to know which file these live in. */
export {
  memberDisplayName,
  memberInitials,
}
