import { StatusBadge } from '@adhar/shell-ui'
import {
  ALL_ROLES,
  IMPLICIT_ROLE_GROUPS,
  ORG_PERMISSION_ROWS,
  ROLE_DESCRIPTION,
  ROLE_GROUP,
  ROLE_LABEL,
  ROLE_TONE,
  type Role,
} from '../data/access.ts'
import { useWorkspaceMe } from '../data/client.ts'
import { SettingsCard, StatTile, ViewShell } from '../components/section-shell.tsx'

/**
 * Settings → Roles & permissions — the model as it is, read-only.
 *
 * An organization has two roles and both are Keycloak groups: `org-<slug>`
 * (member) and `org-<slug>-admin` (admin). People are given a role in
 * Settings → Members; nothing here is stored by the console. The table below
 * is the list the server enforces (ORG_SCOPED_PERMISSIONS), so what this page
 * says is what a request gets. Custom roles saved by older consoles grant
 * nothing and are not shown.
 */
export function RolesPermissions() {
  const me = useWorkspaceMe()
  const slug = me.data?.orgSlug || '<slug>'
  const implicitAdmins = IMPLICIT_ROLE_GROUPS.filter((g) => g.role === 'admin').length

  return (
    <ViewShell
      title="Roles & permissions"
      description={
        <>
          An organization has two roles, and both are Keycloak groups: members are in <Code>{ROLE_GROUP.member(slug)}</Code>,
          admins in <Code>{ROLE_GROUP.admin(slug)}</Code> (and also in the member group). Give someone a role in
          Settings → Members — the console keeps no roles of its own.
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="Roles" value={ALL_ROLES.length} hint="member and admin" />
        <StatTile label="Organization permissions" value={ORG_PERMISSION_ROWS.length} hint="decided from Keycloak groups" />
        <StatTile label="Implicit admin groups" value={implicitAdmins} hint="admin in every organization" />
      </div>

      <SettingsCard title="Roles" description="Who holds each role is the membership of its Keycloak group.">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {ALL_ROLES.map((r) => (
            <div key={r} className="rounded-2xl border border-edge-default bg-surface-raised p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <StatusBadge kind={ROLE_TONE[r]}>{ROLE_LABEL[r]}</StatusBadge>
                <Code>{ROLE_GROUP[r](slug)}</Code>
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-content-muted">{ROLE_DESCRIPTION[r]}</p>
            </div>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard
        title="Roles held without being listed"
        description="Members of these platform groups hold a role without being in the organization's own groups. They are managed by the platform team in Keycloak."
      >
        <ul className="divide-y divide-edge-subtle rounded-xl border border-edge-default">
          {IMPLICIT_ROLE_GROUPS.map((g) => (
            <li key={g.group} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px]">
              <Code>{g.group}</Code>
              <span className="text-content-muted">
                {ROLE_LABEL[g.role]} of {g.where}
              </span>
            </li>
          ))}
        </ul>
      </SettingsCard>

      <SettingsCard
        title="What each role can do"
        description="These permissions belong to one organization and are decided by the console from the groups above — Kubernetes RBAC is not asked. Every other console permission (platform packages, scan waivers, applications, …) is Kubernetes RBAC; see docs/rbac.md."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-140 text-sm">
            <thead>
              <tr className="border-b border-edge-subtle bg-surface-sunken/40 text-left text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
                <th className="px-3 py-2">Permission</th>
                {ALL_ROLES.map((r) => (
                  <th key={r} className="px-3 py-2 text-center">
                    {ROLE_LABEL[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-edge-subtle">
              {ORG_PERMISSION_ROWS.map((p) => (
                <tr key={p.name} className="hover:bg-surface-sunken/20">
                  <td className="px-3 py-2 text-[13px] text-content">{p.description}</td>
                  {ALL_ROLES.map((r) => (
                    <td key={r} className="px-3 py-2 text-center">
                      {holds(r, p.role) ? <Tick /> : <Dash />}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingsCard>
    </ViewShell>
  )
}

/** Admins hold everything members do. */
function holds(role: Role, needs: Role): boolean {
  return needs === 'member' || role === 'admin'
}

function Code({ children }: { children: string }) {
  return <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[12px] text-content">{children}</code>
}

function Tick() {
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  )
}

function Dash() {
  return <span className="text-content-subtle">—</span>
}

export default RolesPermissions
