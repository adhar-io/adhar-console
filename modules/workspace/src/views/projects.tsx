import { useQuery } from '@tanstack/react-query'
import { DataTable, EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { CURRENT_ORG_SLUG, wsClient } from '../data/client.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SettingsCard,
  StatTile,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

export function Projects() {
  const q = useQuery({
    queryKey: ['ws', 'projects', CURRENT_ORG_SLUG],
    queryFn: () => wsClient.listProjects(CURRENT_ORG_SLUG),
  })
  const all = q.data ?? []
  return (
    <ViewShell
      title="Projects"
      description="Bundle a primary repo, environments, and the teams that can ship to them."
      required={['admin', 'owner']}
      actions={
        <RequirePermission perm="projects.write" required={['admin', 'owner']} readOnly>
          <PrimaryButton>
            <IconPlus /> New project
          </PrimaryButton>
        </RequirePermission>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Projects" value={all.length} />
        <StatTile
          label="With repo"
          value={all.filter((p) => p.primaryRepo).length}
        />
        <StatTile
          label="Environments"
          value={all.reduce((s, p) => s + (p.environments?.length ?? 0), 0)}
        />
        <StatTile
          label="Teams involved"
          value={new Set(all.flatMap((p) => p.teams)).size}
        />
      </div>

      <SettingsCard title="All projects">
        <DataTable
          loading={q.isLoading}
          rows={all}
          rowKey={(p) => p.id}
          empty={<EmptyState title="No projects yet" description="Create one to wire up CI/CD." />}
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
              cell: (p) => (
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
              cell: () => (
                <div className="flex justify-end gap-1.5">
                  <SecondaryButton>Open</SecondaryButton>
                </div>
              ),
            },
          ]}
        />
      </SettingsCard>
    </ViewShell>
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
