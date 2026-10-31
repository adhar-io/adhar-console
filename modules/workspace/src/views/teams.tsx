import { useMemo, useState } from 'react'
import { CONSOLE_PERMISSIONS, EmptyState, Modal, StatusBadge, useCan, useToast } from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import {
  isDbUnavailable,
  useAddTeamMember,
  useCreateTeam,
  useDeleteTeam,
  useMembers,
  useRemoveTeamMember,
  useTeamMembers,
  useTeamsPage,
  useWorkspaceMe,
  type WsTeam,
} from '../data/client.ts'
import { deriveTeamSlug, TEAM_SLUG_RE, teamCandidates } from '../data/members-model.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SelectField,
  StatTile,
  TextField,
  ViewShell,
} from '../components/section-shell.tsx'

/**
 * Teams — groups of an organization's members for project access. A team's
 * membership IS the Keycloak group `ws-team-<org>.<team>`: adding someone here
 * adds them to that group, and the platform's compositions bind it in cluster
 * RBAC. Nothing about who is in a team is stored in the console.
 */
export function Teams() {
  const me = useWorkspaceMe()
  const teams = useTeamsPage()
  const deleteTeam = useDeleteTeam()
  const toast = useToast()
  const canCreate = useCan(CONSOLE_PERMISSIONS.teamsCreate)

  const [createOpen, setCreateOpen] = useState(false)
  const [managing, setManaging] = useState<WsTeam | null>(null)
  const [pendingDelete, setPendingDelete] = useState<WsTeam | null>(null)

  const all = teams.data?.items ?? []
  // Keep the manage panel bound to fresh data after invalidations.
  const managingFresh = managing ? all.find((t) => t.id === managing.id) ?? null : null
  const counted = all.every((t) => t.memberCount !== null)
  const bound = all.filter((t) => t.accessBinding === 'current').length
  const pending = all.filter((t) => t.accessBinding === 'pending-platform-upgrade')
  const org = me.data?.orgSlug || '<org>'

  return (
    <ViewShell
      title="Teams"
      description={`Teams group this organization's members for project access. Each team is the Keycloak group ws-team-${org}.<team> — membership lives there, and cluster RBAC binds that group.`}
      writeCheck={CONSOLE_PERMISSIONS.teamsUpdate}
      actions={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {me.data && !me.data.keycloakConfigured ? <StatusBadge kind="paused">Keycloak not configured</StatusBadge> : null}
          {canCreate ? (
            <PrimaryButton onClick={() => setCreateOpen(true)}>
              <IconPlus /> New team
            </PrimaryButton>
          ) : null}
        </div>
      }
    >
      {teams.isError ? (
        <StoreErrorState error={teams.error} retry={() => teams.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Teams" value={teams.isLoading ? '…' : all.length} />
            <StatTile
              label="Members covered"
              value={counted ? all.reduce((s, t) => s + (t.memberCount ?? 0), 0) : '—'}
              hint={counted ? undefined : 'Keycloak unreachable'}
            />
            <StatTile label="Projects covered" value={all.reduce((s, t) => s + t.projectCount, 0)} />
            <StatTile
              label="Cluster access"
              value={`${bound}/${all.length}`}
              tone={all.length && bound === all.length ? 'good' : 'warn'}
              hint={pending.length ? 'platform upgrade pending' : bound < all.length ? 'not confirmed for every team' : 'team groups bound'}
            />
          </div>

          {teams.data?.degraded ? (
            <Note>Member counts could not be read from Keycloak just now; they show as —.</Note>
          ) : null}
          {pending.length ? (
            <Note>
              {pending.length === 1 ? `${pending[0].name} still binds` : `${pending.length} teams still bind`} cluster
              access to the old, organization-less group name. Access granted through{' '}
              {pending.length === 1 ? 'it' : 'them'} reaches Kubernetes after the next platform upgrade; membership
              itself already works.
            </Note>
          ) : null}

          {all.length === 0 && !teams.isLoading ? (
            <div>
              <EmptyState
                title="No teams yet"
                description={canCreate
                  ? 'Create a team to group members and grant project-scoped access.'
                  : 'Ask an organization admin to create a team to group members and grant project-scoped access.'}
                action={canCreate ? (
                  <PrimaryButton onClick={() => setCreateOpen(true)}>
                    <IconPlus /> New team
                  </PrimaryButton>
                ) : undefined}
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
            onSuccess: (r) => {
              setPendingDelete(null)
              if (r.controlPlaneSynced === false) {
                // The group is gone (so is the access it granted), but the
                // Team resource — and the Gitea team it composes — is not.
                toast.warning(`Deleted ${name}, but its Team resource was left in place`, {
                  description: `${r.controlPlaneDetail ?? 'The console could not delete it.'} Its Keycloak group is gone; members keep their organization membership.`,
                })
                return
              }
              toast.success(`Deleted ${name}`, { description: 'Its Keycloak group is gone; members keep their organization membership.' })
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
  // An explicit slug must already satisfy the Team XRD; a blank one is derived
  // from the name the way the server derives it — shown, so nobody is refused
  // over a slug they never saw, and checked, for a name nothing can be made from.
  const typed = slug.trim()
  const derived = deriveTeamSlug(name)
  const slugInvalid = typed !== '' && !TEAM_SLUG_RE.test(typed)
  const needsSlug = typed === '' && name.trim() !== '' && derived === ''

  const close = () => {
    setName('')
    setSlug('')
    setDescription('')
    create.reset()
    onClose()
  }

  const submit = () =>
    create.mutate(
      { name: name.trim(), slug: slug.trim() || undefined, description: description.trim() || undefined },
      {
        onSuccess: (r) => {
          toast.success(`Team ${r.item.name} created`, { description: `Its membership is the Keycloak group ${r.item.group}.` })
          close()
        },
      },
    )

  return (
    <Modal
      open={open}
      onClose={close}
      branded
      title="New team"
      description="Creates the team and the Keycloak group that holds its members. Add people to it afterwards."
      footer={
        <>
          <SecondaryButton onClick={close}>Cancel</SecondaryButton>
          <PrimaryButton disabled={!name.trim() || slugInvalid || needsSlug || create.isPending} onClick={submit}>
            {create.isPending ? 'Creating…' : 'Create team'}
          </PrimaryButton>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-content">Name</span>
          <TextField value={name} onChange={setName} placeholder="e.g. Platform Engineering" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-content">Slug (optional)</span>
          <TextField mono value={slug} onChange={setSlug} placeholder="platform-eng" />
          <span className={slugInvalid || needsSlug ? 'mt-1 block text-[11px] text-rose-700 dark:text-rose-400' : 'mt-1 block text-[11px] text-content-subtle'}>
            Lowercase letters, digits and hyphens, starting with a letter — at most 40 characters.{' '}
            {typed
              ? null
              : needsSlug
              ? 'No slug can be made from this name — type one.'
              : derived
              ? <>Left empty, it will be <code className="font-mono">{derived}</code>.</>
              : 'Left empty, it is made from the name.'}
          </span>
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
    </Modal>
  )
}

/* ─────────────────── manage membership ─────────────────── */

function ManageTeamModal({ team, onClose }: { team: WsTeam | null; onClose(): void }) {
  const members = useMembers()
  const inTeamQ = useTeamMembers(team?.id)
  const add = useAddTeamMember()
  const remove = useRemoveTeamMember()
  const toast = useToast()
  const [candidate, setCandidate] = useState('')

  const inTeam = useMemo(() => inTeamQ.data ?? [], [inTeamQ.data])
  // Anyone in the organization who is not in the team yet — read from the team's own group.
  const candidates = useMemo(() => teamCandidates(members.data ?? [], inTeam), [members.data, inTeam])

  return (
    <Modal
      open={team !== null}
      onClose={onClose}
      branded
      width="lg"
      title={team ? `Manage ${team.name}` : ''}
      description={team ? `Membership is the Keycloak group "${team.group}". Changes reach people's sessions within 30 minutes.` : undefined}
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
                  {
                    value: '',
                    label: members.isLoading || inTeamQ.isLoading
                      ? 'Loading…'
                      : candidates.length ? 'Select a member…' : 'Everyone in the organization is in this team',
                  },
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
                    onSuccess: () => {
                      setCandidate('')
                      toast.success('Member added', { description: `Added to ${team.group} in Keycloak.` })
                    },
                    onError: (e) => toast.error('Could not add member', { description: (e as Error)?.message }),
                  },
                )
              }
            >
              {add.isPending ? 'Adding…' : 'Add'}
            </PrimaryButton>
          </div>

          <div className="divide-y divide-edge-subtle rounded-xl border border-edge-default">
            {inTeamQ.isLoading ? (
              <p className="p-4 text-[12px] text-content-muted">Loading members…</p>
            ) : inTeamQ.isError ? (
              <p className="p-4 text-[12px] text-rose-700 dark:text-rose-400">{(inTeamQ.error as Error)?.message ?? 'Could not read the team from Keycloak.'}</p>
            ) : inTeam.length === 0 ? (
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
                          onSuccess: () => toast.success(`Removed ${m.name}`),
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
      description="Deletes the team and its Keycloak group, so its members lose the access granted through it."
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
          Delete <span className="font-medium">{team.name}</span>
          {team.memberCount !== null ? ` (${team.memberCount} member${team.memberCount === 1 ? '' : 's'})` : ''} and the
          group <code className="font-mono text-[12px]">{team.group}</code>? Projects keep running and people stay in the
          organization; only the team's access grouping is removed.
        </p>
      ) : null}
    </Modal>
  )
}

/* ─────────────────── team card ─────────────────── */

function TeamCard({ team, onManage, onDelete }: { team: WsTeam; onManage(): void; onDelete(): void }) {
  const hue = hashHue(team.slug)
  // Team membership edits go through PATCH on the team → teamsUpdate.
  const canManage = useCan(CONSOLE_PERMISSIONS.teamsUpdate)
  const canDelete = useCan(CONSOLE_PERMISSIONS.teamsDelete)
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
          {team.accessBinding === 'pending-platform-upgrade' ? (
            <span title="Cluster RBAC still binds this team's old, organization-less group; it moves to the group below with the next platform upgrade.">
              <StatusBadge kind="paused" dot={false}>upgrade pending</StatusBadge>
            </span>
          ) : null}
        </div>
        <p className="line-clamp-2 min-h-[2.5rem] text-[12px] leading-relaxed text-content-muted">
          {team.description || 'No description yet.'}
        </p>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Fact label="Members" value={team.memberCount ?? '—'} />
          <Fact label="Projects" value={team.projectCount} />
          <Fact label="Created" value={formatRelative(team.createdAt)} small />
        </dl>
        <div className="truncate rounded-md bg-surface-sunken px-2 py-1 font-mono text-[10px] text-content-subtle" title={team.group}>
          group · {team.group}
        </div>
        {canManage || canDelete ? (
          <div className="mt-auto flex items-center justify-end gap-1.5 pt-1">
            {canManage ? <SecondaryButton onClick={onManage}>Manage members</SecondaryButton> : null}
            {canDelete ? <SecondaryButton tone="rose" onClick={onDelete}>Delete</SecondaryButton> : null}
          </div>
        ) : null}
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

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
      {children}
    </p>
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">{[0, 1, 2].map((i) => <div key={i} className="h-12 rounded-lg bg-surface-sunken" />)}</div>
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
        description="Teams persist to Postgres. Set DATABASE_URL for the console server to enable it — no stubbed data is shown."
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
