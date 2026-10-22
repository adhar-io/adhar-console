import { useMemo, useState } from 'react'
import {
  CONSOLE_PERMISSIONS,
  DataTable,
  EmptyState,
  Modal,
  StatusBadge,
  useCan,
  useToast,
  type StatusKind,
} from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import {
  isDbUnavailable,
  useCreateInvitation,
  useInvitations,
  useMembers,
  useRemoveMember,
  useRevokeInvitation,
  useUpdateMemberRole,
  useWorkspaceMe,
  type CreatedInvitation,
  type OrgRole,
  type WsMember,
} from '../data/client.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SelectField,
  SettingsCard,
  StatTile,
  TextField,
  ViewShell,
} from '../components/section-shell.tsx'

const ROLE_KIND: Record<string, StatusKind> = {
  owner: 'failed',
  admin: 'progressing',
  billing: 'info',
  member: 'info',
  viewer: 'unknown',
}

const ROLE_OPTIONS: { value: OrgRole; label: string }[] = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'member', label: 'Member' },
  { value: 'billing', label: 'Billing' },
  { value: 'admin', label: 'Admin' },
  { value: 'owner', label: 'Owner' },
]

export function Members() {
  const me = useWorkspaceMe()
  const members = useMembers()
  const invitations = useInvitations()
  const updateRole = useUpdateMemberRole()
  const removeMember = useRemoveMember()
  const revoke = useRevokeInvitation()
  const toast = useToast()
  // Per-action RBAC (docs/rbac.md) — the controls are hidden, not disabled,
  // and stay hidden while the answer loads.
  const canInvite = useCan(CONSOLE_PERMISSIONS.membersInvite)
  const canUpdate = useCan(CONSOLE_PERMISSIONS.membersUpdate)
  const canRemove = useCan(CONSOLE_PERMISSIONS.membersRemove)

  const [inviteOpen, setInviteOpen] = useState(false)
  const [invited, setInvited] = useState<CreatedInvitation | null>(null)
  const [pendingRemove, setPendingRemove] = useState<WsMember | null>(null)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<'all' | OrgRole>('all')
  const [lastSync, setLastSync] = useState<{ userId: string; synced: boolean } | null>(null)

  const filtered = useMemo(() => {
    const all = members.data ?? []
    const q = search.trim().toLowerCase()
    return all.filter((m) => {
      if (roleFilter !== 'all' && m.role !== roleFilter) return false
      if (!q) return true
      return (
        m.name.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q) ||
        m.teams.some((t) => t.toLowerCase().includes(q))
      )
    })
  }, [members.data, roleFilter, search])

  const pendingInvites = (invitations.data ?? []).filter((i) => i.status === 'pending')

  return (
    <ViewShell
      title="Members"
      description="Lifecycle, roles, and team affiliation — persisted per tenant, with role groups reflected into Keycloak for cluster RBAC."
      writeCheck={CONSOLE_PERMISSIONS.membersInvite}
      actions={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {me.data ? (
            <StatusBadge kind={me.data.keycloakConfigured ? 'healthy' : 'paused'}>
              {me.data.keycloakConfigured ? 'RBAC sync on' : 'console-only'}
            </StatusBadge>
          ) : null}
          {canInvite ? (
            <PrimaryButton onClick={() => setInviteOpen(true)}>
              <IconPlus /> Invite member
            </PrimaryButton>
          ) : null}
        </div>
      }
    >
      {members.isError ? (
        <StoreErrorState error={members.error} retry={() => members.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Members" value={members.data?.length ?? '…'} hint="active" />
            <StatTile
              label="Pending invites"
              value={pendingInvites.length}
              tone={pendingInvites.length > 0 ? 'warn' : 'good'}
            />
            <StatTile
              label="On SSO"
              value={(members.data ?? []).filter((m) => m.ssoProvider).length}
              hint="provisioned by IdP"
            />
            <StatTile
              label="Owners"
              value={(members.data ?? []).filter((m) => m.role === 'owner').length}
              hint="bus factor"
            />
          </div>

          <SettingsCard
            title="Active members"
            description={`${filtered.length} of ${members.data?.length ?? 0}`}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {lastSync ? (
                  <StatusBadge kind={lastSync.synced ? 'healthy' : 'paused'}>
                    {lastSync.synced ? 'synced to Keycloak' : 'saved, console-only'}
                  </StatusBadge>
                ) : null}
                <div className="w-64 max-w-full">
                  <TextField
                    value={search}
                    onChange={setSearch}
                    placeholder="Search by name, email, team…"
                  />
                </div>
                <div className="w-36">
                  <SelectField<typeof roleFilter>
                    value={roleFilter}
                    onChange={setRoleFilter}
                    options={[{ value: 'all' as const, label: 'Any role' }, ...ROLE_OPTIONS]}
                  />
                </div>
              </div>
            }
          >
            <DataTable
              loading={members.isLoading}
              rows={filtered}
              rowKey={(m) => m.userId}
              empty={
                (members.data?.length ?? 0) === 0
                  ? (
                    <EmptyState
                      title="No members yet"
                      description={canInvite
                        ? 'Invite people with the button above — they appear here once they accept.'
                        : 'Ask a workspace admin to invite people — they appear here once they accept.'}
                    />
                  )
                  : <EmptyState title="No members match" description="Clear the search or pick another role." />
              }
              columns={[
                {
                  key: 'name',
                  header: 'Person',
                  cell: (m) => (
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-linear-to-br from-brand-500 via-brand-600 to-brand-800 text-[11px] font-semibold text-white shadow-sm ring-2 ring-surface-raised">
                        {m.name.split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase()}
                      </div>
                      <div>
                        <div className="font-medium text-content">
                          {m.name}
                          {m.userId === me.data?.userId ? (
                            <span className="ml-1.5 text-[10px] font-normal text-content-subtle">(you)</span>
                          ) : null}
                        </div>
                        <div className="text-[11px] text-content-muted">{m.email}</div>
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'role',
                  header: 'Role',
                  cell: (m) =>
                    canUpdate ? (
                      <div className="w-28">
                        <SelectField<OrgRole>
                          value={m.role}
                          onChange={(role) => {
                            setLastSync(null)
                            updateRole.mutate(
                              { userId: m.userId, role },
                              {
                                onSuccess: (r) =>
                                  setLastSync({ userId: m.userId, synced: r.keycloakSynced }),
                                onError: (e) =>
                                  toast.error(`Could not change ${m.name}'s role`, { description: (e as Error)?.message }),
                              },
                            )
                          }}
                          options={ROLE_OPTIONS}
                        />
                      </div>
                    ) : (
                      <StatusBadge kind={ROLE_KIND[m.role] ?? 'unknown'}>{m.role}</StatusBadge>
                    ),
                },
                {
                  key: 'teams',
                  header: 'Teams',
                  cell: (m) =>
                    m.teams.length ? (
                      <div className="flex flex-wrap gap-1">
                        {m.teams.map((t) => (
                          <span
                            key={t}
                            className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-content-muted ring-1 ring-edge-subtle"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-[11px] text-content-subtle">—</span>
                    ),
                },
                { key: 'joined', header: 'Joined', cell: (m) => formatRelative(m.joinedAt) },
                {
                  key: 'seen',
                  header: 'Last active',
                  cell: (m) => (m.lastActiveAt ? formatRelative(m.lastActiveAt) : '—'),
                },
                {
                  key: 'actions',
                  header: '',
                  // Hidden for yourself too — removing your own membership is not offered here.
                  cell: (m) =>
                    canRemove && m.userId !== me.data?.userId ? (
                      <div className="flex justify-end gap-1.5">
                        <SecondaryButton tone="rose" onClick={() => setPendingRemove(m)}>
                          Remove
                        </SecondaryButton>
                      </div>
                    ) : null,
                },
              ]}
            />
          </SettingsCard>

          <SettingsCard title="Pending invitations">
            <DataTable
              loading={invitations.isLoading}
              rows={pendingInvites}
              rowKey={(i) => i.id}
              empty={<EmptyState title="No pending invitations" compact />}
              columns={[
                {
                  key: 'email',
                  header: 'Email',
                  cell: (i) => <span className="font-medium text-content">{i.email}</span>,
                },
                {
                  key: 'role',
                  header: 'Role',
                  cell: (i) => <StatusBadge kind={ROLE_KIND[i.role] ?? 'unknown'}>{i.role}</StatusBadge>,
                },
                { key: 'invitedBy', header: 'Invited by', cell: (i) => i.invitedBy },
                { key: 'invited', header: 'Invited', cell: (i) => formatRelative(i.invitedAt) },
                { key: 'expires', header: 'Expires', cell: (i) => formatRelative(i.expiresAt) },
                {
                  key: 'actions',
                  header: '',
                  // DELETE /api/workspace/invitations/:id is guarded by membersRemove.
                  cell: (i) =>
                    canRemove ? (
                      <div className="flex justify-end gap-1.5">
                        <SecondaryButton
                          tone="rose"
                          disabled={revoke.isPending}
                          onClick={() =>
                            revoke.mutate(i.id, {
                              onSuccess: () => toast.success(`Invitation for ${i.email} revoked`),
                              onError: (e) =>
                                toast.error('Could not revoke the invitation', { description: (e as Error)?.message }),
                            })}
                        >
                          Revoke
                        </SecondaryButton>
                      </div>
                    ) : null,
                },
              ]}
            />
          </SettingsCard>
        </>
      )}

      <InviteModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onCreated={(inv) => {
          setInviteOpen(false)
          setInvited(inv)
        }}
      />
      <InviteLinkModal invited={invited} onClose={() => setInvited(null)} />
      <ConfirmRemoveModal
        member={pendingRemove}
        pending={removeMember.isPending}
        error={removeMember.isError ? (removeMember.error as Error)?.message : undefined}
        onCancel={() => {
          setPendingRemove(null)
          removeMember.reset()
        }}
        onConfirm={() => {
          if (!pendingRemove) return
          removeMember.mutate(pendingRemove.userId, {
            onSuccess: () => setPendingRemove(null),
          })
        }}
      />
    </ViewShell>
  )
}

/* ─────────────────── invite flow ─────────────────── */

function InviteModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose(): void
  onCreated(inv: CreatedInvitation): void
}) {
  const create = useCreateInvitation()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<OrgRole>('member')

  const submit = () =>
    create.mutate(
      { email: email.trim(), role },
      {
        onSuccess: (inv) => {
          setEmail('')
          setRole('member')
          create.reset()
          onCreated(inv)
        },
      },
    )

  return (
    <Modal
      open={open}
      onClose={onClose}
      branded
      title="Invite a new member"
      description="Creates a pending invitation with a one-time accept token. Only a hash of the token is stored."
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <PrimaryButton disabled={!email.trim() || create.isPending} onClick={submit}>
            {create.isPending ? 'Sending…' : 'Send invite'}
          </PrimaryButton>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-content">Email</span>
          <TextField type="email" value={email} onChange={setEmail} placeholder="name@example.com" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-content">Role</span>
          <SelectField<OrgRole> value={role} onChange={setRole} options={ROLE_OPTIONS} />
        </label>
        {create.isError ? (
          <p className="text-[12px] text-rose-700 dark:text-rose-400">
            {(create.error as Error)?.message ?? 'Could not create the invitation.'}
          </p>
        ) : null}
      </div>
    </Modal>
  )
}

function InviteLinkModal({
  invited,
  onClose,
}: {
  invited: CreatedInvitation | null
  onClose(): void
}) {
  const link = invited
    ? `${globalThis.location?.origin ?? ''}${invited.acceptPath}`
    : ''
  return (
    <Modal
      open={invited !== null}
      onClose={onClose}
      branded
      title="Invitation created"
      description="Share this link with the invitee. It is shown once — a new invite must be created if it's lost."
      footer={<PrimaryButton onClick={onClose}>Done</PrimaryButton>}
    >
      {invited ? (
        <div className="space-y-3">
          <div className="text-[12px] text-content-muted">
            {invited.item.email} · {invited.item.role} · expires {formatRelative(invited.item.expiresAt)}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 font-mono text-[12px] text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
              {link}
            </code>
            <SecondaryButton onClick={() => navigator.clipboard?.writeText(link)}>
              Copy
            </SecondaryButton>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}

function ConfirmRemoveModal({
  member,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  member: WsMember | null
  pending: boolean
  error?: string
  onCancel(): void
  onConfirm(): void
}) {
  return (
    <Modal
      open={member !== null}
      onClose={onCancel}
      title="Remove member"
      description="Revokes workspace access and removes the user from every synced Keycloak group."
      footer={
        <>
          <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
          <SecondaryButton tone="rose" disabled={pending} onClick={onConfirm}>
            {pending ? 'Removing…' : 'Remove'}
          </SecondaryButton>
        </>
      }
    >
      {member ? (
        <div className="space-y-2">
          <p className="text-sm text-content">
            Remove <span className="font-medium">{member.name}</span> ({member.email}) from the
            organization?
          </p>
          {error ? <p className="text-[12px] text-rose-700 dark:text-rose-400">{error}</p> : null}
        </div>
      ) : null}
    </Modal>
  )
}

/** DB-unavailable / fetch-error state — no fake data, ever. */
function StoreErrorState({ error, retry }: { error: unknown; retry(): void }) {
  if (isDbUnavailable(error)) {
    return (
      <EmptyState
        title="Connect a database"
        description="Member management persists to Postgres. Set DATABASE_URL for the console server to enable it — no stubbed data is shown."
      />
    )
  }
  return (
    <EmptyState
      title="Couldn't load members"
      description={(error as Error)?.message ?? 'Unexpected error.'}
      action={<SecondaryButton onClick={retry}>Retry</SecondaryButton>}
    />
  )
}

function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

export default Members
