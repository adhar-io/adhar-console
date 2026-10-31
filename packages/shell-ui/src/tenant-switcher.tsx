import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@adhar/utils'
import type { Tenant } from '@adhar/tenancy'
import { useOrganizations } from './use-organizations.ts'
import { type TeamSummary, useTeams } from './use-teams.ts'
import { useClickOutside } from './use-click-outside.ts'
import { useCan } from './can.tsx'
import { Button } from './button.tsx'
import { Input } from './form.tsx'
import { CONSOLE_PERMISSIONS } from '@adhar/auth'

interface Props {
  /** Fallback list used until the live `/api/organizations` list loads. */
  tenants: Tenant[]
  activeId: string
  /** Fallback switch handler used before the live list loads. */
  onChange(id: string): void
  /** Icon-only when true — shows just the org avatar. */
  collapsed?: boolean
  /** Whether the menu opens upward (true when placed in the sidebar footer). */
  placement?: 'top' | 'bottom'
}

interface OrgItem {
  id: string
  name: string
  subtitle: string
  /** An admin of this organization (its own or a platform admin) may rename it. */
  canRename: boolean
  /** Only a membership of the user's own can be left — not access through a platform group. */
  canLeave: boolean
}

/** Shown in the trigger when the live list is empty: the user is in no organization yet. */
const NO_ORG: OrgItem = { id: '', name: 'No organization', subtitle: 'Create or join one', canRename: false, canLeave: false }

