import { useState } from 'react'
import { cn } from '@adhar-console/utils'
import {
  ALL_ROLES,
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '../data/access.ts'
import {
  SecondaryButton,
  SettingsCard,
  StatTile,
  ViewShell,
} from '../components/section-shell.tsx'
import { RoleBadge } from '../components/role-gate.tsx'

interface PermGroup {
  label: string
  perms: { id: Permission; label: string }[]
}

const PERM_GROUPS: PermGroup[] = [
  {
    label: 'Organization',
    perms: [
      { id: 'org.read', label: 'View organization' },
      { id: 'org.write', label: 'Edit organization' },
      { id: 'org.transfer', label: 'Transfer ownership' },
      { id: 'org.delete', label: 'Delete organization' },
    ],
  },
  {
    label: 'Members & roles',
    perms: [
      { id: 'members.read', label: 'View members' },
      { id: 'members.invite', label: 'Invite members' },
      { id: 'members.update_role', label: 'Change member role' },
      { id: 'members.remove', label: 'Remove members' },
      { id: 'roles.read', label: 'View roles' },
      { id: 'roles.write', label: 'Edit custom roles' },
      { id: 'teams.read', label: 'View teams' },
      { id: 'teams.write', label: 'Edit teams' },
    ],
  },
  {
    label: 'Identity & access',
    perms: [
      { id: 'sso.write', label: 'Manage SSO' },
      { id: 'scim.write', label: 'Manage SCIM' },
      { id: 'mfa.enforce', label: 'Enforce MFA' },
      { id: 'session.write', label: 'Edit session policy' },
      { id: 'ipallow.write', label: 'Edit IP allowlist' },
    ],
  },
  {
    label: 'Security & compliance',
    perms: [
      { id: 'security.write', label: 'Edit security policies' },
      { id: 'audit.read', label: 'Read audit log' },
      { id: 'audit.export', label: 'Export audit log' },
      { id: 'compliance.write', label: 'Manage compliance' },
      { id: 'approvals.write', label: 'Edit approval policies' },
    ],
  },
  {
    label: 'Workloads',
    perms: [
      { id: 'projects.read', label: 'View projects' },
      { id: 'projects.write', label: 'Edit projects' },
      { id: 'environments.write', label: 'Edit environments' },
    ],
  },
  {
    label: 'Connectivity',
    perms: [
      { id: 'integrations.write', label: 'Manage integrations' },
      { id: 'tokens.write', label: 'Manage API tokens' },
      { id: 'webhooks.write', label: 'Manage webhooks' },
    ],
  },
  {
    label: 'Billing & finance',
    perms: [
      { id: 'billing.write', label: 'Change plan' },
      { id: 'payments.write', label: 'Manage payment methods' },
      { id: 'invoices.read', label: 'View invoices' },
      { id: 'budgets.write', label: 'Manage budgets' },
      { id: 'costcenters.write', label: 'Manage cost centers' },
      { id: 'allocation.read', label: 'View cost allocation' },
    ],
  },
]

export function RolesPermissions() {
  const [view, setView] = useState<'matrix' | 'roles'>('matrix')
  return (
    <ViewShell
      title="Roles & permissions"
      description="Built-in roles enforce strict segregation of duties. Billing, security, and execution responsibilities are split so a single person cannot both change cluster posture and approve their own purchase."
      required={['owner']}
      actions={
        <SecondaryButton onClick={() => alert('Custom role editor — owner-only.')}>
          <IconPlus /> New custom role
        </SecondaryButton>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Built-in roles" value={ALL_ROLES.length} />
        <StatTile label="Custom roles" value={0} hint="Owner-managed" />
        <StatTile
          label="Permissions"
          value={Object.values(ROLE_PERMISSIONS).flat().length / ALL_ROLES.length | 0}
          hint="distinct keys"
        />
        <StatTile label="Segregated duties" value="3 axes" hint="Exec / Security / Finance" />
      </div>

      <div className="inline-flex items-center rounded-lg border border-edge-default bg-surface-sunken/60 p-0.5 text-[12px]">
        <ToggleTab on={view === 'matrix'} onClick={() => setView('matrix')}>
          Permission matrix
        </ToggleTab>
        <ToggleTab on={view === 'roles'} onClick={() => setView('roles')}>
          Role detail
        </ToggleTab>
      </div>

      {view === 'matrix' ? <PermissionMatrix /> : <RoleDetailGrid />}
    </ViewShell>
  )
}

function ToggleTab({ on, onClick, children }: { on: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium transition-all',
        on
          ? 'bg-white text-content shadow-sm ring-1 ring-edge-default'
          : 'text-content-muted hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

function PermissionMatrix() {
  return (
    <SettingsCard
      title="Permission matrix"
      description="Read across to compare what each built-in role can do."
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-190 text-sm">
          <thead>
            <tr className="border-b border-edge-subtle bg-surface-sunken/40 text-left text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
              <th className="px-3 py-2">Capability</th>
              {ALL_ROLES.map((r) => (
                <th key={r} className="px-3 py-2 text-center">
                  {ROLE_LABEL[r]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-edge-subtle">
            {PERM_GROUPS.map((g) => (
              <RowGroup key={g.label} group={g} />
            ))}
          </tbody>
        </table>
      </div>
    </SettingsCard>
  )
}

function RowGroup({ group }: { group: PermGroup }) {
  return (
    <>
      <tr className="bg-surface-sunken/30">
        <td
          colSpan={ALL_ROLES.length + 1}
          className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-content-subtle"
        >
          {group.label}
        </td>
      </tr>
      {group.perms.map((p) => (
        <tr key={p.id} className="hover:bg-surface-sunken/20">
          <td className="px-3 py-2 text-[13px] text-content">{p.label}</td>
          {ALL_ROLES.map((r) => {
            const has = ROLE_PERMISSIONS[r].includes(p.id)
            return (
              <td key={r} className="px-3 py-2 text-center">
                {has ? <Tick /> : <Dash />}
              </td>
            )
          })}
        </tr>
      ))}
    </>
  )
}

function Tick() {
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  )
}
function Dash() {
  return <span className="text-content-subtle">—</span>
}

function RoleDetailGrid() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {ALL_ROLES.map((r) => {
        const perms = ROLE_PERMISSIONS[r]
        return (
          <div key={r} className="rounded-2xl border border-edge-default bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <RoleBadge role={r as Role} />
              <span className="font-mono text-[11px] tabular-nums text-content-subtle">
                {perms.length} perms
              </span>
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-content-muted">
              {ROLE_DESCRIPTION[r]}
            </p>
            <details className="mt-3 text-[11px]">
              <summary className="cursor-pointer text-brand-700 hover:text-brand-800">
                View permissions
              </summary>
              <ul className="mt-2 grid grid-cols-1 gap-x-3 gap-y-0.5 sm:grid-cols-2">
                {perms.map((p) => (
                  <li key={p} className="font-mono text-[10px] text-content-muted">
                    {p}
                  </li>
                ))}
              </ul>
            </details>
            <div className="mt-3 flex justify-end">
              <SecondaryButton>Assign role</SecondaryButton>
            </div>
          </div>
        )
      })}
    </div>
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

export default RolesPermissions
