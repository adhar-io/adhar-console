import { DataTable, EmptyState, StatusBadge, type StatusKind } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import {
  useScimConnections,
  useSsoConnections,
  type SsoConnection,
} from '../data/enterprise.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SettingsCard,
  SettingsRow,
  StatTile,
  ToggleField,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

const SSO_KIND: Record<SsoConnection['status'], StatusKind> = {
  configured: 'healthy',
  pending: 'progressing',
  disabled: 'paused',
}

export function Sso() {
  const sso = useSsoConnections()
  const scim = useScimConnections()
  const total = sso.data?.length ?? 0
  const enforced = sso.data?.filter((c) => c.enforced).length ?? 0
  const provisioned = sso.data?.reduce((s, c) => s + c.memberCount, 0) ?? 0

  return (
    <ViewShell
      title="Single sign-on"
      description="Federate authentication via OIDC or SAML. Per-domain connections support enforced sign-in, JIT provisioning, and SCIM-based lifecycle."
      required={['security', 'owner']}
      actions={
        <RequirePermission perm="sso.write" required={['security', 'owner']} readOnly>
          <PrimaryButton onClick={() => alert('Connect identity provider — wizard coming soon.')}>
            <IconPlus /> Connect provider
          </PrimaryButton>
        </RequirePermission>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Connections" value={total} hint={`${enforced} enforced`} />
        <StatTile label="Provisioned" value={provisioned} hint="Active members via SSO" />
        <StatTile
          label="SCIM"
          value={(scim.data ?? []).filter((c) => c.status === 'active').length}
          hint="Live sync sources"
          tone="good"
        />
        <StatTile label="Last sign-in" value={lastSignIn(sso.data) ?? '—'} hint="any provider" />
      </div>

      <SettingsCard
        title="Identity providers"
        description="Each provider maps a verified email domain to a Keycloak realm broker."
      >
        <DataTable
          loading={sso.isLoading}
          rows={sso.data ?? []}
          rowKey={(c) => c.id}
          empty={<EmptyState title="No identity providers connected" />}
          columns={[
            {
              key: 'name',
              header: 'Provider',
              cell: (c) => (
                <div>
                  <div className="font-medium text-content">{c.name}</div>
                  <div className="text-xs text-content-muted">domain {c.domain}</div>
                </div>
              ),
            },
            {
              key: 'protocol',
              header: 'Protocol',
              cell: (c) => (
                <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] uppercase">
                  {c.protocol}
                </code>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (c) => <StatusBadge kind={SSO_KIND[c.status]}>{c.status}</StatusBadge>,
            },
            {
              key: 'enforced',
              header: 'Enforced',
              cell: (c) =>
                c.enforced ? (
                  <StatusBadge kind="healthy">on</StatusBadge>
                ) : (
                  <StatusBadge kind="unknown">off</StatusBadge>
                ),
            },
            { key: 'jit', header: 'JIT', cell: (c) => (c.jit ? 'yes' : 'no') },
            { key: 'members', header: 'Members', cell: (c) => c.memberCount },
            {
              key: 'last',
              header: 'Last used',
              cell: (c) => (c.lastUsedAt ? formatRelative(c.lastUsedAt) : '—'),
            },
          ]}
        />
      </SettingsCard>

      <SettingsCard title="Default provider behavior">
        <SettingsRow
          label="Enforce SSO for verified domains"
          description="Members signing in from a connected domain must use the IdP. Password fallback disabled except for break-glass owners."
        >
          <ToggleField
            checked
            label="Enforced"
            description="Currently applied to acme.com"
          />
        </SettingsRow>
        <SettingsRow
          label="Just-in-time provisioning"
          description="Create members on first sign-in using IdP attributes (email, name, group → role)."
        >
          <ToggleField checked label="Enabled" description="Group-to-role mapping configured" />
        </SettingsRow>
        <SettingsRow
          label="Break-glass owners"
          description="Two named owners may bypass SSO with FIDO2 + recovery codes during incidents."
        >
          <SecondaryButton>Manage break-glass</SecondaryButton>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title="SCIM provisioning"
        description="Lifecycle (create / update / deprovision) driven by your IdP. Supports Okta, Entra, JumpCloud, Google."
      >
        <DataTable
          loading={scim.isLoading}
          rows={scim.data ?? []}
          rowKey={(c) => c.id}
          empty={<EmptyState title="SCIM not configured" />}
          columns={[
            {
              key: 'provider',
              header: 'Provider',
              cell: (c) => <span className="font-medium capitalize">{c.provider}</span>,
            },
            {
              key: 'status',
              header: 'Status',
              cell: (c) => (
                <StatusBadge
                  kind={c.status === 'active' ? 'healthy' : c.status === 'paused' ? 'paused' : 'failed'}
                >
                  {c.status}
                </StatusBadge>
              ),
            },
            { key: 'users', header: 'Users', cell: (c) => c.syncedUsers, numeric: true },
            { key: 'groups', header: 'Groups', cell: (c) => c.syncedGroups, numeric: true },
            {
              key: 'token',
              header: 'Token rotated',
              cell: (c) => formatRelative(c.tokenLastRotatedAt),
            },
            {
              key: 'sync',
              header: 'Last sync',
              cell: (c) => (c.syncedAt ? formatRelative(c.syncedAt) : '—'),
            },
          ]}
        />
      </SettingsCard>
    </ViewShell>
  )
}

function lastSignIn(rows?: SsoConnection[]): string | undefined {
  if (!rows) return undefined
  const ts = rows.flatMap((r) => (r.lastUsedAt ? [new Date(r.lastUsedAt).getTime()] : []))
  if (!ts.length) return undefined
  return formatRelative(new Date(Math.max(...ts)).toISOString())
}

function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

export default Sso
