import { useState } from 'react'
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

export function Tokens() {
  const q = useQuery({
    queryKey: ['ws', 'tokens', CURRENT_ORG_SLUG],
    queryFn: () => wsClient.listApiTokens(CURRENT_ORG_SLUG),
  })
  const [justCreated, setJustCreated] = useState<string | null>(null)

  const all = q.data ?? []
  const expiring = all.filter(
    (t) => t.expiresAt && new Date(t.expiresAt).getTime() - Date.now() < 14 * 24 * 3600_000,
  ).length

  return (
    <ViewShell
      title="API tokens"
      description="Org-scoped tokens for CI runners, CLIs, and service-to-service calls. Tokens are only shown once — copy them immediately."
      required={['admin', 'owner']}
      actions={
        <RequirePermission perm="tokens.write" required={['admin', 'owner']} readOnly>
          <PrimaryButton
            onClick={async () => {
              const r = await wsClient.createApiToken(CURRENT_ORG_SLUG, {
                name: `token-${Date.now().toString(36).slice(-5)}`,
                scopes: ['projects:read', 'deployments:write'],
              })
              setJustCreated(r.token)
              q.refetch()
            }}
          >
            <IconPlus /> New token
          </PrimaryButton>
        </RequirePermission>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Tokens" value={all.length} />
        <StatTile label="Expiring soon" value={expiring} tone={expiring ? 'warn' : 'good'} hint="next 14d" />
        <StatTile label="Never expires" value={all.filter((t) => !t.expiresAt).length} hint="recommend rotation" />
        <StatTile
          label="Used (24h)"
          value={
            all.filter(
              (t) => t.lastUsedAt && Date.now() - new Date(t.lastUsedAt).getTime() < 24 * 3600_000,
            ).length
          }
        />
      </div>

      {justCreated ? (
        <SettingsCard
          title="New token created"
          description="Copy this token now — it will never be shown again."
        >
          <div className="flex flex-wrap items-center gap-2">
            <code className="flex-1 truncate rounded-md border border-emerald-200 bg-emerald-50/60 px-3 py-2 font-mono text-[12px] text-emerald-900">
              {justCreated}
            </code>
            <SecondaryButton onClick={() => navigator.clipboard?.writeText(justCreated)}>
              Copy
            </SecondaryButton>
            <SecondaryButton onClick={() => setJustCreated(null)}>Dismiss</SecondaryButton>
          </div>
        </SettingsCard>
      ) : null}

      <SettingsCard title="Tokens">
        <DataTable
          loading={q.isLoading}
          rows={all}
          rowKey={(t) => t.id}
          empty={<EmptyState title="No API tokens" description="Generate one above to let CI runners or CLIs call the Adhar API." />}
          columns={[
            { key: 'name', header: 'Name', cell: (t) => <span className="font-medium text-content">{t.name}</span> },
            {
              key: 'prefix',
              header: 'Prefix',
              cell: (t) => (
                <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-muted">
                  {t.prefix}•••
                </code>
              ),
            },
            {
              key: 'scopes',
              header: 'Scopes',
              cell: (t) => (
                <div className="flex flex-wrap gap-1">
                  {t.scopes.map((s) => (
                    <code
                      key={s}
                      className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted"
                    >
                      {s}
                    </code>
                  ))}
                </div>
              ),
            },
            {
              key: 'lastUsed',
              header: 'Last used',
              cell: (t) => (t.lastUsedAt ? formatRelative(t.lastUsedAt) : 'never'),
            },
            {
              key: 'expires',
              header: 'Expires',
              cell: (t) => (t.expiresAt ? formatRelative(t.expiresAt) : 'never'),
            },
            {
              key: 'actions',
              header: '',
              cell: () => (
                <div className="flex justify-end">
                  <SecondaryButton tone="rose">Revoke</SecondaryButton>
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

export default Tokens