export function TenantSwitcher({
  tenants,
  activeId: activeIdProp,
  onChange,
  collapsed = false,
  placement = 'bottom',
}: Props) {
  const org = useOrganizations()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  // Outside click or Escape closes the menu wherever the click lands — the
  // sidebar, the topbar, a drawer — not only on the page body.
  useClickOutside(rootRef, close, open)
  const [createOpen, setCreateOpen] = useState(false)
  const [renameFor, setRenameFor] = useState<OrgItem | null>(null)
  const [leaveFor, setLeaveFor] = useState<OrgItem | null>(null)
  const [teamCreateOpen, setTeamCreateOpen] = useState(false)
  const [teamRenameFor, setTeamRenameFor] = useState<TeamSummary | null>(null)
  const [teamDeleteFor, setTeamDeleteFor] = useState<TeamSummary | null>(null)

  // Teams belong to the active organization, so the hook re-fetches whenever
  // the org changes. Passing undefined before the live list arrives keeps it
  // quiet rather than firing a request against an id that isn't settled yet.
  const teams = useTeams(org.ready ? org.activeId : undefined)

  // Kubernetes RBAC, asked here (the trigger is always mounted) rather than in
  // the menu, so the answers are in by the time it opens and nothing pops in.
  // Entries the person may not use are hidden, not disabled (docs/rbac.md).
  // Renaming and leaving are decided per organization from the user's role in
  // it (`role` / `via` on each entry) — one useCan answers for the active
  // organization only, and the list holds others.
  const perms = {
    orgCreate: useCan(CONSOLE_PERMISSIONS.orgCreate),
    teamCreate: useCan(CONSOLE_PERMISSIONS.teamsCreate),
    teamUpdate: useCan(CONSOLE_PERMISSIONS.teamsUpdate),
    teamDelete: useCan(CONSOLE_PERMISSIONS.teamsDelete),
  }

  // Live data once loaded, else the props passed by the shell (keeps the
  // switcher populated during the initial fetch / when signed out). The
  // fallback is the built-in Default Organization — real orgs always come
  // from the server so nothing about a company is ever hardcoded.
  const usingLive = org.ready
  const items: OrgItem[] = usingLive
    ? org.orgs.map((o) => ({
      id: o.id,
      name: o.name,
      subtitle: o.via === 'platform-admin' ? `${o.slug} · platform admin` : `${o.slug}.*`,
      canRename: o.role === 'admin',
      // Not your only organization: leaving it would leave nothing to switch to.
      canLeave: o.via === 'membership' && org.orgs.length > 1,
    }))
    : tenants.map((t) => ({ id: t.id, name: t.name, subtitle: t.description ?? `${t.namespacePrefix}.*`, canRename: false, canLeave: false }))
  const activeId = usingLive ? org.activeId : activeIdProp
  // A user in no organization still gets the switcher — it is where they create one.
  const active = items.find((t) => t.id === activeId) ?? items[0] ?? (usingLive ? NO_ORG : undefined)
  const hasOrg = active !== NO_ORG

  function select(id: string) {
    setOpen(false)
    if (!id || id === activeId) return
    if (usingLive) void org.switchOrg(id)
    else onChange(id)
  }

  if (!active) return null

  const switching = org.busy === 'switch'

  const trigger = collapsed ? (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      title={active.name}
      aria-label={`Active organization: ${active.name}. Click to switch.`}
      className="relative block rounded-lg p-0.5 ring-1 ring-edge-default transition-all hover:ring-edge-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
    >
      <OrgAvatar name={active.name} />
      {switching ? <BusyDot /> : null}
    </button>
  ) : (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      aria-haspopup="listbox"
      aria-expanded={open}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg border px-2 py-1.5 text-left transition-all',
        'border-edge-default bg-surface-raised shadow-sm hover:border-edge-strong hover:bg-surface-sunken',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40',
      )}
    >
      <OrgAvatar name={active.name} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-content">{active.name}</div>
        {/* The second line shows the active TEAM, so the two levels a person
            works inside are both visible without opening anything. It falls
            back to the org subtitle when teams have not loaded. */}
        <div className="truncate text-[11px] text-content-subtle">
          {switching
            ? 'Switching…'
            : teams.active
            ? teams.active.name
            : active.subtitle}
        </div>
      </div>
      {switching ? <MiniSpinner /> : <IconChevronUpDown />}
    </button>
  )

  return (
    <div ref={rootRef} className="relative">
      {trigger}
      {open ? (
        <Menu
          placement={placement}
          collapsed={collapsed}
          items={items}
          activeId={activeId}
          manageable={usingLive}
          degraded={usingLive && org.degraded}
          canCreate={perms.orgCreate}
          canCreateTeam={usingLive && hasOrg && perms.teamCreate}
          canRenameTeam={usingLive && hasOrg && perms.teamUpdate}
          canDeleteTeam={usingLive && hasOrg && perms.teamDelete}
          teams={usingLive && teams.ready ? teams.teams : []}
          activeTeamId={teams.activeId}
          teamBusy={teams.switching || teams.busy !== null}
          teamsReady={usingLive && hasOrg && teams.ready}
          onSelectTeam={(id) => {
            setOpen(false)
            void teams.switchTeam(id)
          }}
          onNewTeam={() => {
            setOpen(false)
            setTeamCreateOpen(true)
          }}
          onRenameTeam={(t) => {
            setOpen(false)
            setTeamRenameFor(t)
          }}
          onDeleteTeam={(t) => {
            setOpen(false)
            setTeamDeleteFor(t)
          }}
          onSelect={select}
          onClose={() => setOpen(false)}
          onNew={() => {
            setOpen(false)
            setCreateOpen(true)
          }}
          onRename={(item) => {
            setOpen(false)
            setRenameFor(item)
          }}
          onLeave={(item) => {
            setOpen(false)
            setLeaveFor(item)
          }}
        />
      ) : null}
      {createOpen ? (
        <OrgNameDialog
          title="New organization"
          description="Organizations keep each team’s catalog, workspace, and settings separate. You can switch between them anytime."
          submitLabel="Create organization"
          busyLabel="Creating…"
          busy={org.busy === 'create'}
          error={org.busy === 'create' ? null : org.error}
          onClose={() => setCreateOpen(false)}
          onSubmit={async (name) => {
            const created = await org.createOrg(name)
            // On success the page reloads into the new org; only close on failure.
            return !!created
          }}
        />
      ) : null}
      {renameFor ? (
        <OrgNameDialog
          title="Rename organization"
          description="The new name shows everywhere this organization appears. Its slug and provisioned resources are unchanged."
          initial={renameFor.name}
          submitLabel="Save name"
          busyLabel="Saving…"
          busy={org.busy === 'rename'}
          error={org.busy === 'rename' ? null : org.error}
          onClose={() => setRenameFor(null)}
          onSubmit={async (name) => {
            const ok = await org.renameOrg(renameFor.id, name)
            if (ok) setRenameFor(null)
            return ok
          }}
        />
      ) : null}
      {leaveFor ? (
        <ConfirmDeleteDialog
          entity="organization"
          verb="Leave"
          name={leaveFor.name}
          body={
            <>
              You will be removed from <span className="font-medium text-content">{leaveFor.name}</span>'s
              Keycloak groups and lose access to its workspace, teams and projects
              {leaveFor.id === activeId ? ', and you will be switched to another organization' : ''}. The
              organization, its people and its resources are not affected; an admin can add you back.
            </>
          }
          busy={org.busy === 'leave'}
          error={org.busy === 'leave' ? null : org.error}
          onClose={() => setLeaveFor(null)}
          onConfirm={async () => {
            // Leaving the active org reloads; otherwise the list refreshes.
            if (await org.leaveOrg(leaveFor.id)) setLeaveFor(null)
          }}
        />
      ) : null}

      {/* ── teams ── */}
      {teamCreateOpen ? (
        <OrgNameDialog
          title="New team"
          nameLabel="Team name"
          description="Teams divide an organization's projects and access. Members you add to a team inherit its access to repositories, namespaces and dashboards."
          submitLabel="Create team"
          busyLabel="Creating…"
          busy={teams.busy === 'create'}
          error={teams.busy === 'create' ? null : teams.error}
          onClose={() => setTeamCreateOpen(false)}
          onSubmit={async (name) => {
            const created = await teams.createTeam({ name })
            // Land in the team just created — creating one is how you say you
            // intend to work in it.
            if (created) {
              await teams.switchTeam(created.id)
              setTeamCreateOpen(false)
            }
            return !!created
          }}
        />
      ) : null}
      {teamRenameFor ? (
        <OrgNameDialog
          title="Rename team"
          nameLabel="Team name"
          description="The new name shows everywhere this team appears. Its slug, members and the Keycloak group behind it are unchanged."
          initial={teamRenameFor.name}
          submitLabel="Save name"
          busyLabel="Saving…"
          busy={teams.busy === 'rename'}
          error={teams.busy === 'rename' ? null : teams.error}
          onClose={() => setTeamRenameFor(null)}
          onSubmit={async (name) => {
            const ok = await teams.renameTeam(teamRenameFor.id, name)
            if (ok) setTeamRenameFor(null)
            return ok
          }}
        />
      ) : null}
      {teamDeleteFor ? (
        <ConfirmDeleteDialog
          entity="team"
          name={teamDeleteFor.name}
          body={
            <>
              <span className="font-medium text-content">{teamDeleteFor.name}</span> and its Keycloak
              group will be deleted, so everyone in it loses the access granted through it
              {teamDeleteFor.id === teams.activeId ? ', and your view will stop being scoped to it' : ''}.
              Projects the team owns are not deleted, and neither are the repositories, namespaces or
              dashboards it had access to — and its members stay in the organization.
            </>
          }
          busy={teams.busy === 'delete'}
          error={teams.busy === 'delete' ? null : teams.error}
          onClose={() => setTeamDeleteFor(null)}
          onConfirm={async () => {
            if (await teams.deleteTeam(teamDeleteFor.id)) setTeamDeleteFor(null)
          }}
        />
      ) : null}
    </div>
  )
}

