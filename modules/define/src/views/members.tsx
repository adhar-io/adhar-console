import { useState } from 'react'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Spinner,
  StatusBadge,
  useToast,
} from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import {
  memberDisplayName,
  memberInitials,
  rolePill,
  useDeleteInvitation,
  useInvitations,
  useMembers,
  usePlaneLink,
} from '../data/plane.ts'
import { InviteMemberModal } from '../components/create-forms.tsx'

/**
 * Workspace members and pending invitations, live from Plane.
 *
 * Plane's public API lists members and manages invitations; it has no
 * endpoint to change a member's role or remove them. Those two actions open
 * Plane's own member settings instead of pretending to work here.
 *
 * Roles are Plane's: 20 Admin, 15 Member, 5 Guest.
 */
export function Members() {
  const q = useMembers()
  const invites = useInvitations()
  const cancel = useDeleteInvitation()
  const toast = useToast()
  const [inviteOpen, setInviteOpen] = useState(false)
  const manageUrl = usePlaneLink('settings/members')

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading members…
      </div>
    )
  }
  if (q.isError) {
    return (
      <EmptyState
        title="Couldn't reach Plane"
        description={q.error instanceof Error ? q.error.message : 'Unknown error.'}
      />
    )
  }
  const rows = q.data ?? []
  const adminCount = rows.filter((m) => rolePill(m.role).label === 'Admin').length
  const pending = (invites.data ?? []).filter((i) => !i.accepted)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] text-content-muted">
          {rows.length} member{rows.length === 1 ? '' : 's'} · {adminCount} admin
          {pending.length ? ` · ${pending.length} invited` : ''}
        </div>
        <div className="flex items-center gap-2">
          {manageUrl ? (
            <a
              href={manageUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-edge-default bg-surface-raised px-3 py-1.5 text-[12px] font-medium text-content shadow-sm hover:border-edge-strong"
              title="Change roles or remove members in Plane"
            >
              Manage roles in Plane ↗
            </a>
          ) : null}
          <Button size="sm" onClick={() => setInviteOpen(true)} leading={<IconPlus />}>
            Invite member
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No members yet"
          description="Invite someone to the workspace — click Invite member."
        />
      ) : (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-content">Workspace members</div>
                <div className="text-[11px] text-content-subtle">
                  Roles and removal are managed in Plane.
                </div>
              </div>
              <StatusBadge kind="info">live from Plane</StatusBadge>
            </div>
          </CardHeader>
          <CardBody className="p-0">
            <DataTable
              tableId="define.members"
              features
              columns={[
                {
                  key: 'who',
                  header: 'Person',
                  cell: (m) => (
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-[11px] font-semibold text-brand-700 ring-1 ring-inset ring-brand-200 dark:bg-brand-500/15 dark:text-brand-300 dark:ring-brand-500/30">
                        {memberInitials(m)}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-content">
                          {memberDisplayName(m)}
                        </div>
                        <div className="truncate text-[11px] text-content-subtle">
                          {m.member?.email ?? m.email ?? '—'}
                        </div>
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'role',
                  header: 'Role',
                  width: 140,
                  cell: (m) => {
                    const r = rolePill(m.role)
                    return <StatusBadge kind={r.tone}>{r.label}</StatusBadge>
                  },
                },
              ]}
              rows={rows}
              rowKey={(m) => m.id}
              empty={<EmptyState compact title="No members" />}
            />
          </CardBody>
        </Card>
      )}

      {pending.length ? (
        <Card>
          <CardHeader>
            <div className="text-sm font-semibold text-content">Pending invitations</div>
            <div className="text-[11px] text-content-subtle">
              Plane emails each person a link; they join with the role shown once they accept.
            </div>
          </CardHeader>
          <CardBody className="p-0">
            <DataTable
              tableId="define.invitations"
              columns={[
                {
                  key: 'email',
                  header: 'Email',
                  cell: (i) => <span className="font-medium text-content">{i.email}</span>,
                },
                {
                  key: 'role',
                  header: 'Role',
                  width: 140,
                  cell: (i) => {
                    const r = rolePill(i.role)
                    return <StatusBadge kind={r.tone}>{r.label}</StatusBadge>
                  },
                },
                {
                  key: 'sent',
                  header: 'Sent',
                  width: 140,
                  cell: (i) => (
                    <span className="text-[12px] text-content-muted">
                      {i.created_at ? formatRelative(i.created_at) : '—'}
                    </span>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  width: 90,
                  cell: (i) => (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={cancel.isPending && cancel.variables === i.id}
                      onClick={() =>
                        cancel.mutate(i.id, {
                          onSuccess: () => toast.success(`Invitation to ${i.email} cancelled.`),
                          onError: (e) =>
                            toast.error(e instanceof Error ? e.message : 'Couldn\'t cancel the invitation.'),
                        })}
                    >
                      Cancel
                    </Button>
                  ),
                },
              ]}
              rows={pending}
              rowKey={(i) => i.id}
            />
          </CardBody>
        </Card>
      ) : null}

      <InviteMemberModal open={inviteOpen} onClose={() => setInviteOpen(false)} />
    </div>
  )
}

function IconPlus() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
