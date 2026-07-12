import { useApprovals, type ApprovalPolicy } from '../data/enterprise.ts'
import { ROLE_LABEL, type Role } from '../data/access.ts'
import {
  SecondaryButton,
  SettingsCard,
  SettingsRow,
  StatTile,
  ToggleField,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

const SCOPE_LABEL: Record<ApprovalPolicy['scope'], string> = {
  'production-deploy': 'Production deploy',
  'budget-increase': 'Budget increase',
  'role-grant-owner': 'Grant Owner role',
  'data-export': 'Data export',
  'destructive-rbac': 'Destructive RBAC change',
  'cluster-delete': 'Delete cluster',
}

export function Approvals() {
  const q = useApprovals()
  const all = q.data ?? []
  const enabled = all.filter((a) => a.enabled).length

  return (
    <ViewShell
      title="Approval policies"
      description="High-blast-radius actions can require multi-person approval. The approver set is enforced server-side; the requester cannot self-approve."
      required={['security', 'owner']}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Policies" value={all.length} />
        <StatTile label="Enabled" value={enabled} tone="good" />
        <StatTile label="Disabled" value={all.length - enabled} tone="warn" />
        <StatTile
          label="Avg approvers"
          value={
            all.length
              ? (all.reduce((s, a) => s + a.approversRequired, 0) / all.length).toFixed(1)
              : '—'
          }
          hint="per policy"
        />
      </div>

      <RequirePermission perm="approvals.write" required={['security', 'owner']} readOnly>
        <div className="space-y-3">
          {all.map((a) => (
            <SettingsCard
              key={a.id}
              title={SCOPE_LABEL[a.scope]}
              description={a.description}
              actions={
                <ToggleField
                  checked={a.enabled}
                  label={a.enabled ? 'Enabled' : 'Disabled'}
                />
              }
            >
              <SettingsRow
                label="Approvers required"
                description="Distinct members who must approve before the action commits."
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-base font-semibold tabular-nums text-content">
                    {a.approversRequired}
                  </span>
                  <span className="text-xs text-content-muted">approvals</span>
                </div>
              </SettingsRow>
              <SettingsRow
                label="Approver roles"
                description="Members holding any of these roles can approve. The requester is excluded automatically."
              >
                <div className="flex flex-wrap gap-1.5">
                  {a.approverRoles.map((r) => (
                    <span
                      key={r}
                      className="rounded-md bg-surface-sunken px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-content-muted ring-1 ring-edge-subtle"
                    >
                      {ROLE_LABEL[r as Role] ?? r}
                    </span>
                  ))}
                </div>
              </SettingsRow>
              <SettingsRow
                label="Action"
                description="Edit the policy or view the trail of past approvals."
              >
                <div className="flex justify-end gap-2">
                  <SecondaryButton>Approval history</SecondaryButton>
                  <SecondaryButton>Edit</SecondaryButton>
                </div>
              </SettingsRow>
            </SettingsCard>
          ))}
        </div>
      </RequirePermission>
    </ViewShell>
  )
}

export default Approvals
