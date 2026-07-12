import { useSecurityPolicy } from '../data/enterprise.ts'
import {
  PrimaryButton,
  SelectField,
  SettingsCard,
  SettingsRow,
  StatTile,
  TextField,
  ToggleField,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

export function SecurityPolicies() {
  const q = useSecurityPolicy()
  const p = q.data

  return (
    <ViewShell
      title="Security policies"
      description="Password rules, signed-deploys policy, customer-managed encryption keys, audit retention. Editing requires Security or Owner."
      required={['security', 'owner']}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Password length" value={p?.passwordMinLength ?? '—'} hint="characters" />
        <StatTile label="Rotation" value={p ? `${p.passwordRotationDays}d` : '—'} hint="every" />
        <StatTile
          label="Signed deploys"
          value={p?.signedDeploysOnly ? 'Required' : 'Optional'}
          tone={p?.signedDeploysOnly ? 'good' : 'warn'}
        />
        <StatTile
          label="Audit retention"
          value={p ? `${p.auditRetentionDays}d` : '—'}
          tone={p && p.auditRetentionDays >= 365 ? 'good' : 'warn'}
        />
      </div>

      <RequirePermission perm="security.write" required={['security', 'owner']} readOnly>
        <SettingsCard
          title="Password & sign-in"
          description="Members on SSO inherit the IdP's policy; these rules apply only to break-glass passwords."
          actions={<PrimaryButton>Save policy</PrimaryButton>}
        >
          <SettingsRow label="Minimum length" description="Recommended: 14+ for break-glass owners.">
            <TextField type="number" value={String(p?.passwordMinLength ?? 14)} />
          </SettingsRow>
          <SettingsRow label="Rotation" description="0 disables forced rotation.">
            <div className="flex items-center gap-2">
              <TextField type="number" value={String(p?.passwordRotationDays ?? 90)} />
              <span className="text-xs text-content-muted">days</span>
            </div>
          </SettingsRow>
          <SettingsRow label="Password history" description="Block reuse of the last N passwords.">
            <TextField type="number" value={String(p?.passwordHistory ?? 6)} />
          </SettingsRow>
        </SettingsCard>

        <SettingsCard title="Supply chain" description="Signed images + attestations gate.">
          <SettingsRow
            label="Signed deploys only"
            description="Reject Argo CD syncs whose image lacks a Cosign signature from an allow-listed key."
          >
            <ToggleField checked={p?.signedDeploysOnly ?? true} label={p?.signedDeploysOnly ? 'On' : 'Off'} />
          </SettingsRow>
          <SettingsRow
            label="Image scanning"
            description="Block deploys that fail Trivy CVE scans of severity above the threshold."
          >
            <SelectField<'low' | 'medium' | 'high' | 'critical' | 'off'>
              value="high"
              options={[
                { value: 'off', label: 'Off' },
                { value: 'critical', label: 'Block on critical' },
                { value: 'high', label: 'Block on high+' },
                { value: 'medium', label: 'Block on medium+' },
                { value: 'low', label: 'Block on low+' },
              ]}
            />
          </SettingsRow>
        </SettingsCard>

        <SettingsCard title="Encryption">
          <SettingsRow
            label="Customer-managed keys"
            description="Encrypt object storage and database snapshots with your own KMS-resident keys."
          >
            <ToggleField checked={p?.cmkEnabled ?? true} label={p?.cmkEnabled ? 'Enabled' : 'Default'} />
          </SettingsRow>
          <SettingsRow label="KMS provider">
            <SelectField<'aws-kms' | 'gcp-kms' | 'azure-kv' | 'vault'>
              value={p?.cmkProvider ?? 'aws-kms'}
              options={[
                { value: 'aws-kms', label: 'AWS KMS' },
                { value: 'gcp-kms', label: 'Google Cloud KMS' },
                { value: 'azure-kv', label: 'Azure Key Vault' },
                { value: 'vault', label: 'HashiCorp Vault' },
              ]}
            />
          </SettingsRow>
        </SettingsCard>

        <SettingsCard title="Data governance">
          <SettingsRow
            label="Audit log retention"
            description="Retention is capped at the plan limit; Enterprise = 7 years."
          >
            <div className="flex items-center gap-2">
              <TextField type="number" value={String(p?.auditRetentionDays ?? 365)} />
              <span className="text-xs text-content-muted">days</span>
            </div>
          </SettingsRow>
          <SettingsRow
            label="Approval for bulk export"
            description="Require Security + Owner approval before exporting audit log or tenant data outside the home region."
          >
            <ToggleField
              checked={p?.dataExportApprovalRequired ?? true}
              label={p?.dataExportApprovalRequired ? 'Required' : 'Optional'}
            />
          </SettingsRow>
        </SettingsCard>
      </RequirePermission>
    </ViewShell>
  )
}

export default SecurityPolicies
