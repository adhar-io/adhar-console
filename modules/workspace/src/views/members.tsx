import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DataTable, EmptyState, StatusBadge, type StatusKind } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { CURRENT_ORG_SLUG, wsClient } from '../data/client.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SelectField,
  SettingsCard,
  StatTile,
  TextField,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

const ROLE_KIND: Record<string, StatusKind> = {
  owner: 'failed',
  admin: 'progressing',
  billing: 'info',
  member: 'info',
  viewer: 'unknown',
}

export function Members() {
  const members = useQuery({
    queryKey: ['ws', 'members', CURRENT_ORG_SLUG],
    queryFn: () => wsClient.listMembers(CURRENT_ORG_SLUG),
  })
  const invitations = useQuery({
    queryKey: ['ws', 'invitations', CURRENT_ORG_SLUG],
    queryFn: () => wsClient.listInvitations(CURRENT_ORG_SLUG),
  })

  const [inviteOpen, setInviteOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<'all' | 'owner' | 'admin' | 'member' | 'billing' | 'viewer'>('all')

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

  const pendingCount = (invitations.data ?? []).filter((i) => i.status === 'pending').length

  return (
    <ViewShell
      title="Members"
      description="Lifecycle, roles, and team affiliation. SSO members are provisioned via SCIM; password members through invitations."
      required={['admin', 'owner']}
      actions={
        <RequirePermission perm="members.invite" required={['admin', 'owner']} readOnly>
          <PrimaryButton onClick={() => setInviteOpen((o) => !o)}>
            <IconPlus /> Invite member
          </PrimaryButton>
        </RequirePermission>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Members" value={members.data?.length ?? 0} hint="active" />
        <StatTile label="Pending invites" value={pendingCount} tone={pendingCount > 0 ? 'warn' : 'good'} />
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

      {inviteOpen ? (
        <InviteForm
          onClose={() => setInviteOpen(false)}
          onSent={() => invitations.refetch()}
        />
      ) : null}

      <SettingsCard
        title="Active members"
        description={`${filtered.length} of ${members.data?.length ?? 0}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <TextField
              value={search}
              onChange={setSearch}
              placeholder="Search by name, email, team…"
            />
            <SelectField<typeof roleFilter>
              value={roleFilter}
              onChange={setRoleFilter}
              options={[
                { value: 'all', label: 'Any role' },
                { value: 'owner', label: 'Owner' },
                { value: 'admin', label: 'Admin' },
                { value: 'billing', label: 'Billing' },
                { value: 'member', label: 'Member' },
                { value: 'viewer', label: 'Viewer' },
              ]}
            />
          </div>
        }
      >
        <DataTable
          loading={members.isLoading}
          rows={filtered}
          rowKey={(m) => m.userId}
          empty={<EmptyState title="No members match" />}
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
                    <div className="font-medium text-content">{m.name}</div>
                    <div className="text-[11px] text-content-muted">{m.email}</div>
                  </div>
                </div>
              ),
            },
            {
              key: 'role',
              header: 'Role',
              cell: (m) => <StatusBadge kind={ROLE_KIND[m.role] ?? 'unknown'}>{m.role}</StatusBadge>,
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
            {
              key: 'sso',
              header: 'Auth',
              cell: (m) =>
                m.ssoProvider ? (
                  <StatusBadge kind="info">SSO · {m.ssoProvider}</StatusBadge>
                ) : (
                  <span className="text-[11px] text-content-muted">password</span>
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
              cell: () => (
                <div className="flex justify-end gap-1.5">
                  <SecondaryButton>Manage</SecondaryButton>
                </div>
              ),
            },
          ]}
        />
      </SettingsCard>

      <SettingsCard title="Pending invitations">
        <DataTable
          loading={invitations.isLoading}
          rows={(invitations.data ?? []).filter((i) => i.status === 'pending')}
          rowKey={(i) => i.id}
          empty={<EmptyState title="No pending invitations" />}
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
            { key: 'invited', header: 'Invited', cell: (i) => formatRelative(i.invitedAt) },
            { key: 'expires', header: 'Expires', cell: (i) => formatRelative(i.expiresAt) },
            {
              key: 'actions',
              header: '',
              cell: () => (
                <div className="flex justify-end gap-1.5">
                  <SecondaryButton>Resend</SecondaryButton>
                  <SecondaryButton tone="rose">Revoke</SecondaryButton>
                </div>
              ),
            },
          ]}
        />
      </SettingsCard>
    </ViewShell>
  )
}

function InviteForm({ onClose, onSent }: { onClose(): void; onSent(): void }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'owner' | 'admin' | 'member' | 'billing' | 'viewer'>('member')
  return (
    <SettingsCard title="Invite a new member">
      <form
        className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_220px_auto_auto]"
        onSubmit={async (e) => {
          e.preventDefault()
          await wsClient.inviteMember(CURRENT_ORG_SLUG, { email, role })
          onSent()
          onClose()
        }}
      >
        <TextField type="email" value={email} onChange={setEmail} placeholder="name@example.com" />
        <SelectField<typeof role>
          value={role}
          onChange={setRole}
          options={[
            { value: 'viewer', label: 'Viewer' },
            { value: 'member', label: 'Member' },
            { value: 'billing', label: 'Billing' },
            { value: 'admin', label: 'Admin' },
            { value: 'owner', label: 'Owner' },
          ]}
        />
        <PrimaryButton type="submit" disabled={!email}>Send invite</PrimaryButton>
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
      </form>
    </SettingsCard>
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
