import { useState } from 'react'
import { EmptyState, StatusBadge, useToast } from '@adhar-console/shell-ui'
import {
  isDbUnavailable,
  useMembers,
  useOrg,
  useUpdateOrg,
  useWorkspaceMe,
  type OrgPatch,
} from '../data/client.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SettingsCard,
  SettingsRow,
  StatTile,
  TextField,
  ToggleField,
  ViewActions,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

export function Organization() {
  const q = useOrg()
  const me = useWorkspaceMe()
  const members = useMembers()
  const save = useUpdateOrg()
  const toast = useToast()
  const [dirty, setDirty] = useState<OrgPatch>({})

  const o = q.data
  const isDirty = Object.keys(dirty).length > 0
  const ssoEnforced = dirty.ssoEnforced ?? o?.ssoEnforced ?? false

  const headerActions = (
    <ViewActions>
      <RequirePermission perm="org.write" required={['admin', 'owner']} readOnly>
        <SecondaryButton onClick={() => setDirty({})} disabled={!isDirty}>
          Reset
        </SecondaryButton>
        <PrimaryButton form="org-settings-form" type="submit" disabled={!isDirty || save.isPending || q.isLoading}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </PrimaryButton>
      </RequirePermission>
    </ViewActions>
  )

  return (
    <ViewShell
      title="General"
      description="Organization identity, region, and SSO posture. Changes persist to the console database and are audit-logged."
      required={['admin', 'owner']}
    >
      {headerActions}
      {q.isError ? (
        <StoreErrorState error={q.error} retry={() => q.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Region" value={o?.region ?? '…'} hint="data residency" />
            <StatTile
              label="SSO"
              value={o ? (o.ssoEnforced ? 'Enforced' : 'Optional') : '…'}
              tone={o?.ssoEnforced ? 'good' : 'warn'}
            />
            <StatTile
              label="Members"
              value={members.data?.length ?? '…'}
              hint="with workspace access"
            />
            <StatTile
              label="RBAC sync"
              value={me.data ? (me.data.keycloakConfigured ? 'Keycloak' : 'Console-only') : '…'}
              tone={me.data?.keycloakConfigured ? 'good' : 'warn'}
              hint={me.data?.keycloakConfigured ? 'groups reflected' : 'no admin credential'}
            />
          </div>

          <RequirePermission perm="org.write" required={['admin', 'owner']} readOnly>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (!o || !isDirty) return
                save.mutate(dirty, {
                  onSuccess: () => {
                    setDirty({})
                    toast.success('Organization settings saved')
                  },
                  onError: (e) => toast.error('Could not save the organization', { description: (e as Error)?.message }),
                })
              }}
              id="org-settings-form"
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
                  description="Derived from the tenant. Used in URLs and the SSO realm."
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
                    placeholder="example.com"
                  />
                </SettingsRow>
              </SettingsCard>

              <SettingsCard
                title="Region & residency"
                description="Tenant data is stored only in the home region. Cross-border replication requires an approved export."
              >
                <SettingsRow label="Home region">
                  <TextField mono readOnly value={o?.region ?? ''} />
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
                    checked={ssoEnforced}
                    onChange={(v) => setDirty((d) => ({ ...d, ssoEnforced: v }))}
                    label={ssoEnforced ? 'Enforced' : 'Optional'}
                  />
                </SettingsRow>
              </SettingsCard>
            </form>
          </RequirePermission>
        </>
      )}
    </ViewShell>
  )
}

/** DB-unavailable / fetch-error state — no fake data, ever. */
function StoreErrorState({ error, retry }: { error: unknown; retry(): void }) {
  if (isDbUnavailable(error)) {
    return (
      <EmptyState
        title="Connect a database"
        description="Organization management persists to Postgres. Set DATABASE_URL for the console server to enable it — no stubbed data is shown."
      />
    )
  }
  return (
    <EmptyState
      title="Couldn't load the organization"
      description={(error as Error)?.message ?? 'Unexpected error.'}
      action={<SecondaryButton onClick={retry}>Retry</SecondaryButton>}
    />
  )
}

export default Organization
