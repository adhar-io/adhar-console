import { useEffect, useState } from 'react'
import { formatRelative } from '@adhar-console/utils'
import {
  useSaveSecurityPolicy,
  useSecurityPolicy,
  type SecurityPolicyDoc,
} from '../data/security.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SelectField,
  SettingsCard,
  SettingsRow,
  StatTile,
  TextField,
  ToggleField,
  ViewShell,
} from '../components/section-shell.tsx'
import { LoadingBlock, StoreErrorBlock } from '../components/async-states.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

export function SecurityPolicies() {
  const q = useSecurityPolicy()

  if (q.isError) {
    return (
      <Shell>
        <StoreErrorBlock error={q.error as Error} onRetry={() => q.refetch()} />
      </Shell>
    )
  }
  if (q.isLoading || !q.data) {
    return (
      <Shell>
        <LoadingBlock label="Loading security policy…" />
      </Shell>
    )
  }

  const { policy, saved, updatedAt } = q.data
  return (
    <Shell>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Password length" value={policy.password.minLength} hint="characters" />
        <StatTile label="Rotation" value={`${policy.password.rotationDays}d`} hint="every" />
        <StatTile
          label="Signed deploys"
          value={policy.supplyChain.signedDeploysOnly ? 'Required' : 'Optional'}
          tone={policy.supplyChain.signedDeploysOnly ? 'good' : 'warn'}
        />
        <StatTile
          label="Policy"
          value={saved ? 'Saved' : 'Defaults'}
          tone={saved ? 'good' : 'default'}
          hint={saved && updatedAt ? `updated ${formatRelative(updatedAt)}` : 'not saved yet'}
        />
      </div>

      {!saved ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          Showing recommended defaults — this tenant has not saved a security policy yet.
        </p>
      ) : null}

      <RequirePermission perm="security.write" required={['security', 'owner']} readOnly>
        <PolicyEditor policy={policy} />
      </RequirePermission>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <ViewShell
      title="Security policies"
      description="Password rules, supply-chain gates, customer-managed keys, and audit retention. Saved to the tenant document store; gates marked as enforced elsewhere say so explicitly."
      required={['security', 'owner']}
    >
      {children}
    </ViewShell>
  )
}

function PolicyEditor({ policy }: { policy: SecurityPolicyDoc }) {
  const save = useSaveSecurityPolicy()
  const [password, setPassword] = useState(policy.password)
  const [supplyChain, setSupplyChain] = useState(policy.supplyChain)
  const [encryption, setEncryption] = useState(policy.encryption)
  const [governance, setGovernance] = useState(policy.governance)

  useEffect(() => {
    setPassword(policy.password)
    setSupplyChain(policy.supplyChain)
    setEncryption(policy.encryption)
    setGovernance(policy.governance)
  }, [policy])

  const dirty =
    JSON.stringify({ password, supplyChain, encryption, governance }) !==
    JSON.stringify({
      password: policy.password,
      supplyChain: policy.supplyChain,
      encryption: policy.encryption,
      governance: policy.governance,
    })

  const submit = () => save.mutate({ password, supplyChain, encryption, governance })

  const saveBar = (
    <div className="flex items-center gap-2">
      <SecondaryButton
        disabled={!dirty || save.isPending}
        onClick={() => {
          setPassword(policy.password)
          setSupplyChain(policy.supplyChain)
          setEncryption(policy.encryption)
          setGovernance(policy.governance)
        }}
      >
        Reset
      </SecondaryButton>
      <PrimaryButton disabled={!dirty || save.isPending} onClick={submit}>
        {save.isPending ? 'Saving…' : 'Save policy'}
      </PrimaryButton>
    </div>
  )

  return (
    <>
      <SettingsCard
        title="Password & sign-in"
        description="Members on SSO inherit the IdP's policy; these rules apply only to break-glass passwords."
        actions={saveBar}
      >
        <SettingsRow label="Minimum length" description="Recommended: 14+ for break-glass owners.">
          <TextField
            type="number"
            value={String(password.minLength)}
            onChange={(v) => setPassword((p) => ({ ...p, minLength: Math.max(8, Number(v) || 0) }))}
          />
        </SettingsRow>
        <SettingsRow label="Rotation" description="0 disables forced rotation.">
          <div className="flex items-center gap-2">
            <TextField
              type="number"
              value={String(password.rotationDays)}
              onChange={(v) => setPassword((p) => ({ ...p, rotationDays: Math.max(0, Number(v) || 0) }))}
            />
            <span className="text-xs text-content-muted">days</span>
          </div>
        </SettingsRow>
        <SettingsRow label="Password history" description="Block reuse of the last N passwords.">
          <TextField
            type="number"
            value={String(password.history)}
            onChange={(v) => setPassword((p) => ({ ...p, history: Math.max(0, Number(v) || 0) }))}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title="Supply chain"
        description="Recorded intent — enforcement happens in the delivery pipeline (Argo CD + Kyverno) once wired to this policy."
      >
        <SettingsRow
          label="Signed deploys only"
          description="Reject Argo CD syncs whose image lacks a Cosign signature from an allow-listed key."
        >
          <ToggleField
            checked={supplyChain.signedDeploysOnly}
            onChange={(v) => setSupplyChain((s) => ({ ...s, signedDeploysOnly: v }))}
            label={supplyChain.signedDeploysOnly ? 'On' : 'Off'}
          />
        </SettingsRow>
        <SettingsRow
          label="Image scanning"
          description="Block deploys that fail Trivy CVE scans of severity above the threshold."
        >
          <SelectField<'off' | 'critical' | 'high' | 'medium' | 'low'>
            value={supplyChain.imageScanSeverity}
            onChange={(v) => setSupplyChain((s) => ({ ...s, imageScanSeverity: v }))}
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
          <ToggleField
            checked={encryption.cmkEnabled}
            onChange={(v) => setEncryption((e) => ({ ...e, cmkEnabled: v }))}
            label={encryption.cmkEnabled ? 'Enabled' : 'Platform default'}
          />
        </SettingsRow>
        <SettingsRow label="KMS provider">
          <SelectField<'aws-kms' | 'gcp-kms' | 'azure-kv' | 'vault'>
            value={encryption.cmkProvider}
            onChange={(v) => setEncryption((e) => ({ ...e, cmkProvider: v }))}
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
            <TextField
              type="number"
              value={String(governance.auditRetentionDays)}
              onChange={(v) =>
                setGovernance((g) => ({ ...g, auditRetentionDays: Math.max(30, Number(v) || 0) }))
              }
            />
            <span className="text-xs text-content-muted">days</span>
          </div>
        </SettingsRow>
        <SettingsRow
          label="Approval for bulk export"
          description="Require Security + Owner approval before exporting audit log or tenant data outside the home region."
        >
          <ToggleField
            checked={governance.dataExportApprovalRequired}
            onChange={(v) => setGovernance((g) => ({ ...g, dataExportApprovalRequired: v }))}
            label={governance.dataExportApprovalRequired ? 'Required' : 'Optional'}
          />
        </SettingsRow>
      </SettingsCard>

      {save.isError ? (
        <p className="text-[12px] text-rose-700 dark:text-rose-400">
          {(save.error as Error)?.message ?? 'Could not save the security policy.'}
        </p>
      ) : null}
    </>
  )
}

export default SecurityPolicies
