import { useQuery } from '@tanstack/react-query'
import { StatusBadge, type StatusKind } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { CURRENT_ORG_SLUG, wsClient } from '../data/client.ts'
import {
  SecondaryButton,
  SettingsCard,
  StatTile,
  ViewShell,
} from '../components/section-shell.tsx'

const STATUS_KIND: Record<string, StatusKind> = {
  connected: 'healthy',
  degraded: 'degraded',
  disconnected: 'failed',
  pending: 'progressing',
}

export function Integrations() {
  const q = useQuery({
    queryKey: ['ws', 'integrations', CURRENT_ORG_SLUG],
    queryFn: () => wsClient.listIntegrations(CURRENT_ORG_SLUG),
  })
  const all = q.data ?? []
  const healthy = all.filter((i) => i.status === 'connected').length
  const degraded = all.filter((i) => i.status === 'degraded' || i.status === 'disconnected').length

  return (
    <ViewShell
      title="Integrations"
      description="Every connection between Adhar Console and a backing open-source tool. Status reflects real health probes — every entry links back to its source repo."
      required={['admin', 'owner']}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Configured" value={all.length} />
        <StatTile label="Healthy" value={healthy} tone="good" />
        <StatTile label="Attention" value={degraded} tone={degraded ? 'warn' : 'good'} />
        <StatTile label="Self-hosted" value={all.filter((i) => i.mode === 'self-hosted').length} />
      </div>

      <SettingsCard title="Connections">
        {q.isLoading ? (
          <div className="text-sm text-content-muted">Loading…</div>
        ) : all.length === 0 ? (
          <div className="text-sm text-content-muted">No integrations configured.</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {all.map((i) => (
              <div
                key={i.id}
                className="rounded-xl border border-edge-default bg-white p-4 shadow-sm transition-colors hover:border-brand-300"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold capitalize text-content">{i.tool}</div>
                    <code className="mt-0.5 block truncate font-mono text-[11px] text-content-muted">
                      {i.url}
                    </code>
                  </div>
                  <StatusBadge kind={STATUS_KIND[i.status] ?? 'unknown'}>{i.status}</StatusBadge>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                  <KV label="Mode" value={i.mode} />
                  <KV label="Version" value={i.version ?? '—'} />
                  <KV label="Connected" value={formatRelative(i.connectedAt)} />
                </div>
                <div className="mt-3 flex items-center justify-end gap-1.5">
                  <SecondaryButton>Test</SecondaryButton>
                  <SecondaryButton>Configure</SecondaryButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>
    </ViewShell>
  )
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-surface-sunken px-2 py-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
      <div className="mt-0.5 text-[12px] font-medium text-content">{value}</div>
    </div>
  )
}

export default Integrations
