import { useEffect, useMemo, useState } from 'react'
import {
  CONSOLE_PERMISSIONS,
  DataTable,
  EmptyState,
  Modal,
  StatusBadge,
  Tabs,
  useCan,
  useToast,
} from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import {
  isDbUnavailable,
  useAddMember,
  useCreateUser,
  useMembersPage,
  useRemoveMember,
  useResendSetupEmail,
  useSearchUsers,
  useTeams,
  useUpdateMemberRole,
  useWorkspaceMe,
  WorkspaceApiError,
  type DirectoryUser,
  type OrgRole,
  type WsMember,
  type WsTeam,
} from '../data/client.ts'
import {
  filterMembers,
  looksLikeEmail,
  memberCounts,
  memberStatusBadge,
  ORG_ROLE_OPTIONS,
  orgRoleBadge,
} from '../data/members-model.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SelectField,
  SettingsCard,
  StatTile,
  TextField,
  ViewShell,
} from '../components/section-shell.tsx'

/**
 * Settings → Members — the organization's people, read from and written to
 * Keycloak. Members are the group `org-<slug>`, admins `org-<slug>-admin`
 * (every admin is in both); the console stores no member, role or invitation
 * records. Adding someone puts an existing Keycloak account into the groups,
 * or creates the account and lets Keycloak email a set-password link.
 *
 * A change reaches the person's own session at their next token refresh (at
 * most 30 minutes); the console re-checks every write against Keycloak live.
 */
