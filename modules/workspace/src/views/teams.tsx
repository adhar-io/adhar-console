import { useQuery } from '@tanstack/react-query'
import { DataTable, EmptyState } from '@adhar-console/shell-ui'
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

export function Teams() {
  const q = useQuery({
    queryKey: ['ws', 'teams', CURRENT_ORG_SLUG],
    queryFn: () => wsClient.listTeams(CURRENT_ORG_SLUG),
  })
  const all = q.data ?? []
  return (
    <ViewShell
      title="Teams"
      description="Use teams to grant project-scoped access to groups of members. Team membership can be synced from your IdP via SCIM."
      required={['admin', 'owner']}
      actions={
        <RequirePermission perm="teams.write" required={['admin', 'owner']} readOnly>
          <PrimaryButton>
            <IconPlus /> New team
          </PrimaryButton>
        </RequirePermission>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Teams" value={all.length} />
        <StatTile label="Members covered" value={all.reduce((s, t) => s + t.memberCount, 0)} />
        <StatTile label="Projects covered" value={all.reduce((s, t) => s + t.projectCount, 0)} />
        <StatTile
          label="Avg size"
          value={all.length ? (all.reduce((s, t) => s + t.memberCount, 0) / all.length).toFixed(1) : '—'}
          hint="members / team"
        />
      </div>

      <SettingsCard title="All teams">
        <DataTable
          loading={q.isLoading}
          rows={all}
          rowKey={(t) => t.id}
          empty={<EmptyState title="No teams yet" />}
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
            { key: 'members', header: 'Members', numeric: true, cell: (t) => t.memberCount },
            { key: 'projects', header: 'Projects', numeric: true, cell: (t) => t.projectCount },
            { key: 'created', header: 'Created', cell: (t) => formatRelative(t.createdAt) },
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

export default Teams
