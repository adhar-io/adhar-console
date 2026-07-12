import { useState } from 'react'
import { Button, Modal } from '@adhar-console/shell-ui'
import type { plane } from '@adhar-console/api-clients'
import {
  memberDisplayName,
  memberInitials,
  useCreateCycle,
  useCreateModule,
  useCreateProject,
  useCreateView,
  useInviteMember,
  useMembers,
} from '../data/plane.ts'

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
        onSuccess: (p) => {
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
            className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Identifier">
            <input
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value.toUpperCase().slice(0, 6))}
              placeholder="CON"
              className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 font-mono text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
          </Field>
          <Field label="Emoji">
            <input
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              placeholder="🛰️"
              className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
          </Field>
        </div>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Optional — what this project ships."
            className="block w-full resize-y rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
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
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
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
        status: start && new Date(start) <= new Date() ? 'current' : 'upcoming',
      },
      {
        onSuccess: (c) => {
          onCreated?.(c)
          setName('')
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
      title="New cycle"
      description="Sprint-shaped iteration. Pick a start + end date and Plane tracks progress."
      branded
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={submit}
            loading={create.isPending}
            disabled={!name.trim() || !projectId}
          >
            Create cycle
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
            className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Start date">
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm"
            />
          </Field>
          <Field label="End date">
            <input
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm"
            />
          </Field>
        </div>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Goal of this cycle — what ships?"
            className="block w-full resize-y rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
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
        onSuccess: (m) => {
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
      title="New module"
      description="Epic-shaped grouping that bundles related issues."
      branded
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={submit}
            loading={create.isPending}
            disabled={!name.trim() || !projectId}
          >
            Create module
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
            className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="block w-full resize-y rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Start date">
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Target date">
            <input
              type="date"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm"
            />
          </Field>
        </div>
        <Field label="Lead">
          <select
            value={lead}
            onChange={(e) => setLead(e.target.value)}
            className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm"
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
  query,
  onCreated,
}: {
  projectId?: string
  open: boolean
  onClose(): void
  query: Record<string, unknown>
  onCreated?(v: plane.View): void
}) {
  const create = useCreateView(projectId)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [access, setAccess] = useState<plane.View['access']>('private')

  const submit = () => {
    if (!projectId || !name.trim()) return
    create.mutate(
      {
        name: name.trim(),
        description: description || undefined,
        access,
        query_data: query,
      },
      {
        onSuccess: (v) => {
          onCreated?.(v)
          setName('')
          setDescription('')
          onClose()
        },
      },
    )
  }

  const chips = Object.entries(query).filter(
    ([, v]) =>
      v !== undefined &&
      v !== null &&
      v !== '' &&
      !(Array.isArray(v) && v.length === 0),
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save current filters as view"
      description="Captures your active group-by, sort, and filter state for reuse."
      branded
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
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
            className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_140px]">
          <Field label="Description">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this view shows"
              className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
            />
          </Field>
          <Field label="Access">
            <select
              value={access}
              onChange={(e) => setAccess(e.target.value as plane.View['access'])}
              className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm"
            >
              <option value="private">private</option>
              <option value="public">public</option>
            </select>
          </Field>
        </div>
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
            Filters captured
          </div>
          {chips.length === 0 ? (
            <div className="rounded-lg border border-dashed border-edge-default bg-surface-sunken/40 px-3 py-3 text-xs text-content-subtle">
              No active filters yet — your view will show all issues.
            </div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {chips.map(([k, v]) => (
                <span
                  key={k}
                  className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] font-medium text-content-muted"
                >
                  <span className="text-content-subtle">{k}</span>
                  <span className="text-content">
                    {Array.isArray(v) ? v.join(' / ') : String(v)}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

/* ───── Invite member ───── */

export function InviteMemberModal({
  open,
  onClose,
}: {
  open: boolean
  onClose(): void
}) {
  const invite = useInviteMember()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<number>(15)

  const submit = () => {
    if (!email.trim()) return
    invite.mutate(
      { email: email.trim(), role },
      {
        onSuccess: () => {
          setEmail('')
          setRole(15)
          onClose()
        },
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
            className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
          />
        </Field>
        <Field label="Role">
          <select
            value={role}
            onChange={(e) => setRole(Number(e.target.value))}
            className="block w-full rounded-lg border border-edge-default bg-white px-3 py-2 text-sm"
          >
            <option value={5}>Admin · full workspace access</option>
            <option value={15}>Member · default contributor</option>
            <option value={20}>Guest · limited access</option>
            <option value={25}>Viewer · read-only</option>
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