export function Members() {
  const me = useWorkspaceMe()
  const page = useMembersPage()
  const teams = useTeams()
  const updateRole = useUpdateMemberRole()
  const removeMember = useRemoveMember()
  const resend = useResendSetupEmail()
  const toast = useToast()
  // Per-action RBAC (docs/rbac.md) — answered for the active organization; the
  // controls are hidden, not disabled, and stay hidden while the answer loads.
  const canAdd = useCan(CONSOLE_PERMISSIONS.membersInvite)
  const canUpdate = useCan(CONSOLE_PERMISSIONS.membersUpdate)
  const canRemove = useCan(CONSOLE_PERMISSIONS.membersRemove)

  const [addOpen, setAddOpen] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<WsMember | null>(null)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<'all' | OrgRole>('all')

  const members = useMemo(() => page.data?.items ?? [], [page.data])
  const filtered = useMemo(() => filterMembers(members, search, roleFilter), [members, search, roleFilter])
  const counts = memberCounts(members)
  const implicit = page.data?.implicit ?? []
  const implicitAdmins = implicit.filter((g) => g.role === 'admin').map((g) => g.group)
  const implicitMembers = implicit.filter((g) => g.role === 'member').map((g) => g.group)
  const groups = orgGroups(me.data?.orgSlug)

  const changeRole = (m: WsMember, role: OrgRole) =>
    updateRole.mutate(
      { userId: m.userId, role },
      {
        onSuccess: () => toast.success(role === 'admin' ? `${m.name} is now an admin` : `${m.name} is now a member`, { description: `Updated in Keycloak (${groups.admin}). Their session picks it up within 30 minutes.` }),
        onError: (e) => toast.error(`Could not change ${m.name}'s role`, { description: (e as Error)?.message }),
      },
    )

  const resendEmail = (m: WsMember) =>
    resend.mutate(m.userId, {
      onSuccess: (r) =>
        r.setupEmail.sent
          ? toast.success(`Set-password email sent to ${m.email}`)
          : toast.warning(`The email to ${m.email} was not sent`, { description: r.setupEmail.detail }),
      onError: (e) => toast.error(`Could not email ${m.email}`, { description: (e as Error)?.message }),
    })

  return (
    <ViewShell
      title="Members"
      description={
        <>
          People in this organization. Membership is the Keycloak groups <Code>{groups.member}</Code> and{' '}
          <Code>{groups.admin}</Code> — the console keeps no member records of its own. Changes reach a person's
          session within 30 minutes.
        </>
      }
      writeCheck={CONSOLE_PERMISSIONS.membersInvite}
      actions={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {me.data && !me.data.keycloakConfigured ? <StatusBadge kind="paused">Keycloak not configured</StatusBadge> : null}
          {canAdd ? (
            <PrimaryButton onClick={() => setAddOpen(true)}>
              <IconPlus /> Add people
            </PrimaryButton>
          ) : null}
        </div>
      }
    >
      {page.isError ? (
        <MembersErrorState error={page.error} retry={() => page.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Members" value={page.isLoading ? '…' : page.data?.truncated ? `${counts.members}+` : counts.members} hint="in Keycloak" />
            <StatTile label="Admins" value={page.isLoading ? '…' : counts.admins} tone={!page.isLoading && counts.admins === 0 ? 'warn' : 'default'} hint={groups.admin} />
            <StatTile label="Invited" value={page.isLoading ? '…' : counts.invited} tone={counts.invited > 0 ? 'warn' : 'good'} hint="no password set yet" />
            <StatTile label="Implicit admins" value={page.isLoading ? '…' : implicitAdmins.length} hint={implicitAdmins.length === 1 ? 'platform group' : 'platform groups'} />
          </div>

          {implicit.length ? (
            <p className="text-[12px] leading-relaxed text-content-muted">
              Not listed below, but admins here too: everyone in {joinGroups(implicitAdmins)} — the platform admin
              groups hold admin in every organization.
              {implicitMembers.length ? <> Everyone in {joinGroups(implicitMembers)} is a member of this, the platform's own organization.</> : null}
            </p>
          ) : null}

          <SettingsCard
            title="People"
            description={page.data?.truncated
              ? `${filtered.length} of the first ${members.length} — the list stops there; search Keycloak for the rest.`
              : `${filtered.length} of ${members.length}`}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <div className="w-64 max-w-full">
                  <TextField value={search} onChange={setSearch} placeholder="Search by name, email, team…" />
                </div>
                <div className="w-36">
                  <SelectField<typeof roleFilter>
                    value={roleFilter}
                    onChange={setRoleFilter}
                    options={[{ value: 'all' as const, label: 'Any role' }, ...ORG_ROLE_OPTIONS]}
                  />
                </div>
              </div>
            }
          >
            <DataTable
              loading={page.isLoading}
              rows={filtered}
              rowKey={(m) => m.userId}
              empty={
                members.length === 0
                  ? (
                    <EmptyState
                      title="No members yet"
                      description={canAdd
                        ? 'Add people with the button above — an existing Keycloak account, or a new one.'
                        : 'Ask an organization admin to add people.'}
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
                        {initials(m.name || m.email)}
                      </div>
                      <div className="min-w-0">
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
                  cell: (m) => {
                    if (!canUpdate) {
                      const r = orgRoleBadge(m.role)
                      return <StatusBadge kind={r.kind}>{r.label}</StatusBadge>
                    }
                    const busy = updateRole.isPending && updateRole.variables?.userId === m.userId
                    return (
                      // A disabled fieldset makes the select inert while its change is in flight.
                      <fieldset disabled={busy} className="w-28">
                        <SelectField<OrgRole> value={m.role} onChange={(role) => role !== m.role && changeRole(m, role)} options={ORG_ROLE_OPTIONS} />
                      </fieldset>
                    )
                  },
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
                  key: 'status',
                  header: 'Status',
                  cell: (m) => {
                    const s = memberStatusBadge(m.status)
                    return (
                      <div className="flex flex-wrap items-center gap-2">
                        <span title={s.hint}>
                          <StatusBadge kind={s.kind}>{s.label}</StatusBadge>
                        </span>
                        {m.status === 'invited' && canAdd ? (
                          <button
                            type="button"
                            disabled={resend.isPending && resend.variables === m.userId}
                            onClick={() => resendEmail(m)}
                            className="text-[11px] font-medium text-brand-700 hover:underline disabled:opacity-50 dark:text-brand-300"
                          >
                            {resend.isPending && resend.variables === m.userId ? 'Sending…' : 'Resend email'}
                          </button>
                        ) : null}
                      </div>
                    )
                  },
                },
                {
                  key: 'created',
                  header: 'Account created',
                  value: (m) => m.createdAt ?? '',
                  cell: (m) => (m.createdAt ? formatRelative(m.createdAt) : '—'),
                },
                {
                  key: 'actions',
                  header: '',
                  // Not for yourself: leaving goes through the organization
                  // switcher, which refuses to strand the organization without an admin.
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
        </>
      )}

      {addOpen ? <AddPeopleModal teams={teams.data ?? []} groups={groups} canEmail={page.data?.canEmail ?? null} onClose={() => setAddOpen(false)} /> : null}
      <ConfirmRemoveModal
        member={pendingRemove}
        groups={groups}
        pending={removeMember.isPending}
        error={removeMember.isError ? (removeMember.error as Error)?.message : undefined}
        onCancel={() => {
          setPendingRemove(null)
          removeMember.reset()
        }}
        onConfirm={() => {
          if (!pendingRemove) return
          const name = pendingRemove.name
          removeMember.mutate(pendingRemove.userId, {
            onSuccess: () => {
              setPendingRemove(null)
              toast.success(`Removed ${name}`, { description: 'Their Keycloak account is kept; they can be added back.' })
            },
          })
        }}
      />
    </ViewShell>
  )
}

/* ─────────────────── add people ─────────────────── */

type AddMode = 'existing' | 'new'

/**
 * Add an existing Keycloak account, or create one. Both put the person into
 * the organization's groups with the chosen role and teams; a new account
 * gets Keycloak's set-password email.
 *
 * Without an SMTP server on the realm (`canEmail === false`, the default
 * install) Keycloak can neither email a new account its set-password link
 * nor verify a self-registered address, so the dialog leads with the path
 * that works — the person signs in once (Keycloak lets them register), then is
 * found here — and New account is off. An account whose email Keycloak never
 * verified may be anyone's sign-up: only a platform admin may add one, and
 * only by saying so.
 */
function AddPeopleModal({ teams, groups, canEmail, onClose }: { teams: WsTeam[]; groups: OrgGroups; canEmail: boolean | null; onClose(): void }) {
  const toast = useToast()
  const add = useAddMember()
  const create = useCreateUser()
  const noEmail = canEmail === false
  const [mode, setMode] = useState<AddMode>('existing')
  const [role, setRole] = useState<OrgRole>('member')
  const [teamSel, setTeamSel] = useState<string[]>([])
  // Existing account
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query.trim(), 300)
  const search = useSearchUsers(debounced)
  // Who was added while the dialog is open, before the search result refreshes.
  const [added, setAdded] = useState<Map<string, OrgRole>>(new Map())
  // New account
  const [email, setEmail] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const results = debounced.length >= 2 ? search.data?.items ?? [] : []
  const exact = search.data?.mode !== 'search'
  // Only platform admins get directory search, and only they may vouch for
  // an account whose email is unverified.
  const platformAdmin = search.data?.mode === 'search'

  const addExisting = (u: DirectoryUser, vouch = false) =>
    add.mutate(
      { userId: u.userId, role, teams: teamSel, ...(vouch ? { allowUnverifiedEmail: true } : {}) },
      {
        onSuccess: (r) => {
          setAdded((m) => new Map(m).set(u.userId, r.item?.role ?? role))
          toast.success(`Added ${u.name || u.email}`, { description: `${role === 'admin' ? 'Admin' : 'Member'} — in ${role === 'admin' ? `${groups.member} and ${groups.admin}` : groups.member}.` })
        },
        onError: (e) => {
          // Already in: show the role they hold (the error carries their row) rather than an error.
          if (e instanceof WorkspaceApiError && e.code === 'already_member') {
            const held = (e.body.item as Partial<WsMember> | undefined)?.role
            setAdded((m) => new Map(m).set(u.userId, held === 'admin' ? 'admin' : 'member'))
            return
          }
          toast.error(`Could not add ${u.name || u.email}`, { description: (e as Error)?.message })
        },
      },
    )

  const createAccount = () => {
    const to = email.trim().toLowerCase()
    create.mutate(
      { email: to, firstName: firstName.trim() || undefined, lastName: lastName.trim() || undefined, role, teams: teamSel },
      {
        onSuccess: (r) => {
          if (r.setupEmail.sent) {
            toast.success(`Account created for ${to}`, { description: 'Keycloak emailed them a link to set a password.' })
          } else {
            toast.warning(`Account created for ${to}, but the email was not sent`, {
              description: `${r.setupEmail.detail ?? 'Keycloak could not send it.'} Use "Resend email" on their row.`,
            })
          }
          onClose()
        },
        onError: (e) => {
          // The account already exists: offer it on the other tab, found by its email.
          if (e instanceof WorkspaceApiError && e.code === 'user_exists') {
            setMode('existing')
            setQuery(to)
            setNotice(`${to} already has a Keycloak account — add it below.`)
            create.reset()
          }
        },
      },
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      branded
      width="lg"
      title="Add people"
      description="Adds people to this organization's Keycloak groups. The console keeps no member records — Keycloak is the directory."
      footer={
        mode === 'new' ? (
          <>
            <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
            <PrimaryButton disabled={!looksLikeEmail(email) || create.isPending} onClick={createAccount}>
              {create.isPending ? 'Creating…' : 'Create account'}
            </PrimaryButton>
          </>
        ) : (
          <PrimaryButton onClick={onClose}>Done</PrimaryButton>
        )
      }
    >
      <Tabs<AddMode>
        ariaLabel="How to add"
        value={mode}
        onChange={(m) => {
          setMode(m)
          setNotice(null)
        }}
        tabs={[
          { id: 'existing', label: 'Existing account' },
          { id: 'new', label: noEmail ? 'New account (needs SMTP)' : 'New account', disabled: noEmail },
        ]}
      >
        {(active) => (
          <div className="space-y-4">
            {active === 'existing' ? (
              <div className="space-y-3">
                {noEmail ? (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                    This realm has no SMTP server, so Keycloak can neither email a new account its set-password link nor
                    verify an email address. Ask the person to sign in to this console once — Keycloak lets them
                    register — then find them here by that email. An account whose email is unverified can only be
                    added by a platform admin.
                  </p>
                ) : null}
                {notice ? <p className="rounded-lg bg-sky-50 px-3 py-2 text-[12px] text-sky-800 dark:bg-sky-500/10 dark:text-sky-200">{notice}</p> : null}
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-content">{exact ? 'Email or username' : 'Search'}</span>
                  <TextField value={query} onChange={setQuery} placeholder={exact ? 'name@example.com' : 'Name, email or username'} />
                  <span className="mt-1 block text-[11px] text-content-subtle">
                    {exact
                      ? 'The exact email address or username of a Keycloak account.'
                      : 'Searching the whole Keycloak directory (platform admin).'}
                  </span>
                </label>
                <ul className="max-h-64 divide-y divide-edge-subtle overflow-auto rounded-xl border border-edge-default">
                  {debounced.length < 2 ? (
                    <li className="p-4 text-center text-[12px] text-content-subtle">Type at least 2 characters.</li>
                  ) : search.isError ? (
                    <li className="p-4 text-center text-[12px] text-rose-700 dark:text-rose-400">{(search.error as Error)?.message}</li>
                  ) : search.isLoading ? (
                    <li className="p-4 text-center text-[12px] text-content-subtle">Searching…</li>
                  ) : results.length === 0 ? (
                    <li className="flex flex-wrap items-center justify-center gap-2 p-4 text-center text-[12px] text-content-subtle">
                      No Keycloak account matches{exact ? ' exactly' : ''}.
                      {looksLikeEmail(debounced) && noEmail ? <span>Ask them to sign in to this console once to create one.</span> : null}
                      {looksLikeEmail(debounced) && !noEmail ? (
                        <button
                          type="button"
                          className="font-medium text-brand-700 hover:underline dark:text-brand-300"
                          onClick={() => {
                            setEmail(debounced)
                            setMode('new')
                          }}
                        >
                          Create an account for {debounced}
                        </button>
                      ) : null}
                    </li>
                  ) : (
                    results.map((u) => {
                      const member = u.membership ?? added.get(u.userId) ?? null
                      return (
                        <li key={u.userId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-content">{u.name || u.username}</div>
                            <div className="truncate text-[11px] text-content-muted">
                              {u.email}
                              {u.username && u.username !== u.email ? ` · ${u.username}` : ''}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {!u.enabled ? <StatusBadge kind="unknown">Disabled</StatusBadge> : null}
                            {!u.emailVerified && !member ? (
                              <span title="Keycloak has not verified that this email address belongs to whoever created the account — anyone can sign up with any address.">
                                <StatusBadge kind="paused">Email not verified</StatusBadge>
                              </span>
                            ) : null}
                            {member ? (
                              <StatusBadge kind="healthy">{member === 'admin' ? 'Admin here' : 'Member here'}</StatusBadge>
                            ) : u.emailVerified ? (
                              <SecondaryButton
                                disabled={add.isPending}
                                onClick={() => addExisting(u)}
                              >
                                {add.isPending && add.variables?.userId === u.userId ? 'Adding…' : 'Add'}
                              </SecondaryButton>
                            ) : platformAdmin ? (
                              <SecondaryButton
                                tone="rose"
                                disabled={add.isPending}
                                onClick={() => addExisting(u, true)}
                              >
                                {add.isPending && add.variables?.userId === u.userId ? 'Adding…' : 'I know them — add anyway'}
                              </SecondaryButton>
                            ) : (
                              <span className="text-[11px] text-content-subtle">A platform admin must add this account</span>
                            )}
                          </div>
                        </li>
                      )
                    })
                  )}
                </ul>
              </div>
            ) : (
              <div className="space-y-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-content">Email</span>
                  <TextField type="email" value={email} onChange={setEmail} placeholder="name@example.com" />
                  <span className="mt-1 block text-[11px] text-content-subtle">
                    Becomes their Keycloak username. Keycloak emails a link to set a password; it is valid for 3 days.
                  </span>
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-content">First name</span>
                    <TextField value={firstName} onChange={setFirstName} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-content">Last name</span>
                    <TextField value={lastName} onChange={setLastName} />
                  </label>
                </div>
                {create.isError ? (
                  <p className="text-[12px] text-rose-700 dark:text-rose-400">
                    {(create.error as Error)?.message ?? 'Could not create the account.'}
                  </p>
                ) : null}
              </div>
            )}

            {/* Applies to whoever is added from either tab. */}
            <div className="grid gap-3 border-t border-edge-subtle pt-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-content">Role</span>
                <SelectField<OrgRole> value={role} onChange={setRole} options={ORG_ROLE_OPTIONS} />
              </label>
              <fieldset className="min-w-0">
                <legend className="mb-1 block text-xs font-medium text-content">Teams</legend>
                {teams.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {teams.map((t) => {
                      const on = teamSel.includes(t.slug)
                      return (
                        <label
                          key={t.id}
                          className={
                            on
                              ? 'inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-brand-50 px-2 py-1 text-[12px] font-medium text-brand-800 ring-1 ring-brand-300 dark:bg-brand-500/15 dark:text-brand-200 dark:ring-brand-500/40'
                              : 'inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-surface-sunken px-2 py-1 text-[12px] text-content-muted ring-1 ring-edge-subtle hover:text-content'
                          }
                        >
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={on}
                            onChange={() => setTeamSel((cur) => (on ? cur.filter((s) => s !== t.slug) : [...cur, t.slug]))}
                          />
                          {t.name}
                        </label>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-[12px] text-content-subtle">This organization has no teams yet.</p>
                )}
              </fieldset>
            </div>
          </div>
        )}
      </Tabs>
    </Modal>
  )
}

/* ─────────────────── remove ─────────────────── */

function ConfirmRemoveModal({
  member,
  groups,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  member: WsMember | null
  groups: OrgGroups
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
      description="Takes the person out of this organization's Keycloak groups. Their Keycloak account is not deleted."
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
            Remove <span className="font-medium">{member.name}</span> ({member.email}) from{' '}
            <Code>{groups.member}</Code>, <Code>{groups.admin}</Code> and every team group of this organization?
          </p>
          <p className="text-[12px] text-content-muted">
            They lose access granted through the organization and its teams at their next token refresh — within
            30 minutes. They can be added back at any time.
          </p>
          {error ? <p className="text-[12px] text-rose-700 dark:text-rose-400">{error}</p> : null}
        </div>
      ) : null}
    </Modal>
  )
}

/* ─────────────────── bits ─────────────────── */

interface OrgGroups {
  member: string
  admin: string
}

/** The organization's Keycloak group names, for the page's copy only — requests never send group names. */
function orgGroups(slug: string | null | undefined): OrgGroups {
  const s = slug || '<slug>'
  return { member: `org-${s}`, admin: `org-${s}-admin` }
}

function joinGroups(groups: string[]): string {
  return groups.join(', ')
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?'
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function Code({ children }: { children: string }) {
  return <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[12px] text-content">{children}</code>
}

/** Fetch-error state — no fake data, ever; each cause says what to do about it. */
function MembersErrorState({ error, retry }: { error: unknown; retry(): void }) {
  if (isDbUnavailable(error)) {
    return (
      <EmptyState
        title="Connect a database"
        description="The organization directory is kept in Postgres. Set DATABASE_URL for the console server to enable it — no stubbed data is shown."
      />
    )
  }
  const code = error instanceof WorkspaceApiError ? error.code : undefined
  if (code === 'keycloak_not_configured') {
    return (
      <EmptyState
        title="Keycloak is not connected"
        description="Members are read from Keycloak groups, and the console has no Keycloak admin credential. Set KEYCLOAK_ADMIN_CLIENT_ID / _SECRET, or grant the console's own client its realm-management roles."
      />
    )
  }
  return (
    <EmptyState
      title={code === 'keycloak_unavailable' ? 'Keycloak could not be reached' : "Couldn't load members"}
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