function Menu({
  placement,
  collapsed = false,
  items,
  activeId,
  manageable: _manageable,
  degraded,
  canCreate,
  canCreateTeam,
  canRenameTeam,
  canDeleteTeam,
  teams,
  activeTeamId,
  teamBusy,
  teamsReady,
  onSelectTeam,
  onNewTeam,
  onRenameTeam,
  onDeleteTeam,
  onSelect,
  onClose: _onClose,
  onNew,
  onRename,
  onLeave,
}: {
  placement: 'top' | 'bottom'
  collapsed?: boolean
  items: OrgItem[]
  activeId: string
  /** Rename/leave are only offered on the live server-backed list. */
  manageable: boolean
  /** The list came from the sign-in token: Keycloak could not be asked. */
  degraded: boolean
  /** RBAC: `create organizations`. */
  canCreate: boolean
  /** RBAC: `create`/`update`/`delete workspace-teams`. */
  canCreateTeam: boolean
  canRenameTeam: boolean
  canDeleteTeam: boolean
  /** Teams inside the active organization. Empty until the live list loads. */
  teams: TeamSummary[]
  activeTeamId: string
  teamBusy: boolean
  /** The live team list has loaded — show the section even when it is empty. */
  teamsReady: boolean
  onSelectTeam(id: string): void
  onNewTeam(): void
  onRenameTeam(t: TeamSummary): void
  onDeleteTeam(t: TeamSummary): void
  onSelect(id: string): void
  onClose(): void
  onNew(): void
  onRename(item: OrgItem): void
  onLeave(item: OrgItem): void
}) {
  return (
    <>
      <div
        role="listbox"
        className={cn(
          'pop-in absolute z-50 overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-xl',
          collapsed ? 'left-full ml-2 w-64' : 'left-0 right-0',
          placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
        )}
      >
        <div className="border-b border-edge-subtle px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
          Switch organization
          {degraded ? (
            <span
              title="Keycloak could not be asked just now, so this list comes from your sign-in token and may miss a membership added since."
              className="ml-1.5 normal-case tracking-normal text-amber-700 dark:text-amber-300"
            >
              · from your sign-in
            </span>
          ) : null}
        </div>
        {items.length === 0 ? (
          <p className="px-3 py-2 text-[12px] leading-snug text-content-subtle">
            You are not in an organization yet. Create one, or ask an organization admin to add you.
          </p>
        ) : null}
        <ul className="max-h-72 overflow-y-auto py-1">
          {items.map((t) => {
            const isActive = t.id === activeId
            return (
              <li key={t.id} className="group relative">
                <button
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => onSelect(t.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
                    isActive ? 'bg-surface-sunken' : 'hover:bg-surface-sunken',
                    (t.canRename || t.canLeave) && 'pr-16',
                  )}
                >
                  <OrgAvatar name={t.name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-content">{t.name}</span>
                      {isActive ? <IconCheck /> : null}
                    </div>
                    <div className="truncate text-[11px] text-content-subtle">{t.subtitle}</div>
                  </div>
                </button>
                {t.canRename || t.canLeave ? (
                  <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
                    {t.canRename ? (
                    <button
                      type="button"
                      title={`Rename ${t.name}`}
                      aria-label={`Rename ${t.name}`}
                      onClick={() => onRename(t)}
                      className="rounded-md p-1.5 text-content-subtle transition-colors hover:bg-surface-raised hover:text-content"
                    >
                      <IconPencil />
                    </button>
                    ) : null}
                    {t.canLeave ? (
                      <button
                        type="button"
                        title={`Leave ${t.name}`}
                        aria-label={`Leave ${t.name}`}
                        onClick={() => onLeave(t)}
                        className="rounded-md p-1.5 text-content-subtle transition-colors hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
                      >
                        <IconLeave />
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>

        {/* Teams in the active organization. Switching one is a scope change
            within the same tenant, so unlike an org switch it neither re-signs
            the session nor reloads the page. Hidden entirely when the live list
            is unavailable rather than showing an empty, unexplained heading. */}
        {teamsReady ? (
          <>
            <div className="flex items-center justify-between gap-2 border-y border-edge-subtle px-3 py-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                Team
              </span>
              {teamBusy ? <MiniSpinner /> : null}
            </div>
            <ul className="max-h-48 overflow-y-auto py-1">
              {teams.map((t) => {
                const isActive = t.id === activeTeamId
                return (
                  <li key={t.id} className="group relative">
                    <button
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onClick={() => onSelectTeam(t.id)}
                      className={cn(
                        'flex w-full items-center gap-2.5 py-1.5 pl-3 text-left transition-colors',
                        isActive ? 'bg-surface-sunken' : 'hover:bg-surface-sunken',
                        canRenameTeam || canDeleteTeam ? 'pr-16' : 'pr-3',
                      )}
                    >
                      {/* Indented under the org list to show the nesting. */}
                      <span
                        aria-hidden
                        className={cn(
                          'ml-1 h-1.5 w-1.5 shrink-0 rounded-full',
                          isActive ? 'bg-brand-500' : 'bg-edge-strong',
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-content">{t.name}</span>
                      {/* Teams you belong to are listed first and marked, so a
                          large organization's list stays navigable and it is
                          obvious which ones are yours to work in. */}
                      {t.mine
                        ? (
                          <span className="shrink-0 rounded bg-brand-50 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
                            You
                          </span>
                        )
                        : null}
                      {t.accessBinding === 'pending-platform-upgrade'
                        ? (
                          <span
                            title="Membership works, but cluster RBAC still binds this team's old, organization-less group; access granted through it reaches Kubernetes after the next platform upgrade."
                            className="shrink-0 rounded bg-amber-50 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
                          >
                            Pending
                          </span>
                        )
                        : null}
                      {isActive ? <IconCheck /> : null}
                    </button>
                    {canRenameTeam || canDeleteTeam ? (
                      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
                        {canRenameTeam ? (
                        <button
                          type="button"
                          title={`Rename ${t.name}`}
                          aria-label={`Rename team ${t.name}`}
                          onClick={() => onRenameTeam(t)}
                          className="rounded-md p-1.5 text-content-subtle transition-colors hover:bg-surface-raised hover:text-content"
                        >
                          <IconPencil />
                        </button>
                        ) : null}
                        {canDeleteTeam ? (
                        <button
                          type="button"
                          title={`Delete ${t.name}`}
                          aria-label={`Delete team ${t.name}`}
                          onClick={() => onDeleteTeam(t)}
                          className="rounded-md p-1.5 text-content-subtle transition-colors hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
                        >
                          <IconTrash />
                        </button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
            {/* An organization with no teams still needs a way to get its
                first one — the section used to disappear entirely when the
                list was empty, which hid the only route to creating one. */}
            {teams.length === 0 ? (
              <p className="px-3 pb-2 text-[11px] leading-snug text-content-subtle">
                No teams yet. A team groups projects and the access that comes with them.
              </p>
            ) : null}
            {canCreateTeam ? (
              <div className="px-1 pb-1">
                <button
                  type="button"
                  onClick={onNewTeam}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[13px] font-medium text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
                >
                  <IconPlus />
                  New team
                </button>
              </div>
            ) : null}
          </>
        ) : null}

        {canCreate ? (
        <div className="border-t border-edge-subtle p-1">
          <button
            type="button"
            onClick={onNew}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
          >
            <IconPlus />
            New organization
          </button>
        </div>
        ) : null}
      </div>
    </>
  )
}

/* ─────────── dialogs ─────────── */

/** Shared shell for the small modal dialogs (backdrop, escape-to-close, card). */
function DialogFrame({
  label,
  busy,
  onClose,
  children,
}: {
  label: string
  busy: boolean
  onClose(): void
  children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  return createPortal(
    // z-60 like every other overlay (it was z-100, above the toasts that
    // report what the dialog did).
    <div className="fixed inset-0 z-60 flex items-end justify-center sm:items-center sm:p-4">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => !busy && onClose()}
        className="fade-in absolute inset-0 bg-scrim/45 backdrop-blur-[2px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="pop-in relative w-full overflow-hidden rounded-t-2xl border border-edge-default bg-surface-raised p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-2xl sm:max-w-sm sm:rounded-2xl sm:pb-6"
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

function ErrorNote({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700 dark:border-rose-500/25 dark:bg-rose-500/10 dark:text-rose-300">
      {text}
    </p>
  )
}

/** Name form used for both "New organization" and "Rename organization". */
function OrgNameDialog({
  title,
  description,
  initial = '',
  nameLabel = 'Organization name',
  submitLabel,
  busyLabel,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  title: string
  description: string
  initial?: string
  /** The field's label — the same dialog names organizations and teams. */
  nameLabel?: string
  submitLabel: string
  busyLabel: string
  busy: boolean
  error: string | null
  onClose(): void
  onSubmit(name: string): Promise<boolean>
}) {
  const [name, setName] = useState(initial)
  const [localError, setLocalError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const unchanged = !!initial && name.trim() === initial.trim()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setLocalError(nameLabel === 'Team name' ? 'Give the team a name.' : 'Give your organization a name.')
      return
    }
    if (unchanged) {
      onClose()
      return
    }
    setLocalError(null)
    await onSubmit(trimmed)
    // Failure surfaces through the hook's `error` below.
  }

  return (
    <DialogFrame label={title} busy={busy} onClose={onClose}>
      <h2 className="text-base font-semibold tracking-tight text-content">{title}</h2>
      <p className="mt-1 text-[13px] text-content-muted">{description}</p>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <div>
          <label htmlFor="org-name" className="mb-1.5 block text-[13px] font-medium text-content">
            {nameLabel}
          </label>
          <Input
            id="org-name"
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder={nameLabel === 'Team name' ? 'e.g. Payments' : 'Your organization name'}
            disabled={busy}
          />
        </div>
        <ErrorNote text={localError ?? error} />
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || unchanged}>
            {busy ? busyLabel : submitLabel}
          </Button>
        </div>
      </form>
    </DialogFrame>
  )
}

function ConfirmDeleteDialog({
  entity,
  verb = 'Delete',
  name,
  body,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  /** What is being deleted (or left) — used for the heading and the aria label. */
  entity: 'organization' | 'team'
  /** Leaving takes the user out of something that goes on existing. */
  verb?: 'Delete' | 'Leave'
  name: string
  /** What deleting it actually does. Spelling out what SURVIVES is the point. */
  body: ReactNode
  busy: boolean
  error: string | null
  onClose(): void
  onConfirm(): Promise<void>
}) {
  return (
    <DialogFrame label={`${verb} ${entity} ${name}`} busy={busy} onClose={onClose}>
      <h2 className="text-base font-semibold tracking-tight text-content">{verb} {entity}</h2>
      <p className="mt-1 text-[13px] text-content-muted">{body}</p>
      <div className="mt-4 space-y-3">
        <ErrorNote text={error} />
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void onConfirm()} loading={busy}>
            {busy ? (verb === 'Leave' ? 'Leaving…' : 'Deleting…') : `${verb} ${entity}`}
          </Button>
        </div>
      </div>
    </DialogFrame>
  )
}

/* ─────────── bits ─────────── */

function OrgAvatar({ name }: { name: string }) {
  const initials = name.slice(0, 2).toUpperCase()
  const hue = hashHue(name)
  return (
    <div
      aria-hidden
      style={{
        backgroundImage: `linear-gradient(135deg, hsl(${hue} 60% 42%), hsl(${(hue + 30) % 360} 60% 28%))`,
      }}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold text-white shadow-sm ring-1 ring-black/10"
    >
      {initials}
    </div>
  )
}

function hashHue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}

function BusyDot() {
  return (
    <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-brand-500 ring-2 ring-surface-raised" />
  )
}

function MiniSpinner({ light }: { light?: boolean }) {
  return (
    <svg
      className={cn('animate-spin shrink-0', light ? 'text-white' : 'text-content-subtle')}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

function IconChevronUpDown() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-content-subtle">
      <path d="m7 15 5 5 5-5" />
      <path d="m7 9 5-5 5 5" />
    </svg>
  )
}

function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="ml-auto shrink-0 text-brand-600 dark:text-brand-400">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function IconPencil() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.42" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

function IconLeave() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.42" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  )
}

function IconTrash() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.42" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}
