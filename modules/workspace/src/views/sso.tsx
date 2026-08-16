import { useEffect, useState } from 'react'
import { DataTable, EmptyState, Modal, StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import {
  testOidcDiscovery,
  useDeleteSsoConnection,
  useSaveSsoConnection,
  useSsoConnections,
  type ReachabilityResult,
  type SsoConnection,
  type SsoProtocol,
} from '../data/security.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SelectField,
  SettingsCard,
  StatTile,
  TextField,
  ToggleField,
  ViewShell,
} from '../components/section-shell.tsx'
import { LoadingBlock, StoreErrorBlock } from '../components/async-states.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

export function Sso() {
  const sso = useSsoConnections()
  const del = useDeleteSsoConnection()
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<SsoConnection | null>(null)

  const all = sso.data ?? []
  const enabled = all.filter((c) => c.enabled).length
  const enforced = all.filter((c) => c.enforced).length

  const openCreate = () => {
    setEditing(null)
    setEditorOpen(true)
  }
  const openEdit = (c: SsoConnection) => {
    setEditing(c)
    setEditorOpen(true)
  }

  return (
    <ViewShell
      title="Single sign-on"
      description="Federate authentication via OIDC or SAML. Connections saved here are tenant-shared configuration; activation happens in Keycloak (identity providers), and the status column says exactly which state each record is in."
      required={['security', 'owner']}
      actions={
        <RequirePermission perm="sso.write" required={['security', 'owner']} readOnly>
          <PrimaryButton onClick={openCreate}>
            <IconPlus /> Add provider config
          </PrimaryButton>
        </RequirePermission>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Configs" value={all.length} hint="saved in this workspace" />
        <StatTile label="Enabled" value={enabled} hint="intent — applied via Keycloak" />
        <StatTile label="Enforced domains" value={enforced} hint="sign-in forced through IdP" />
        <StatTile
          label="Synced to Keycloak"
          value={all.filter((c) => c.keycloakSynced).length}
          hint="verified broker exists"
        />
      </div>

      {sso.isError ? (
        <StoreErrorBlock error={sso.error as Error} onRetry={() => sso.refetch()} />
      ) : sso.isLoading ? (
        <LoadingBlock label="Loading SSO configuration…" />
      ) : (
        <SettingsCard
          title="Identity providers"
          description="Each connection maps a verified email domain to an IdP. Saving records the config here; a Keycloak admin must create the matching identity-provider broker for it to go live."
        >
          <DataTable
            rows={all}
            rowKey={(c) => c.id}
            empty={
              <EmptyState
                title="No identity providers configured"
                description="Add an OIDC or SAML provider config to get started. Nothing is pre-provisioned."
              />
            }
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
                cell: (c) =>
                  !c.enabled ? (
                    <StatusBadge kind="unknown">disabled</StatusBadge>
                  ) : c.keycloakSynced ? (
                    <StatusBadge kind="healthy">synced to Keycloak</StatusBadge>
                  ) : (
                    <StatusBadge kind="paused">saved — apply in Keycloak</StatusBadge>
                  ),
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
              {
                key: 'updated',
                header: 'Updated',
                cell: (c) => formatRelative(c.updatedAt),
              },
              {
                key: 'actions',
                header: '',
                cell: (c) => (
                  <RequirePermission perm="sso.write" required={['security', 'owner']} readOnly>
                    <div className="flex justify-end gap-1.5">
                      <SecondaryButton onClick={() => openEdit(c)}>Edit</SecondaryButton>
                      <SecondaryButton
                        tone="rose"
                        disabled={del.isPending && del.variables === c.id}
                        onClick={() => del.mutate(c.id)}
                      >
                        Delete
                      </SecondaryButton>
                    </div>
                  </RequirePermission>
                ),
              },
            ]}
          />
        </SettingsCard>
      )}

      <SettingsCard
        title="SCIM provisioning"
        description="Lifecycle sync (create / update / deprovision) driven by your IdP."
      >
        <EmptyState
          compact
          title="SCIM is not connected"
          description="The console does not proxy a SCIM endpoint yet, so no sync status can be shown. When SCIM ships, live user/group counts will appear here — they are never simulated."
        />
      </SettingsCard>

      <SsoEditor open={editorOpen} initial={editing} onClose={() => setEditorOpen(false)} />
    </ViewShell>
  )
}

/* ─────────────────── Editor modal ─────────────────── */

