import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@adhar-console/utils'
import type { Tenant } from '@adhar-console/tenancy'
import { useOrganizations } from './use-organizations.ts'

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
}

export function TenantSwitcher({
  tenants,
  activeId: activeIdProp,
  onChange,
  collapsed = false,
  placement = 'bottom',
}: Props) {
  const org = useOrganizations()
  const [open, setOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [renameFor, setRenameFor] = useState<OrgItem | null>(null)
  const [deleteFor, setDeleteFor] = useState<OrgItem | null>(null)

  // Live data once loaded, else the props passed by the shell (keeps the
  // switcher populated during the initial fetch / when signed out). The
  // fallback is the built-in Default Organization — real orgs always come
  // from the server so nothing about a company is ever hardcoded.
  const usingLive = org.ready
  const items: OrgItem[] = usingLive
    ? org.orgs.map((o) => ({ id: o.id, name: o.name, subtitle: `${o.slug}.*` }))
    : tenants.map((t) => ({ id: t.id, name: t.name, subtitle: t.description ?? `${t.namespacePrefix}.*` }))
  const activeId = usingLive ? org.activeId : activeIdProp
  const active = items.find((t) => t.id === activeId) ?? items[0]

  function select(id: string) {
    setOpen(false)
    if (id === activeId) return
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
      className="relative block rounded-lg p-0.5 ring-1 ring-edge-default transition-all hover:ring-edge-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30"
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
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/20',
      )}
    >
      <OrgAvatar name={active.name} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-content">{active.name}</div>
        <div className="truncate text-[11px] text-content-subtle">
          {switching ? 'Switching…' : active.subtitle}
        </div>
      </div>
      {switching ? <MiniSpinner /> : <IconChevronUpDown />}
    </button>
  )

  return (
    <div className="relative">
      {trigger}
      {open ? (
        <Menu
          placement={placement}
          collapsed={collapsed}
          items={items}
          activeId={activeId}
          manageable={usingLive}
          canDelete={usingLive && items.length > 1}
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
          onDelete={(item) => {
            setOpen(false)
            setDeleteFor(item)
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
      {deleteFor ? (
        <ConfirmDeleteDialog
          name={deleteFor.name}
          isActive={deleteFor.id === activeId}
          busy={org.busy === 'delete'}
          error={org.busy === 'delete' ? null : org.error}
          onClose={() => setDeleteFor(null)}
          onConfirm={async () => {
            // Deleting the active org reloads; otherwise the list refreshes.
            if (await org.deleteOrg(deleteFor.id)) setDeleteFor(null)
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
  manageable,
  canDelete,
  onSelect,
  onClose,
  onNew,
  onRename,
  onDelete,
}: {
  placement: 'top' | 'bottom'
  collapsed?: boolean
  items: OrgItem[]
  activeId: string
  /** Rename/delete are only offered on the live server-backed list. */
  manageable: boolean
  canDelete: boolean
  onSelect(id: string): void
  onClose(): void
  onNew(): void
  onRename(item: OrgItem): void
  onDelete(item: OrgItem): void
}) {
  return (
    <>
      <div className="fixed inset-0 z-40" aria-hidden onClick={onClose} />
      <div
        role="listbox"
        className={cn(
          'absolute z-50 overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-lg ring-1 ring-black/5 dark:ring-white/10',
          collapsed ? 'left-full ml-2 w-64' : 'left-0 right-0',
          placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
        )}
      >
        <div className="border-b border-edge-subtle px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
          Switch organization
        </div>
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
                    manageable && 'pr-16',
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
                {manageable ? (
                  <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                    <button
                      type="button"
                      title={`Rename ${t.name}`}
                      aria-label={`Rename ${t.name}`}
                      onClick={() => onRename(t)}
                      className="rounded-md p-1.5 text-content-subtle transition-colors hover:bg-surface-raised hover:text-content"
                    >
                      <IconPencil />
                    </button>
                    {canDelete ? (
                      <button
                        type="button"
                        title={`Delete ${t.name}`}
                        aria-label={`Delete ${t.name}`}
                        onClick={() => onDelete(t)}
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
    <div className="fixed inset-0 z-100 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={() => !busy && onClose()}
        className="absolute inset-0 bg-scrim/40 backdrop-blur-[2px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-edge-default bg-surface-raised p-6 shadow-2xl ring-1 ring-black/5 dark:ring-white/10"
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

const CANCEL_BTN =
  'inline-flex h-9 items-center rounded-lg border border-edge-default bg-surface-raised px-3 text-sm font-medium text-content-muted transition-colors hover:bg-surface-sunken hover:text-content disabled:opacity-60'

/** Name form used for both "New organization" and "Rename organization". */
function OrgNameDialog({
  title,
  description,
  initial = '',
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
      setLocalError('Give your organization a name.')
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
          <label htmlFor="org-name" className="mb-1 block text-[12px] font-medium text-content-muted">
            Organization name
          </label>
          <input
            id="org-name"
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="Your organization name"
            disabled={busy}
            className="h-10 w-full rounded-lg border border-edge-default bg-surface-app px-3 text-sm text-content shadow-sm outline-none transition-colors placeholder:text-content-subtle focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 disabled:opacity-60"
          />
        </div>
        <ErrorNote text={localError ?? error} />
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={busy} className={CANCEL_BTN}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim() || unchanged}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand-600 px-3.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? <MiniSpinner light /> : null}
            {busy ? busyLabel : submitLabel}
          </button>
        </div>
      </form>
    </DialogFrame>
  )
}

function ConfirmDeleteDialog({
  name,
  isActive,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  name: string
  isActive: boolean
  busy: boolean
  error: string | null
  onClose(): void
  onConfirm(): Promise<void>
}) {
  return (
    <DialogFrame label="Delete organization" busy={busy} onClose={onClose}>
      <h2 className="text-base font-semibold tracking-tight text-content">Delete organization</h2>
      <p className="mt-1 text-[13px] text-content-muted">
        <span className="font-medium text-content">{name}</span> will be removed from your
        organization list{isActive ? ' and you will be switched to another organization' : ''}.
        Resources provisioned on the platform for it are not deleted.
      </p>
      <div className="mt-4 space-y-3">
        <ErrorNote text={error} />
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={busy} className={CANCEL_BTN}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={busy}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-rose-600 px-3.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-rose-700 disabled:opacity-60"
          >
            {busy ? <MiniSpinner light /> : null}
            {busy ? 'Deleting…' : 'Delete organization'}
          </button>
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
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-content-subtle">
      <path d="m7 15 5 5 5-5" />
      <path d="m7 9 5-5 5 5" />
    </svg>
  )
}

function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="ml-auto shrink-0 text-brand-600 dark:text-brand-400">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function IconPencil() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

function IconTrash() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}
