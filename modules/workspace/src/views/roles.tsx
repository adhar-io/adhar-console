import { useEffect, useState } from 'react'
import { Modal } from '@adhar-console/shell-ui'
import { cn, formatRelative } from '@adhar-console/utils'
import {
  ALL_ROLES,
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '../data/access.ts'
import type { CustomRole } from '../data/client.ts'
import { useCustomRoles, useDeleteRole, useSaveRole } from '../data/settings.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SettingsCard,
  StatTile,
  TextField,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission, RoleBadge } from '../components/role-gate.tsx'

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

const ALL_MATRIX_PERMS = PERM_GROUPS.flatMap((g) => g.perms.map((p) => p.id))

export function RolesPermissions() {
  const [view, setView] = useState<'matrix' | 'roles'>('matrix')
  const [editing, setEditing] = useState<CustomRole | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)

  const customRoles = useCustomRoles()
  const custom = customRoles.data ?? []

  const openCreate = () => {
    setEditing(null)
    setEditorOpen(true)
  }
  const openEdit = (r: CustomRole) => {
    setEditing(r)
    setEditorOpen(true)
  }

  return (
    <ViewShell
      title="Roles & permissions"
      description="Built-in roles enforce strict segregation of duties. Billing, security, and execution responsibilities are split so a single person cannot both change cluster posture and approve their own purchase."
      required={['owner']}
      actions={
        <RequirePermission perm="roles.write" required={['owner']} readOnly>
          <SecondaryButton onClick={openCreate}>
            <IconPlus /> New custom role
          </SecondaryButton>
        </RequirePermission>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Built-in roles" value={ALL_ROLES.length} />
        <StatTile label="Custom roles" value={custom.length} hint="Owner-managed" />
        <StatTile
          label="Permissions"
          value={(Object.values(ROLE_PERMISSIONS).flat().length / ALL_ROLES.length) | 0}
          hint="distinct keys"
        />
        <StatTile label="Segregated duties" value="3 axes" hint="Exec / Security / Finance" />
      </div>

      <CustomRolesCard
        loading={customRoles.isLoading}
        roles={custom}
        onNew={openCreate}
        onEdit={openEdit}
      />

      <div className="inline-flex items-center rounded-lg border border-edge-default bg-surface-sunken/60 p-0.5 text-[12px]">
        <ToggleTab on={view === 'matrix'} onClick={() => setView('matrix')}>
          Permission matrix
        </ToggleTab>
        <ToggleTab on={view === 'roles'} onClick={() => setView('roles')}>
          Role detail
        </ToggleTab>
      </div>

      {view === 'matrix' ? <PermissionMatrix /> : <RoleDetailGrid />}

      <RoleEditor open={editorOpen} initial={editing} onClose={() => setEditorOpen(false)} />
    </ViewShell>
  )
}

/* ─────────────────── Custom roles list ─────────────────── */

function CustomRolesCard({
  loading,
  roles,
  onNew,
  onEdit,
}: {
  loading: boolean
  roles: CustomRole[]
  onNew(): void
  onEdit(r: CustomRole): void
}) {
  const del = useDeleteRole()
  return (
    <SettingsCard
      title="Custom roles"
      description="Owner-defined roles layered on top of the built-in set. Assign them to members like any built-in role."
      actions={
        <RequirePermission perm="roles.write" required={['owner']} readOnly>
          <SecondaryButton onClick={onNew}>
            <IconPlus /> New
          </SecondaryButton>
        </RequirePermission>
      }
    >
      {loading ? (
        <p className="text-[12px] text-content-muted">Loading…</p>
      ) : roles.length === 0 ? (
        <p className="text-[12px] text-content-muted">
          No custom roles yet. Create one to grant a tailored slice of permissions.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {roles.map((r) => (
            <div key={r.id} className="rounded-2xl border border-edge-default bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-800 ring-1 ring-inset ring-brand-200">
                  {r.name}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-content-subtle">
                  {r.permissions.length} perms
                </span>
              </div>
              {r.description ? (
                <p className="mt-2 text-[12px] leading-relaxed text-content-muted">{r.description}</p>
              ) : null}
              <p className="mt-2 text-[10.5px] text-content-subtle">
                Updated {formatRelative(r.updatedAt)}
              </p>
              <div className="mt-3 flex justify-end gap-1.5">
                <RequirePermission perm="roles.write" required={['owner']} readOnly>
                  <SecondaryButton onClick={() => onEdit(r)}>Edit</SecondaryButton>
                  <SecondaryButton
                    tone="rose"
                    disabled={del.isPending}
                    onClick={() => del.mutate(r.id)}
                  >
                    Delete
                  </SecondaryButton>
                </RequirePermission>
              </div>
            </div>
          ))}
        </div>
      )}
    </SettingsCard>
  )
}

