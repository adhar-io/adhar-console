import { useMemo, useState } from 'react'
import { EmptyState, Modal, StatusBadge, useToast } from '@adhar-console/shell-ui'
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
  const toast = useToast()

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

          {all.length === 0 && !teams.isLoading ? (
            <div className="rounded-2xl border border-dashed border-edge-default bg-surface-raised p-10">
              <EmptyState
                title="No teams yet"
                description="Create a team to group members and grant project-scoped access."
                action={
                  <RequirePermission perm="teams.write" required={['admin', 'owner']} readOnly>
                    <PrimaryButton onClick={() => setCreateOpen(true)}>
                      <IconPlus /> New team
                    </PrimaryButton>
                  </RequirePermission>
                }
              />
            </div>
          ) : (
            <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
              {teams.isLoading && all.length === 0
                ? Array.from({ length: 6 }).map((_, i) => <TeamCardSkeleton key={i} />)
                : all.map((t) => (
                    <TeamCard
                      key={t.id}
                      team={t}
                      onManage={() => setManaging(t)}
                      onDelete={() => setPendingDelete(t)}
                    />
                  ))}
            </div>
          )}
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
          const name = pendingDelete.name
          deleteTeam.mutate(pendingDelete.id, {
            onSuccess: () => {
              setPendingDelete(null)
              toast.success(`Deleted ${name}`, { description: 'Members keep their projects; only the grouping is gone.' })
            },
            onError: (e) => toast.error(`Could not delete ${name}`, { description: (e as Error)?.message }),
          })
        }}
      />
    </ViewShell>
  )
}

/* ─────────────────── create ─────────────────── */

function CreateTeamModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const create = useCreateTeam()
  const toast = useToast()
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
      {
        onSuccess: (r) => {
          setResult({ synced: r.keycloakSynced })
          if (r.keycloakSynced) toast.success(`Team ${name.trim()} created`, { description: 'Keycloak group synced for cluster RBAC.' })
          else toast.warning(`Team ${name.trim()} created (console-only)`, { description: 'Group sync will apply once a Keycloak admin credential is configured.' })
        },
        onError: (e) => toast.error('Could not create the team', { description: (e as Error)?.message }),
      },
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
  const toast = useToast()
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
                      toast.success('Member added', { description: r.keycloakSynced ? 'Mirrored to the Keycloak group.' : 'Console-only until Keycloak sync is configured.' })
                    },
                    onError: (e) => toast.error('Could not add member', { description: (e as Error)?.message }),
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
                        {
                          onSuccess: (r) => {
                            setLastSync(r.keycloakSynced)
                            toast.success(`Removed ${m.name}`)
                          },
                          onError: (e) => toast.error(`Could not remove ${m.name}`, { description: (e as Error)?.message }),
                        },
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

/* ─────────────────── team card ─────────────────── */

function TeamCard({ team, onManage, onDelete }: { team: WsTeam; onManage(): void; onDelete(): void }) {
  const hue = hashHue(team.slug)
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md dark:hover:border-brand-500/30">
      <div aria-hidden className="h-1.5 w-full" style={{ background: `linear-gradient(90deg, hsl(${hue} 65% 52%), hsl(${(hue + 40) % 360} 65% 45%))` }} />
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[13px] font-semibold text-white shadow-sm ring-1 ring-black/10"
            style={{ backgroundImage: `linear-gradient(135deg, hsl(${hue} 60% 45%), hsl(${(hue + 40) % 360} 60% 32%))` }}
          >
            {team.name.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold text-content">{team.name}</div>
            <code className="font-mono text-[11px] text-content-subtle">{team.slug}</code>
          </div>
          <StatusBadge kind={team.keycloakSynced ? 'healthy' : 'paused'} dot={false}>
            {team.keycloakSynced ? 'RBAC' : 'console-only'}
          </StatusBadge>
        </div>
        <p className="line-clamp-2 min-h-[2.5rem] text-[12.5px] leading-relaxed text-content-muted">
          {team.description || 'No description yet.'}
        </p>
        <dl className="grid grid-cols-3 gap-2">
          <Fact label="Members" value={team.memberCount} />
          <Fact label="Projects" value={team.projectCount} />
          <Fact label="Created" value={formatRelative(team.createdAt)} small />
        </dl>
        {team.keycloakGroup ? (
          <div className="truncate rounded-md bg-surface-sunken px-2 py-1 font-mono text-[10.5px] text-content-subtle" title={team.keycloakGroup}>
            group · {team.keycloakGroup}
          </div>
        ) : null}
        <RequirePermission perm="teams.write" required={['admin', 'owner']} fallback={<span />}>
          <div className="mt-auto flex items-center justify-end gap-1.5 pt-1">
            <SecondaryButton onClick={onManage}>Manage members</SecondaryButton>
            <SecondaryButton tone="rose" onClick={onDelete}>Delete</SecondaryButton>
          </div>
        </RequirePermission>
      </div>
    </article>
  )
}

function Fact({ label, value, small = false }: { label: string; value: string | number; small?: boolean }) {
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken/50 px-2.5 py-2">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</dt>
      <dd className={small ? 'mt-0.5 truncate text-[12px] font-medium text-content' : 'mt-0.5 text-lg font-semibold tabular-nums text-content'}>{value}</dd>
    </div>
  )
}

function TeamCardSkeleton() {
  return (
    <div className="animate-pulse overflow-hidden rounded-2xl border border-edge-default bg-surface-raised">
      <div className="h-1.5 w-full bg-surface-sunken" />
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-surface-sunken" />
          <div className="flex-1 space-y-1.5"><div className="h-3.5 w-1/2 rounded bg-surface-sunken" /><div className="h-2.5 w-1/3 rounded bg-surface-sunken" /></div>
        </div>
        <div className="h-2.5 w-full rounded bg-surface-sunken" />
        <div className="h-2.5 w-3/4 rounded bg-surface-sunken" />
        <div className="grid grid-cols-3 gap-2">{[0, 1, 2].map((i) => <div key={i} className="h-12 rounded-lg bg-surface-sunken" />)}</div>
      </div>
    </div>
  )
}

function hashHue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % 360
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
