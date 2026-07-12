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
} from '@adhar-console/shell-ui'
import {
  memberDisplayName,
  memberInitials,
  rolePill,
  useMembers,
  useRemoveMember,
  useUpdateMemberRole,
} from '../data/plane.ts'
import { InviteMemberModal } from '../components/create-forms.tsx'

/**
 * Workspace members from Plane (`/workspaces/{slug}/members/`).
 *
 * Plane's role enum:
 *   5  = Admin
 *   15 = Member
 *   20 = Guest
 *   25 = Viewer
 */
export function Members() {
  const q = useMembers()
  const updateRole = useUpdateMemberRole()
  const remove = useRemoveMember()
  const [inviteOpen, setInviteOpen] = useState(false)

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
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
  const adminCount = rows.filter((m) => m.role === 5).length

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-content-muted">
          {rows.length} member{rows.length === 1 ? '' : 's'} · {adminCount} admin
        </div>
        <Button size="sm" onClick={() => setInviteOpen(true)} leading={<IconPlus />}>
          Invite member
        </Button>
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
                  Manage roles or remove access.
                </div>
              </div>
              <StatusBadge kind="info">live from Plane</StatusBadge>
            </div>
          </CardHeader>
          <CardBody className="p-0">
            <DataTable
              columns={[
                {
                  key: 'who',
                  header: 'Person',
                  cell: (m) => (
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-[11px] font-semibold text-brand-700 ring-1 ring-inset ring-brand-200">
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
                  cell: (m) => {
                    const r = rolePill(m.role)
                    return (
                      <div className="flex items-center gap-2">
                        <StatusBadge kind={r.tone}>{r.label}</StatusBadge>
                        <select
                          value={m.role}
                          disabled={updateRole.isPending}
                          onChange={(e) =>
                            updateRole.mutate({
                              id: m.id,
                              role: Number(e.target.value),
                            })
                          }
                          className="rounded-md border border-edge-default bg-white px-2 py-1 text-[11px] focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
                          aria-label={`Change role for ${memberDisplayName(m)}`}
                        >
                          <option value={5}>Admin</option>
                          <option value={15}>Member</option>
                          <option value={20}>Guest</option>
                          <option value={25}>Viewer</option>
                        </select>
                      </div>
                    )
                  },
                },
                {
                  key: 'id',
                  header: 'Member ID',
                  cell: (m) => (
                    <code className="font-mono text-[11px] text-content-muted">
                      {m.member?.id ?? m.id}
                    </code>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  width: 80,
                  cell: (m) => (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={remove.isPending}
                      onClick={() => {
                        if (
                          !confirm(
                            `Remove ${memberDisplayName(m)} from the workspace? They'll lose access immediately.`,
                          )
                        )
                          return
                        remove.mutate(m.id)
                      }}
                    >
                      Remove
                    </Button>
                  ),
                },
              ]}
              rows={rows}
              rowKey={(m) => m.id}
              empty={<EmptyState compact title="No members" />}
            />
          </CardBody>
        </Card>
      )}

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
