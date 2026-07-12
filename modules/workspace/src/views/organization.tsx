import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { StatusBadge } from '@adhar-console/shell-ui'
import { CURRENT_ORG_SLUG, wsClient } from '../data/client.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SettingsCard,
  SettingsRow,
  StatTile,
  TextField,
  ToggleField,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

export function Organization() {
  const q = useQuery({
    queryKey: ['workspace', 'org', CURRENT_ORG_SLUG],
    queryFn: () => wsClient.getOrganization(CURRENT_ORG_SLUG),
  })
  const [dirty, setDirty] = useState<Record<string, string>>({})

  const o = q.data
  const ssoState = o?.ssoEnforced ? 'Enforced' : 'Optional'

  return (
    <ViewShell
      title="General"
      description="Organization identity, region, and SSO posture. Slug changes break existing deep links — coordinate with platform-admins before renaming."
      required={['admin', 'owner']}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Region" value={o?.region ?? '—'} hint="data residency" />
        <StatTile label="SSO" value={ssoState} tone={o?.ssoEnforced ? 'good' : 'warn'} />
        <StatTile label="Members" value="142" hint="provisioned" />
        <StatTile label="Tier" value="Business" hint="see Plan" />
      </div>

      <RequirePermission perm="org.write" required={['admin', 'owner']} readOnly>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!o) return
            wsClient.updateOrganization(o.slug, dirty).then(() => q.refetch())
            setDirty({})
          }}
          className="space-y-6"
        >
          <SettingsCard title="Identity">
            <SettingsRow label="Name" description="Shown in the topbar, invites, and emails.">
              <TextField
                value={dirty.name ?? o?.name ?? ''}
                onChange={(v) => setDirty((d) => ({ ...d, name: v }))}
              />
            </SettingsRow>
            <SettingsRow
              label="Slug"
              description="Used in URLs and SSO realm. Renaming breaks existing deep links."
              hint={`adhar.io/${o?.slug ?? 'workspace'}`}
            >
              <TextField mono readOnly value={o?.slug ?? ''} />
            </SettingsRow>
            <SettingsRow label="Description">
              <TextField
                value={dirty.description ?? o?.description ?? ''}
                onChange={(v) => setDirty((d) => ({ ...d, description: v }))}
              />
            </SettingsRow>
            <SettingsRow
              label="Primary domain"
              description="Used for SSO-assisted auto-join and email verification."
            >
              <TextField
                value={dirty.domain ?? o?.domain ?? ''}
                onChange={(v) => setDirty((d) => ({ ...d, domain: v }))}
                placeholder="acme.com"
              />
            </SettingsRow>
          </SettingsCard>

          <SettingsCard
            title="Region & residency"
            description="Tenant data is stored only in the home region. Cross-border replication requires an approved export."
          >
            <SettingsRow label="Home region">
              <TextField mono readOnly value={o?.region ?? '—'} />
            </SettingsRow>
            <SettingsRow
              label="Encryption at rest"
              description="AES-256 via the cluster's CSI snapshotter + SSE-enabled object storage."
            >
              <StatusBadge kind="healthy">AES-256</StatusBadge>
            </SettingsRow>
            <SettingsRow
              label="Encryption in transit"
              description="mTLS via cert-manager between every internal hop."
            >
              <StatusBadge kind="healthy">mTLS</StatusBadge>
            </SettingsRow>
          </SettingsCard>

          <SettingsCard
            title="Single sign-on"
            description={`Members authenticate via the Keycloak realm "${o?.slug ?? '—'}". See Identity & access → SSO for connections.`}
          >
            <SettingsRow
              label="Enforce SSO"
              description="Members signing in from a verified domain must use the IdP."
            >
              <ToggleField
                checked={o?.ssoEnforced ?? false}
                label={o?.ssoEnforced ? 'Enforced' : 'Optional'}
              />
            </SettingsRow>
          </SettingsCard>

          <div className="flex justify-end gap-2">
            <SecondaryButton onClick={() => setDirty({})} disabled={!Object.keys(dirty).length}>
              Reset
            </SecondaryButton>
            <PrimaryButton type="submit" disabled={!Object.keys(dirty).length}>
              Save changes
            </PrimaryButton>
          </div>
        </form>
      </RequirePermission>
    </ViewShell>
  )
}

export default Organization