function SsoEditor({
  open,
  initial,
  onClose,
}: {
  open: boolean
  initial: SsoConnection | null
  onClose(): void
}) {
  const save = useSaveSsoConnection()
  const [name, setName] = useState('')
  const [protocol, setProtocol] = useState<SsoProtocol>('oidc')
  const [domain, setDomain] = useState('')
  const [entityId, setEntityId] = useState('')
  const [metadataUrl, setMetadataUrl] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [enforced, setEnforced] = useState(false)
  const [jit, setJit] = useState(true)
  const [testResult, setTestResult] = useState<ReachabilityResult | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? '')
    setProtocol(initial?.protocol ?? 'oidc')
    setDomain(initial?.domain ?? '')
    setEntityId(initial?.entityId ?? '')
    setMetadataUrl(initial?.metadataUrl ?? '')
    setEnabled(initial?.enabled ?? true)
    setEnforced(initial?.enforced ?? false)
    setJit(initial?.jit ?? true)
    setTestResult(null)
    save.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial])

  const canTest = protocol === 'oidc' && /^https:\/\/.+/.test(metadataUrl.trim())
  const canSave = name.trim() && domain.trim() && entityId.trim() && !save.isPending

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await testOidcDiscovery(metadataUrl.trim()))
    } finally {
      setTesting(false)
    }
  }

  const submit = () =>
    save.mutate(
      {
        id: initial?.id,
        input: {
          name: name.trim(),
          protocol,
          domain: domain.trim(),
          entityId: entityId.trim(),
          metadataUrl: metadataUrl.trim() || undefined,
          enabled,
          enforced,
          jit,
        },
      },
      { onSuccess: onClose },
    )

  return (
    <Modal
      open={open}
      onClose={onClose}
      branded
      width="lg"
      title={initial ? 'Edit provider config' : 'Add provider config'}
      description="Saved to the tenant document store. Apply the matching identity-provider broker in Keycloak to activate it."
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <PrimaryButton disabled={!canSave} onClick={submit}>
            {save.isPending ? 'Saving…' : initial ? 'Save changes' : 'Save config'}
          </PrimaryButton>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-content">Display name</span>
            <TextField value={name} onChange={setName} placeholder="Okta (corporate)" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-content">Protocol</span>
            <SelectField<SsoProtocol>
              value={protocol}
              onChange={setProtocol}
              options={[
                { value: 'oidc', label: 'OIDC' },
                { value: 'saml', label: 'SAML 2.0' },
              ]}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-content">Email domain</span>
            <TextField mono value={domain} onChange={setDomain} placeholder="acme.com" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-content">
              {protocol === 'oidc' ? 'Issuer' : 'Entity ID'}
            </span>
            <TextField
              mono
              value={entityId}
              onChange={setEntityId}
              placeholder={protocol === 'oidc' ? 'https://acme.okta.com' : 'urn:acme:console:saml'}
            />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-content">
            {protocol === 'oidc' ? 'Discovery URL' : 'Federation metadata URL'}{' '}
            <span className="text-content-subtle">(optional)</span>
          </span>
          <TextField
            mono
            type="url"
            value={metadataUrl}
            onChange={setMetadataUrl}
            placeholder={
              protocol === 'oidc'
                ? 'https://acme.okta.com/.well-known/openid-configuration'
                : 'https://login.microsoftonline.com/…/federationmetadata.xml'
            }
          />
          {protocol === 'oidc' ? (
            <span className="mt-1.5 flex items-center gap-2">
              <SecondaryButton disabled={!canTest || testing} onClick={runTest}>
                {testing ? 'Testing…' : 'Test discovery URL'}
              </SecondaryButton>
              <span className="text-[11px] text-content-subtle">
                Performs a real fetch from this browser.
              </span>
            </span>
          ) : null}
          {testResult ? (
            <span className="mt-2 flex items-center gap-2 text-[12px]">
              <StatusBadge kind={testResult.ok ? 'healthy' : 'failed'}>
                {testResult.ok ? 'reachable' : 'failed'}
              </StatusBadge>
              <span className="text-content-muted">{testResult.detail}</span>
            </span>
          ) : null}
        </label>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <ToggleField
            checked={enabled}
            onChange={setEnabled}
            label="Enabled"
            description="Intent — takes effect once applied in Keycloak."
          />
          <ToggleField
            checked={enforced}
            onChange={setEnforced}
            label="Enforce for domain"
            description="Members must use this IdP."
          />
          <ToggleField
            checked={jit}
            onChange={setJit}
            label="JIT provisioning"
            description="Create members on first sign-in."
          />
        </div>

        {save.isError ? (
          <p className="text-[12px] text-rose-700 dark:text-rose-400">
            {(save.error as Error)?.message ?? 'Could not save the SSO configuration.'}
          </p>
        ) : null}
      </div>
    </Modal>
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

export default Sso
