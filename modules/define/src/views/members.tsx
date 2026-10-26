import { useMemo, useState } from 'react'
import { Button, type Column, DataTable, EmptyState, Field, Input, Modal, StatusBadge, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import { memberDisplayName, rolePill, useDeleteInvitation, useInvitations, useMembers, usePlaneLink, useProjects } from '../data/plane.ts'
import { toWorkItem, usePortfolio } from '../data/planning-plane.ts'
import { KIND, type MemberMeta, storeError, useMemberMetas, usePatchMemberMeta, useStoreList } from '../data/planning-store.ts'
import { type Absence, dayKey, workload, type WorkloadRow } from '../data/planning-model.ts'
import { usePlanningParams, useSetPlanningParams } from '../data/planning-nav.ts'
import { InviteMemberModal } from '../components/create-forms.tsx'
import { Avatar, Loading, Meter, Notice, ProblemState, Segmented, usePeople } from '../components/planning-ui.tsx'

/**
 * Members — workload across projects (open work, in progress, points,
 * overdue per person, against weekly capacity, with availability), the
 * workspace directory with Plane roles, and pending invitations.
 *
 * Plane's public API lists members and manages invitations but cannot change
 * a workspace role or remove someone; those link to Plane. Capacity and
 * availability are console-side (`define.member`).
 */

type View = 'workload' | 'directory' | 'invites'

export function Members() {
  const params = usePlanningParams()
  const setParams = useSetPlanningParams()
  const view: View = params.tab === 'directory' || params.tab === 'invites' ? params.tab : 'workload'
  const invites = useInvitations()
  const [inviteOpen, setInviteOpen] = useState(false)
  const pending = (invites.data ?? []).filter((i) => !i.accepted)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label="Members view"
          value={view}
          onChange={(v) => setParams({ tab: v === 'workload' ? undefined : v })}
          options={[{ value: 'workload', label: 'Workload' }, { value: 'directory', label: 'Directory' }, { value: 'invites', label: `Invitations${pending.length ? ` · ${pending.length}` : ''}` }]}
        />
        <Button variant="primary" size="sm" onClick={() => setInviteOpen(true)}>Invite member</Button>
      </div>
      {view === 'directory' ? <Directory /> : view === 'invites' ? <Invitations pending={pending} loading={invites.isLoading} error={invites.error} /> : <Workload />}
      <InviteMemberModal open={inviteOpen} onClose={() => setInviteOpen(false)} />
    </div>
  )
}

/* ───── workload ───── */

