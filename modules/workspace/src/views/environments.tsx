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

export function Environments() {
  const q = useQuery({
    queryKey: ['ws', 'environments', CURRENT_ORG_SLUG, 'adhar-console'],
    queryFn: () => wsClient.listEnvironments(CURRENT_ORG_SLUG, 'adhar-console'),
  })
  const all = q.data ?? []
  return (
    <ViewShell
      title="Environments"
      description="Deployment targets per project. Promotion rules and protected change windows live here."
      required={['admin', 'owner']}
      actions={
        <RequirePermission perm="environments.write" required={['admin', 'owner']} readOnly>
          <PrimaryButton>
            <IconPlus /> New environment
          </PrimaryButton>
        </RequirePermission>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Total" value={all.length} />
        <StatTile label="Production" value={all.filter((e) => e.kind === 'prod').length} tone="warn" />
        <StatTile
          label="Approval required"
          value={all.filter((e) => e.protectionRules.requireApproval).length}
          tone="good"
        />
        <StatTile label="Clusters" value={new Set(all.map((e) => e.clusterRef)).size} />
      </div>

      <SettingsCard title="All environments">
        <DataTable
          loading={q.isLoading}
          rows={all}
          rowKey={(e) => e.id}
          empty={<EmptyState title="No environments configured" />}
          columns={[
            {
              key: 'name',
              header: 'Environment',
              cell: (e) => (
                <div>
                  <div className="font-medium text-content">{e.name}</div>
                  <code className="font-mono text-[11px] text-content-muted">{e.namespace}</code>
                </div>
              ),
            },
            {
              key: 'kind',
              header: 'Kind',
              cell: (e) => (
                <StatusBadge
                  kind={e.kind === 'prod' ? 'failed' : e.kind === 'staging' ? 'progressing' : 'info'}
                >
                  {e.kind}
                </StatusBadge>
              ),
            },
            {
              key: 'cluster',
              header: 'Cluster',
              cell: (e) => (
                <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px]">
                  {e.clusterRef}
                </code>
              ),
            },
            {
              key: 'promote',
              header: 'Promote from',
              cell: (e) => (e.promoteFromEnvId ? e.promoteFromEnvId.replace(/^env-/, '') : '—'),
            },
            {
              key: 'rules',
              header: 'Protection',
              cell: (e) =>
                e.protectionRules.requireApproval ? (
                  <div className="text-[11px]">
                    <StatusBadge kind="progressing">Approval required</StatusBadge>
                    <div className="mt-1 text-content-muted">
                      {e.protectionRules.approvers.join(', ')}
                    </div>
                    {e.protectionRules.windowsCron ? (
                      <div className="mt-0.5 text-content-subtle">
                        Window <code>{e.protectionRules.windowsCron}</code>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <StatusBadge kind="info">Open</StatusBadge>
                ),
            },
            { key: 'created', header: 'Created', cell: (e) => formatRelative(e.createdAt) },
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

export default Environments