/* ─────────────────── Role editor modal ─────────────────── */

function RoleEditor({
  open,
  initial,
  onClose,
}: {
  open: boolean
  initial: CustomRole | null
  onClose(): void
}) {
  const save = useSaveRole()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [perms, setPerms] = useState<Set<Permission>>(new Set())

  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? '')
    setDescription(initial?.description ?? '')
    setPerms(new Set(initial?.permissions ?? []))
    save.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial])

  const toggle = (p: Permission) =>
    setPerms((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })

  const toggleGroup = (g: PermGroup, on: boolean) =>
    setPerms((prev) => {
      const next = new Set(prev)
      for (const p of g.perms) {
        if (on) next.add(p.id)
        else next.delete(p.id)
      }
      return next
    })

  const canSave = name.trim().length > 0 && perms.size > 0 && !save.isPending

  const submit = () =>
    save.mutate(
      {
        id: initial?.id,
        input: {
          name: name.trim(),
          description: description.trim() || undefined,
          permissions: ALL_MATRIX_PERMS.filter((p) => perms.has(p)),
        },
      },
      { onSuccess: onClose },
    )

  return (
    <Modal
      open={open}
      onClose={onClose}
      branded
      width="xl"
      title={initial ? 'Edit custom role' : 'New custom role'}
      description="Name the role and pick the exact permissions it grants. Owner-only."
      footer={
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <PrimaryButton disabled={!canSave} onClick={submit}>
            {save.isPending ? 'Saving…' : initial ? 'Save changes' : 'Create role'}
          </PrimaryButton>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-content">Role name</span>
            <TextField value={name} onChange={setName} placeholder="e.g. Release Manager" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-content">Description</span>
            <TextField
              value={description}
              onChange={setDescription}
              placeholder="What this role is for"
            />
          </label>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-content-subtle">
              Permissions
            </span>
            <span className="text-[11px] text-content-muted">{perms.size} selected</span>
          </div>
          <div className="space-y-4">
            {PERM_GROUPS.map((g) => {
              const all = g.perms.every((p) => perms.has(p.id))
              return (
                <div key={g.label} className="rounded-xl border border-edge-subtle p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[12px] font-semibold text-content">{g.label}</span>
                    <button
                      type="button"
                      onClick={() => toggleGroup(g, !all)}
                      className="text-[11px] font-medium text-brand-700 hover:text-brand-800"
                    >
                      {all ? 'Clear group' : 'Select all'}
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {g.perms.map((p) => {
                      const on = perms.has(p.id)
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => toggle(p.id)}
                          className={cn(
                            'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors',
                            on
                              ? 'border-brand-300 bg-brand-50 text-brand-900'
                              : 'border-edge-default bg-white text-content-muted hover:bg-surface-sunken',
                          )}
                        >
                          <span
                            className={cn(
                              'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                              on
                                ? 'border-brand-500 bg-brand-600 text-white'
                                : 'border-edge-strong bg-white',
                            )}
                          >
                            {on ? (
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                <path d="M20 6 9 17l-5-5" />
                              </svg>
                            ) : null}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate">{p.label}</span>
                            <span className="block font-mono text-[10px] text-content-subtle">{p.id}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {save.isError ? (
          <p className="text-[12px] text-rose-700">
            {(save.error as Error)?.message ?? 'Could not save the role.'}
          </p>
        ) : null}
      </div>
    </Modal>
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
