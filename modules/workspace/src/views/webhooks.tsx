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

export function Webhooks() {
  const q = useQuery({
    queryKey: ['ws', 'webhooks', CURRENT_ORG_SLUG],
    queryFn: () => wsClient.listWebhooks(CURRENT_ORG_SLUG),
  })
  const all = q.data ?? []
  const active = all.filter((w) => w.active).length
  const failed = all.filter((w) => w.lastDeliveryStatus && w.lastDeliveryStatus !== 'success').length

  return (
    <ViewShell
      title="Webhooks"
      description="Outbound event delivery to Slack, PagerDuty, or custom endpoints. Every payload is signed with a shared secret (HMAC-SHA256)."
      required={['admin', 'owner']}
      actions={
        <RequirePermission perm="webhooks.write" required={['admin', 'owner']} readOnly>
          <PrimaryButton>
            <IconPlus /> Add webhook
          </PrimaryButton>
        </RequirePermission>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Webhooks" value={all.length} />
        <StatTile label="Active" value={active} tone="good" />
        <StatTile label="Last delivery failed" value={failed} tone={failed ? 'warn' : 'good'} />
        <StatTile label="Signing" value="HMAC-SHA256" />
      </div>

      <SettingsCard title="Endpoints">
        <DataTable
          loading={q.isLoading}
          rows={all}
          rowKey={(w) => w.id}
          empty={<EmptyState title="No webhooks configured" />}
          columns={[
            {
              key: 'url',
              header: 'URL',
              cell: (w) => (
                <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content">
                  {w.url}
                </code>
              ),
            },
            {
              key: 'events',
              header: 'Events',
              cell: (w) => (
                <div className="flex flex-wrap gap-1">
                  {w.events.map((e) => (
                    <code
                      key={e}
                      className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted"
                    >
                      {e}
                    </code>
                  ))}
                </div>
              ),
            },
            {
              key: 'active',
              header: 'State',
              cell: (w) => (
                <StatusBadge kind={w.active ? 'healthy' : 'unknown'}>
                  {w.active ? 'active' : 'disabled'}
                </StatusBadge>
              ),
            },
            {
              key: 'last',
              header: 'Last delivery',
              cell: (w) =>
                w.lastDeliveryAt ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-content-muted">
                      {formatRelative(w.lastDeliveryAt)}
                    </span>
                    <StatusBadge kind={w.lastDeliveryStatus === 'success' ? 'healthy' : 'failed'}>
                      {w.lastDeliveryStatus ?? '—'}
                    </StatusBadge>
                  </div>
                ) : (
                  '—'
                ),
            },
            {
              key: 'actions',
              header: '',
              cell: () => (
                <div className="flex justify-end gap-1.5">
                  <SecondaryButton>Test</SecondaryButton>
                  <SecondaryButton>Edit</SecondaryButton>
                  <SecondaryButton tone="rose">Disable</SecondaryButton>
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

export default Webhooks
