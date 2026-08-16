import { useEffect, useState } from 'react'
import { DataTable, EmptyState, Modal, StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import {
  isDbUnavailable,
  useCreateProject,
  useDeleteProject,
  useProjects,
  useTeams,
  useUpdateProject,
  type WsProject,
} from '../data/client.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SettingsCard,
  StatTile,
  TextField,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

const ENVIRONMENTS = ['dev', 'staging', 'preview', 'prod']

export function Projects() {
  const q = useProjects()
  const del = useDeleteProject()
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<WsProject | null>(null)
  const [pendingDelete, setPendingDelete] = useState<WsProject | null>(null)

  const all = q.data ?? []

  const openCreate = () => {
    setEditing(null)
    setEditorOpen(true)
  }
  const openEdit = (p: WsProject) => {
    setEditing(p)
    setEditorOpen(true)
  }

  return (
    <ViewShell
      title="Projects"
      description="Bundle a primary repo, environments, and the teams that can ship to them. Persisted per tenant and audit-logged."
      required={['admin', 'owner']}
      actions={
        <RequirePermission perm="projects.write" required={['admin', 'owner']} readOnly>
          <PrimaryButton onClick={openCreate}>
            <IconPlus /> New project
          </PrimaryButton>
        </RequirePermission>
      }
    >
      {q.isError ? (
        <StoreErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Projects" value={q.isLoading ? '…' : all.length} />
            <StatTile label="With repo" value={all.filter((p) => p.primaryRepo).length} />
            <StatTile
              label="Environments"
              value={all.reduce((s, p) => s + (p.environments?.length ?? 0), 0)}
            />
            <StatTile label="Teams involved" value={new Set(all.flatMap((p) => p.teams)).size} />
          </div>

          <SettingsCard title="All projects">
            {del.isError ? (
              <p className="mb-3 text-[12px] text-rose-700 dark:text-rose-400">
                {(del.error as Error)?.message}
              </p>
            ) : null}
            <DataTable
              loading={q.isLoading}
              rows={all}
              rowKey={(p) => p.id}
              empty={
                <EmptyState
                  title="No projects yet"
                  description="Create one to wire up CI/CD."
                  action={
                    <RequirePermission perm="projects.write" required={['admin', 'owner']} fallback={<span />}>
                      <PrimaryButton onClick={openCreate}>
                        <IconPlus /> New project
                      </PrimaryButton>
                    </RequirePermission>
                  }
                />
              }
              columns={[
                {
                  key: 'name',
                  header: 'Project',
                  cell: (p) => (
                    <div>
                      <div className="font-medium text-content">{p.name}</div>
                      <div className="text-[11px] text-content-muted">{p.description ?? '—'}</div>
                    </div>
                  ),
                },
                {
                  key: 'repo',
                  header: 'Primary repo',
                  cell: (p) => (
                    <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-muted">
                      {p.primaryRepo ?? '—'}
                    </code>
                  ),
                },
                {
                  key: 'teams',
                  header: 'Teams',
                  cell: (p) =>
                    p.teams.length ? (
                      <div className="flex flex-wrap gap-1">
                        {p.teams.map((t) => (
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
                  key: 'envs',
                  header: 'Environments',
                  cell: (p) => (
                    <div className="flex flex-wrap gap-1">
                      {p.environments.map((e) => (
                        <StatusBadge key={e} kind="info">
                          {e.replace(/^env-/, '')}
                        </StatusBadge>
                      ))}
                    </div>
                  ),
                },
                { key: 'created', header: 'Created', cell: (p) => formatRelative(p.createdAt) },
                {
                  key: 'actions',
                  header: '',
                  cell: (p) => (
                    <RequirePermission perm="projects.write" required={['admin', 'owner']} fallback={<span />}>
                      <div className="flex justify-end gap-1.5">
                        <SecondaryButton onClick={() => openEdit(p)}>Edit</SecondaryButton>
                        <SecondaryButton tone="rose" onClick={() => setPendingDelete(p)}>
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

      <ProjectEditor open={editorOpen} initial={editing} onClose={() => setEditorOpen(false)} />
      <ConfirmDeleteModal
        project={pendingDelete}
        pending={del.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return
          del.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) })
        }}
      />
    </ViewShell>
  )
}

/* ─────────────────── editor ─────────────────── */

function ProjectEditor({
  open,
  initial,
  onClose,
}: {
  open: boolean
  initial: WsProject | null
  onClose(): void
}) {
  const create = useCreateProject()
  const update = useUpdateProject()
  const teams = useTeams()

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [description, setDescription] = useState('')
  const [primaryRepo, setPrimaryRepo] = useState('')
  const [selTeams, setSelTeams] = useState<Set<string>>(new Set())
  const [selEnvs, setSelEnvs] = useState<Set<string>>(new Set(['dev', 'staging', 'prod']))

  // Hydrate form state whenever the modal (re)opens for a target.
  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? '')
    setSlug(initial?.slug ?? '')
    setDescription(initial?.description ?? '')
    setPrimaryRepo(initial?.primaryRepo ?? '')
    setSelTeams(new Set(initial?.teams ?? []))
    setSelEnvs(new Set(initial?.environments ?? ['dev', 'staging', 'prod']))
    create.reset()
    update.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial])

  const pending = create.isPending || update.isPending
  const error = (create.error ?? update.error) as Error | null

  const toggle = (set: Set<string>, v: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    setter(next)
  }

  const submit = () => {
    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      primaryRepo: primaryRepo.trim() || undefined,
      teams: [...selTeams],
      environments: [...selEnvs],
    }
    if (initial) update.mutate({ id: initial.id, ...payload }, { onSuccess: onClose })
    else create.mutate({ ...payload, slug: slug.trim() || undefined }, { onSuccess: onClose })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      branded
      width="lg"
      title={initial ? `Edit ${initial.name}` : 'New project'}
      description="Projects wire a Gitea org, Argo project, and Harbor project to the teams that ship them."
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <PrimaryButton disabled={!name.trim() || selEnvs.size === 0 || pending} onClick={submit}>
            {pending ? 'Saving…' : initial ? 'Save changes' : 'Create project'}
          </PrimaryButton>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-content">Name</span>
            <TextField value={name} onChange={setName} placeholder="e.g. Checkout" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-content">
              Slug {initial ? '(fixed)' : '(optional)'}
            </span>
            <TextField mono value={slug} onChange={setSlug} readOnly={!!initial} placeholder="checkout" />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-content">Description</span>
          <TextField value={description} onChange={setDescription} placeholder="What this project delivers" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-content">Primary repo</span>
          <TextField mono value={primaryRepo} onChange={setPrimaryRepo} placeholder="org/checkout" />
        </label>

        <div>
          <span className="mb-1 block text-xs font-medium text-content">Teams</span>
          {teams.data?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {teams.data.map((t) => (
                <ChipToggle
                  key={t.id}
                  on={selTeams.has(t.slug)}
                  onClick={() => toggle(selTeams, t.slug, setSelTeams)}
                >
                  {t.name}
                </ChipToggle>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-content-muted">No teams yet — create one under Teams.</p>
          )}
        </div>

        <div>
          <span className="mb-1 block text-xs font-medium text-content">Environments</span>
          <div className="flex flex-wrap gap-1.5">
            {ENVIRONMENTS.map((e) => (
              <ChipToggle key={e} on={selEnvs.has(e)} onClick={() => toggle(selEnvs, e, setSelEnvs)}>
                {e}
              </ChipToggle>
            ))}
          </div>
        </div>

        {error ? (
          <p className="text-[12px] text-rose-700 dark:text-rose-400">
            {error.message ?? 'Could not save the project.'}
          </p>
        ) : null}
      </div>
    </Modal>
  )
}

function ChipToggle({
  on,
  onClick,
  children,
}: {
  on: boolean
  onClick(): void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        on
          ? 'rounded-lg border border-brand-300 bg-brand-50 px-2.5 py-1 text-[12px] font-medium text-brand-900 dark:border-brand-700 dark:bg-brand-500/15 dark:text-brand-200'
          : 'rounded-lg border border-edge-default bg-surface-raised px-2.5 py-1 text-[12px] text-content-muted hover:bg-surface-sunken'
      }
    >
      {children}
    </button>
  )
}

function ConfirmDeleteModal({
  project,
  pending,
  onCancel,
  onConfirm,
}: {
  project: WsProject | null
  pending: boolean
  onCancel(): void
  onConfirm(): void
}) {
  return (
    <Modal
      open={project !== null}
      onClose={onCancel}
      title="Delete project"
      description="Removes the project record. Backing Git repos and images remain in Gitea / Harbor."
      footer={
        <>
          <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
          <SecondaryButton tone="rose" disabled={pending} onClick={onConfirm}>
            {pending ? 'Deleting…' : 'Delete'}
          </SecondaryButton>
        </>
      }
    >
      {project ? (
        <p className="text-sm text-content">
          Delete <span className="font-medium">{project.name}</span> (
          <code className="font-mono text-[12px]">{project.slug}</code>)?
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
        description="Project management persists to Postgres. Set DATABASE_URL for the console server to enable it — no stubbed data is shown."
      />
    )
  }
  return (
    <EmptyState
      title="Couldn't load projects"
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

export default Projects
