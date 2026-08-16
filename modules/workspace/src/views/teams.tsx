import { useMemo, useState } from 'react'
import { DataTable, EmptyState, Modal, StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import {
  isDbUnavailable,
  useAddTeamMember,
  useCreateTeam,
  useDeleteTeam,
  useMembers,
  useRemoveTeamMember,
  useTeams,
  useWorkspaceMe,
  type WsTeam,
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
import { RequirePermission } from '../components/role-gate.tsx'

export function Teams() {
  const me = useWorkspaceMe()
  const teams = useTeams()
  const members = useMembers()
  const deleteTeam = useDeleteTeam()

  const [createOpen, setCreateOpen] = useState(false)
  const [managing, setManaging] = useState<WsTeam | null>(null)
  const [pendingDelete, setPendingDelete] = useState<WsTeam | null>(null)

  const all = teams.data ?? []
  // Keep the manage panel bound to fresh data after invalidations.
  const managingFresh = managing ? all.find((t) => t.id === managing.id) ?? null : null

  return (
    <ViewShell
      title="Teams"
      description="Teams grant project-scoped access to groups of members. Each team maps to a Keycloak group (ws-team-<slug>) so cluster RBAC follows the console."
      required={['admin', 'owner']}
      actions={
        <div className="flex items-center gap-2">
          {me.data ? (
            <StatusBadge kind={me.data.keycloakConfigured ? 'healthy' : 'paused'}>
              {me.data.keycloakConfigured ? 'RBAC sync on' : 'console-only'}
            </StatusBadge>
          ) : null}
          <RequirePermission perm="teams.write" required={['admin', 'owner']} readOnly>
            <PrimaryButton onClick={() => setCreateOpen(true)}>
              <IconPlus /> New team
            </PrimaryButton>
          </RequirePermission>
        </div>
      }
    >
      {teams.isError ? (
        <StoreErrorState error={teams.error} retry={() => teams.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Teams" value={teams.isLoading ? '…' : all.length} />
            <StatTile label="Members covered" value={all.reduce((s, t) => s + t.memberCount, 0)} />
            <StatTile label="Projects covered" value={all.reduce((s, t) => s + t.projectCount, 0)} />
            <StatTile
              label="Synced to RBAC"
              value={`${all.filter((t) => t.keycloakSynced).length}/${all.length}`}
              tone={all.length && all.every((t) => t.keycloakSynced) ? 'good' : 'warn'}
              hint="Keycloak groups"
            />
          </div>

          <SettingsCard title="All teams">
            {deleteTeam.isError ? (
              <p className="mb-3 text-[12px] text-rose-700 dark:text-rose-400">
                {(deleteTeam.error as Error)?.message}
              </p>
            ) : null}
            <DataTable
              loading={teams.isLoading}
              rows={all}
              rowKey={(t) => t.id}
              empty={
                <EmptyState
                  title="No teams yet"
                  description="Create a team to group members and grant project-scoped access."
                />
              }
              columns={[
                {
                  key: 'name',
                  header: 'Team',
                  cell: (t) => (
                    <div>
                      <div className="font-medium text-content">{t.name}</div>
                      <div className="text-[11px] text-content-muted">{t.description ?? '—'}</div>
                    </div>
                  ),
                },
                {
                  key: 'slug',
                  header: 'Slug',
                  cell: (t) => (
                    <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px]">
                      {t.slug}
                    </code>
                  ),
                },
                {
                  key: 'rbac',
                  header: 'Cluster RBAC',
                  cell: (t) => (
                    <StatusBadge kind={t.keycloakSynced ? 'healthy' : 'paused'}>
                      {t.keycloakSynced ? `synced · ${t.keycloakGroup}` : 'console-only'}
                    </StatusBadge>
                  ),
                },
                { key: 'members', header: 'Members', numeric: true, cell: (t) => t.memberCount },
                { key: 'projects', header: 'Projects', numeric: true, cell: (t) => t.projectCount },
                { key: 'created', header: 'Created', cell: (t) => formatRelative(t.createdAt) },
                {
                  key: 'actions',
                  header: '',
                  cell: (t) => (
                    <RequirePermission perm="teams.write" required={['admin', 'owner']} fallback={<span />}>
                      <div className="flex justify-end gap-1.5">
                        <SecondaryButton onClick={() => setManaging(t)}>Manage</SecondaryButton>
                        <SecondaryButton tone="rose" onClick={() => setPendingDelete(t)}>
                          Delete
                        </SecondaryButton>
                      </div>
                    </RequirePermission>
                  ),
                },
              ]}
            />
          </SettingsCard>
        </>
      )}

      <CreateTeamModal open={createOpen} onClose={() => setCreateOpen(false)} />
      <ManageTeamModal team={managingFresh} onClose={() => setManaging(null)} />
      <ConfirmDeleteModal
        team={pendingDelete}
        pending={deleteTeam.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return
          deleteTeam.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) })
        }}
      />
    </ViewShell>
  )
}

/* ─────────────────── create ─────────────────── */

function CreateTeamModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const create = useCreateTeam()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [description, setDescription] = useState('')
  const [result, setResult] = useState<{ synced: boolean } | null>(null)

  const close = () => {
    setName('')
    setSlug('')
    setDescription('')
    setResult(null)
    create.reset()
    onClose()
  }

  const submit = () =>
    create.mutate(
      { name: name.trim(), slug: slug.trim() || undefined, description: description.trim() || undefined },
      { onSuccess: (r) => setResult({ synced: r.keycloakSynced }) },
    )

  return (
    <Modal
      open={open}
      onClose={close}
      branded
      title="New team"
      description="Creates the team and its matching Keycloak group for cluster RBAC."
      footer={
        result ? (
          <PrimaryButton onClick={close}>Done</PrimaryButton>
        ) : (
          <>
            <SecondaryButton onClick={close}>Cancel</SecondaryButton>
            <PrimaryButton disabled={!name.trim() || create.isPending} onClick={submit}>
              {create.isPending ? 'Creating…' : 'Create team'}
            </PrimaryButton>
          </>
        )
      }
    >
      {result ? (
        <div className="flex items-center gap-2 text-sm text-content">
          <StatusBadge kind={result.synced ? 'healthy' : 'paused'}>
            {result.synced ? 'synced to Keycloak' : 'created, console-only'}
          </StatusBadge>
          {result.synced
            ? 'The team and its RBAC group are ready.'
            : 'The team was saved; group sync will apply once a Keycloak admin credential is configured.'}
        </div>
      ) : (
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-content">Name</span>
            <TextField value={name} onChange={setName} placeholder="e.g. Platform Engineering" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-content">Slug (optional)</span>
            <TextField mono value={slug} onChange={setSlug} placeholder="platform-eng" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-content">Description</span>
            <TextField value={description} onChange={setDescription} placeholder="What this team owns" />
          </label>
          {create.isError ? (
            <p className="text-[12px] text-rose-700 dark:text-rose-400">
              {(create.error as Error)?.message ?? 'Could not create the team.'}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  )
}

/* ─────────────────── manage membership ─────────────────── */

function ManageTeamModal({ team, onClose }: { team: WsTeam | null; onClose(): void }) {
  const members = useMembers()
  const add = useAddTeamMember()
  const remove = useRemoveTeamMember()
  const [candidate, setCandidate] = useState('')
  const [lastSync, setLastSync] = useState<boolean | null>(null)

  const inTeam = useMemo(
    () => (members.data ?? []).filter((m) => team && m.teams.includes(team.slug)),
    [members.data, team],
  )
  const candidates = useMemo(
    () => (members.data ?? []).filter((m) => team && !m.teams.includes(team.slug)),
    [members.data, team],
  )

  return (
    <Modal
      open={team !== null}
      onClose={onClose}
      branded
      width="lg"
      title={team ? `Manage ${team.name}` : ''}
      description={
        team?.keycloakGroup
          ? `Membership changes are mirrored to the Keycloak group "${team.keycloakGroup}".`
          : undefined
      }
      footer={<PrimaryButton onClick={onClose}>Done</PrimaryButton>}
    >
      {team ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <label className="block min-w-55 flex-1">
              <span className="mb-1 block text-xs font-medium text-content">Add member</span>
              <SelectField
                value={candidate}
                onChange={setCandidate}
                options={[
                  { value: '', label: candidates.length ? 'Select a member…' : 'Everyone is in this team' },
                  ...candidates.map((m) => ({ value: m.userId, label: `${m.name} · ${m.email}` })),
                ]}
              />
            </label>
            <PrimaryButton
              disabled={!candidate || add.isPending}
              onClick={() =>
                add.mutate(
                  { teamId: team.id, userId: candidate },
                  {
                    onSuccess: (r) => {
                      setCandidate('')
                      setLastSync(r.keycloakSynced)
                    },
                  },
                )
              }
            >
              {add.isPending ? 'Adding…' : 'Add'}
            </PrimaryButton>
            {lastSync !== null ? (
              <StatusBadge kind={lastSync ? 'healthy' : 'paused'}>
                {lastSync ? 'synced' : 'console-only'}
              </StatusBadge>
            ) : null}
          </div>

          {(add.isError || remove.isError) ? (
            <p className="text-[12px] text-rose-700 dark:text-rose-400">
              {((add.error ?? remove.error) as Error)?.message}
            </p>
          ) : null}

          <div className="divide-y divide-edge-subtle rounded-xl border border-edge-default">
            {inTeam.length === 0 ? (
              <p className="p-4 text-[12px] text-content-muted">No members yet.</p>
            ) : (
              inTeam.map((m) => (
                <div key={m.userId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-content">{m.name}</div>
                    <div className="truncate text-[11px] text-content-muted">{m.email}</div>
                  </div>
                  <SecondaryButton
                    tone="rose"
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate(
                        { teamId: team.id, userId: m.userId },
                        { onSuccess: (r) => setLastSync(r.keycloakSynced) },
                      )
                    }
                  >
                    Remove
                  </SecondaryButton>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </Modal>
  )
}

function ConfirmDeleteModal({
  team,
  pending,
  onCancel,
  onConfirm,
}: {
  team: WsTeam | null
  pending: boolean
  onCancel(): void
  onConfirm(): void
}) {
  return (
    <Modal
      open={team !== null}
      onClose={onCancel}
      title="Delete team"
      description="Removes the team from every member and deletes its Keycloak group."
      footer={
        <>
          <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
          <SecondaryButton tone="rose" disabled={pending} onClick={onConfirm}>
            {pending ? 'Deleting…' : 'Delete'}
          </SecondaryButton>
        </>
      }
    >
      {team ? (
        <p className="text-sm text-content">
          Delete <span className="font-medium">{team.name}</span> ({team.memberCount} member
          {team.memberCount === 1 ? '' : 's'})? Projects keep running; only access grouping is removed.
        </p>
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
        description="Team management persists to Postgres. Set DATABASE_URL for the console server to enable it — no stubbed data is shown."
      />
    )
  }
  return (
    <EmptyState
      title="Couldn't load teams"
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

export default Teams