function Workload() {
  const projects = useProjects()
  const memberMetas = useMemberMetas()
  const { people, list, loading } = usePeople()
  const [editing, setEditing] = useState<string | null>(null)

  // Every Plane project, always — Define never narrows Plane by console team.
  const scoped = useMemo(() => (projects.data ?? []).filter((p) => !p.archived_at), [projects.data])
  const ids = useMemo(() => scoped.map((p) => p.id), [scoped])
  const portfolio = usePortfolio(ids)
  const mm = useMemo(() => new Map((memberMetas.data ?? []).map((d) => [d.id, d.data])), [memberMetas.data])
  const pointDocs = useStoreList<{ points?: Record<string, number> }>(KIND.points)
  const points = useMemo(() => Object.assign({}, ...(pointDocs.data ?? []).map((d) => d.data.points ?? {})) as Record<string, number>, [pointDocs.data])

  const rows = useMemo(() => {
    const items = [...portfolio.issues.values()].flatMap((v) => (v ?? []).map(toWorkItem))
    const capacity: Record<string, number> = {}
    for (const [id, m] of mm) if (m.weeklyCapacity) capacity[id] = m.weeklyCapacity
    const loads = workload({ items, capacity, points })
    const seen = new Set(loads.map((r) => r.member))
    // Everyone appears, idle people included — an empty row is information too.
    for (const p of list) if (!seen.has(p.id)) loads.push({ member: p.id, open: 0, inProgress: 0, points: 0, overdue: 0, projects: [], capacity: capacity[p.id] ?? null, over: false })
    return loads
  }, [portfolio.issues, mm, list, points])
  const projectName = new Map(scoped.map((p) => [p.id, p.identifier]))
  const today = dayKey(Date.now())
  const awayNow = (id: string) => (mm.get(id)?.absences ?? []).find((a) => a.from <= today && today <= a.to)

  if (projects.isLoading || loading) return <Loading label="Loading people…" />
  if (projects.isError) return <ProblemState error={projects.error} onRetry={() => projects.refetch()} />

  const over = rows.filter((r) => r.over)
  const maxOpen = Math.max(1, ...rows.map((r) => r.open))
  const columns: Column<WorkloadRow>[] = [
    {
      key: 'who',
      header: 'Person',
      pinned: true,
      value: (r) => people.get(r.member)?.name ?? '',
      cell: (r) => {
        const p = people.get(r.member)
        const away = awayNow(r.member)
        return (
          <span className="flex min-w-0 items-center gap-2">
            <Avatar person={p} size={22} />
            <span className="min-w-0">
              <span className="block truncate font-medium text-content">{p?.name ?? 'Not in the workspace'}</span>
              {away ? <span className="block truncate text-[11px] text-amber-700 dark:text-amber-300">away until {away.to}{away.note ? ` · ${away.note}` : ''}</span> : null}
            </span>
          </span>
        )
      },
    },
    {
      key: 'open',
      header: 'Open work',
      value: (r) => r.open,
      cell: (r) => (
        <span className="flex items-center gap-2">
          <Meter value={r.open} max={maxOpen} className="w-20" tone={r.over ? 'bad' : 'brand'} label="Open work" />
          <span className="tabular-nums text-content">{r.open}</span>
        </span>
      ),
    },
    { key: 'progress', header: 'In progress', numeric: true, value: (r) => r.inProgress, cell: (r) => <span className={cn(r.inProgress > 5 && 'font-medium text-amber-700 dark:text-amber-300')}>{r.inProgress}</span> },
    { key: 'points', header: 'Points', numeric: true, value: (r) => r.points, cell: (r) => (r.points ? r.points : '—') },
    { key: 'overdue', header: 'Overdue', numeric: true, value: (r) => r.overdue, cell: (r) => <span className={cn(r.overdue > 0 && 'font-medium text-rose-700 dark:text-rose-300')}>{r.overdue}</span> },
    { key: 'capacity', header: 'Capacity / wk', numeric: true, value: (r) => r.capacity ?? -1, cell: (r) => (r.capacity ? `${r.capacity} pts` : '—') },
    {
      key: 'state',
      header: 'Load',
      value: (r) => Number(r.over),
      cell: (r) => (r.over ? <StatusBadge kind="degraded">Over-allocated</StatusBadge> : r.open ? <StatusBadge kind="healthy">OK</StatusBadge> : <span className="text-[11px] text-content-subtle">idle</span>),
    },
    { key: 'projects', header: 'Projects', value: (r) => r.projects.length, cell: (r) => <span className="text-[11px] text-content-muted">{r.projects.map((p) => projectName.get(p) ?? '?').join(', ') || '—'}</span> },
    { key: 'edit', header: '', sortable: false, cell: (r) => <Button size="xs" variant="ghost" onClick={() => setEditing(r.member)}>Capacity…</Button> },
  ]

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-content-muted">
        Open work items per person across {scoped.length} project{scoped.length === 1 ? '' : 's'}; shared items count for each assignee (points split). Over-allocated: points above weekly capacity, or more than five items in progress when no capacity is set.
      </p>
      {over.length ? <Notice tone="warn">{over.length} {over.length === 1 ? 'person is' : 'people are'} over-allocated: {over.slice(0, 5).map((r) => people.get(r.member)?.name ?? 'someone').join(', ')}{over.length > 5 ? '…' : ''}.</Notice> : null}
      {portfolio.error ? <ProblemState compact error={portfolio.error} /> : null}
      {memberMetas.isError ? <Notice tone="warn">{storeError(memberMetas.error)}</Notice> : null}
      {portfolio.loading && !rows.some((r) => r.open) ? <Loading label="Loading work across projects…" /> : (
        <DataTable tableId="define-workload" columns={columns} rows={rows} rowKey={(r) => r.member} defaultSort={{ key: 'open', dir: 'desc' }} features={{ search: true, columns: true, export: true }} searchPlaceholder="Search people…" />
      )}
      {editing ? <CapacityModal member={editing} name={people.get(editing)?.name ?? 'This person'} meta={mm.get(editing)} onClose={() => setEditing(null)} /> : null}
    </div>
  )
}

function CapacityModal({ member, name, meta, onClose }: { member: string; name: string; meta?: MemberMeta; onClose(): void }) {
  const save = usePatchMemberMeta()
  const toast = useToast()
  const [cap, setCap] = useState(meta?.weeklyCapacity ? String(meta.weeklyCapacity) : '')
  const [absences, setAbsences] = useState<Absence[]>(meta?.absences ?? [])
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [note, setNote] = useState('')
  const today = dayKey(Date.now())
  return (
    <Modal
      open
      onClose={onClose}
      title={`${name} — capacity and availability`}
      description="Kept in the console. Sprint capacity subtracts days off that fall inside a sprint."
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() =>
              save.mutate({ id: member, fn: (c) => ({ ...(c ?? {}), weeklyCapacity: Number(cap) > 0 ? Number(cap) : undefined, absences }) }, {
                onSuccess: () => {
                  toast.success('Saved')
                  onClose()
                },
                onError: (e) => toast.error(storeError(e)),
              })}
          >
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Weekly capacity (points)" hint="Leave empty if this person does not take planned work.">
          <Input type="number" min={0} value={cap} onChange={(e) => setCap(e.target.value)} className="w-32" />
        </Field>
        <div>
          <div className="mb-1 text-[12px] font-medium text-content">Time off</div>
          <ul className="mb-2 space-y-1">
            {absences.filter((a) => a.to >= today).sort((a, b) => a.from.localeCompare(b.from)).map((a, k) => (
              <li key={`${a.from}-${k}`} className="flex items-center gap-2 text-[12px] text-content">
                <span className="tabular-nums">{a.from} → {a.to}</span>
                {a.note ? <span className="text-content-muted">{a.note}</span> : null}
                <button type="button" className="ml-auto text-content-subtle hover:text-content" onClick={() => setAbsences(absences.filter((x) => x !== a))}>Remove</button>
              </li>
            ))}
            {!absences.some((a) => a.to >= today) ? <li className="text-[12px] text-content-subtle">None planned.</li> : null}
          </ul>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
            <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Vacation" /></Field>
            <Button
              size="sm"
              disabled={!from || !to || to < from}
              onClick={() => {
                setAbsences([...absences, { from, to, note: note.trim() || undefined }])
                setFrom('')
                setTo('')
                setNote('')
              }}
            >
              Add
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

/* ───── directory ───── */

function Directory() {
  const q = useMembers()
  const manageUrl = usePlaneLink('settings/members')
  if (q.isLoading) return <Loading label="Loading members…" />
  if (q.isError) return <ProblemState error={q.error} onRetry={() => q.refetch()} />
  const rows = q.data ?? []
  const admins = rows.filter((m) => m.role === 20).length
  const columns: Column<plane.Member>[] = [
    {
      key: 'who',
      header: 'Person',
      pinned: true,
      value: (m) => memberDisplayName(m),
      cell: (m) => (
        <span className="min-w-0">
          <span className="block truncate font-medium text-content">{memberDisplayName(m)}</span>
          <span className="block truncate text-[11px] text-content-subtle">{m.member?.email ?? m.email ?? '—'}</span>
        </span>
      ),
    },
    {
      key: 'role',
      header: 'Workspace role',
      value: (m) => m.role,
      cell: (m) => {
        const r = rolePill(m.role)
        return <StatusBadge kind={r.tone}>{r.label}</StatusBadge>
      },
    },
  ]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-content-muted">
        <span>{rows.length} member{rows.length === 1 ? '' : 's'} · {admins} admin{admins === 1 ? '' : 's'}. Plane's API cannot change workspace roles or remove members.</span>
        {manageUrl ? <a href={manageUrl} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline dark:text-brand-300">Manage roles in Plane ↗</a> : null}
      </div>
      <DataTable tableId="define.members" features columns={columns} rows={rows} rowKey={(m) => m.id} empty={<EmptyState compact title="No members" />} />
    </div>
  )
}

/* ───── invitations ───── */

function Invitations({ pending, loading, error }: { pending: plane.Invitation[]; loading: boolean; error: unknown }) {
  const cancel = useDeleteInvitation()
  const toast = useToast()
  if (loading) return <Loading label="Loading invitations…" />
  if (error) return <ProblemState error={error} />
  if (!pending.length) return <EmptyState title="No pending invitations" description="Plane emails each invitee a link; they join with the role shown once they accept." />
  return (
    <DataTable
      tableId="define.invitations"
      rows={pending}
      rowKey={(i) => i.id}
      columns={[
        { key: 'email', header: 'Email', cell: (i) => <span className="font-medium text-content">{i.email}</span> },
        {
          key: 'role',
          header: 'Role',
          cell: (i) => {
            const r = rolePill(i.role)
            return <StatusBadge kind={r.tone}>{r.label}</StatusBadge>
          },
        },
        { key: 'sent', header: 'Sent', value: (i) => i.created_at ?? '', cell: (i) => <span className="text-[12px] text-content-muted">{i.created_at ? formatRelative(i.created_at) : '—'}</span> },
        {
          key: 'actions',
          header: '',
          sortable: false,
          cell: (i) => (
            <Button
              size="xs"
              variant="ghost"
              loading={cancel.isPending && cancel.variables === i.id}
              onClick={() =>
                cancel.mutate(i.id, {
                  onSuccess: () => toast.success(`Invitation to ${i.email} cancelled`),
                  onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't cancel the invitation."),
                })}
            >
              Cancel
            </Button>
          ),
        },
      ]}
    />
  )
}
