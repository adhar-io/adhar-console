import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { formatRelative, cn } from '@adhar-console/utils'
import { Kbd } from './primitives.tsx'
import { AppLauncher, type AppLink } from './app-launcher.tsx'
import { ModeToggle } from './mode-toggle.tsx'
import { useNotifications, type Notification } from './notifications.ts'
import type { User } from '@adhar-console/auth'

interface Props {
  user: User
  /** Seed notifications — usually from the route loader. Client layer manages read/dismissed state. */
  notifications?: Notification[]
  /** Override the default app-launcher entries (BFF will supply real URLs per tenant). */
  apps?: AppLink[]
  onSignOut?(): void
  onOpenCommandPalette?(): void
  /** Triggers the slide-over sidebar on mobile. Hidden at lg+. */
  onOpenSidebar?(): void
}

export function Topbar({
  user,
  notifications = [],
  apps,
  onSignOut,
  onOpenCommandPalette,
  onOpenSidebar,
}: Props) {
  return (
    <header className="sticky top-0 z-40 border-b border-edge-default bg-surface-raised/70 backdrop-blur-xl supports-[backdrop-filter]:bg-surface-raised/60">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-brand-400/40 to-transparent"
        aria-hidden
      />
      <div className="relative flex h-14 items-center justify-between gap-2 px-3 sm:gap-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          {onOpenSidebar ? (
            <button
              type="button"
              onClick={onOpenSidebar}
              aria-label="Open navigation"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-content-muted transition-colors hover:bg-surface-sunken hover:text-content lg:hidden"
            >
              <IconMenu />
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          {onOpenCommandPalette ? (
            <button
              type="button"
              onClick={onOpenCommandPalette}
              className={cn(
                'group hidden h-9 items-center gap-2 rounded-lg border border-edge-default bg-surface-raised/80 px-3 text-xs text-content-muted shadow-sm transition-all duration-150',
                'hover:border-brand-300 hover:bg-surface-raised hover:text-content hover:shadow-md',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/25 sm:flex',
              )}
            >
              <span className="text-content-subtle transition-colors group-hover:text-brand-600">
                <IconSearch />
              </span>
              <span className="min-w-28 text-left">Search anything…</span>
              <Kbd size="xs" className="ml-4">⌘K</Kbd>
            </button>
          ) : null}
          <HelpMenu />
          <ModeToggle />
          <AppLauncher apps={apps} />
          <NotificationsMenu seed={notifications} />
          <span className="mx-1 hidden h-6 w-px bg-edge-subtle sm:block" aria-hidden />
          <UserMenu user={user} onSignOut={onSignOut} />
        </div>
      </div>
    </header>
  )
}

const IconButton = ({
  onClick,
  children,
  label,
  indicator,
  active,
  buttonRef,
}: {
  onClick(): void
  children: React.ReactNode
  label: string
  indicator?: boolean
  active?: boolean
  buttonRef?: RefObject<HTMLButtonElement | null>
}) => (
  <button
    ref={buttonRef}
    type="button"
    onClick={onClick}
    aria-label={label}
    aria-expanded={active}
    className={cn(
      'relative flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-150',
      active
        ? 'bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300 ring-1 ring-brand-200'
        : 'text-content-muted hover:bg-surface-sunken hover:text-content',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/25',
    )}
  >
    {children}
    {indicator ? (
      <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-white" />
    ) : null}
  </button>
)

function HelpMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <>
      <IconButton onClick={() => setOpen((o) => !o)} label="Help" active={open} buttonRef={ref}>
        <IconQuestion />
      </IconButton>
      {open ? (
        <Dropdown onClose={() => setOpen(false)} anchorRef={ref}>
          <div className="px-3 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
            Help & resources
          </div>
          <DropdownLink to="/help" icon={<IconBookOpen />} onNavigate={() => setOpen(false)}>
            Help center
          </DropdownLink>
          <DropdownLink to="/changelog" icon={<IconSparkle />} onNavigate={() => setOpen(false)}>
            What's new
          </DropdownLink>
          <DropdownLink to="/status" icon={<IconActivity />} onNavigate={() => setOpen(false)}>
            Platform status
          </DropdownLink>
          <DropdownLink to="/onboarding" icon={<IconCompass />} onNavigate={() => setOpen(false)}>
            Re-run onboarding
          </DropdownLink>
          <DropdownDivider />
          <DropdownAnchor href="https://adhar.io" external icon={<IconGlobe />}>
            adhar.io
          </DropdownAnchor>
        </Dropdown>
      ) : null}
    </>
  )
}

type Filter = 'all' | 'unread'

function NotificationsMenu({ seed }: { seed: Notification[] }) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const { items, unreadCount, markRead, markAllRead, dismiss, dismissAll } = useNotifications(seed)
  const ref = useRef<HTMLButtonElement>(null)

  const visible = filter === 'unread' ? items.filter((n) => !n.read) : items

  return (
    <>
      <IconButton
        onClick={() => setOpen((o) => !o)}
        label={`Notifications${unreadCount ? ` — ${unreadCount} unread` : ''}`}
        indicator={unreadCount > 0}
        active={open}
        buttonRef={ref}
      >
        <IconBell />
      </IconButton>
      {open ? (
        <Dropdown onClose={() => setOpen(false)} anchorRef={ref} widthClass="w-96">
          <div className="flex items-center justify-between gap-2 border-b border-edge-subtle px-3 py-2.5">
            <div>
              <div className="text-sm font-semibold text-content">Notifications</div>
              <div className="text-[11px] text-content-muted">
                {unreadCount
                  ? `${unreadCount} unread · ${items.length} total`
                  : items.length
                    ? `${items.length} recent`
                    : 'All caught up'}
              </div>
            </div>
            <div className="flex items-center gap-1 rounded-md bg-surface-sunken p-0.5 text-[11px] font-medium">
              <FilterTab active={filter === 'all'} onClick={() => setFilter('all')}>
                All
              </FilterTab>
              <FilterTab active={filter === 'unread'} onClick={() => setFilter('unread')}>
                Unread {unreadCount > 0 ? `(${unreadCount})` : ''}
              </FilterTab>
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="px-3 py-10 text-center">
              <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600">
                <IconCheck />
              </div>
              <div className="text-sm font-medium text-content">
                {filter === 'unread' ? 'Nothing unread' : "You're all caught up"}
              </div>
              <div className="mt-0.5 text-xs text-content-muted">
                {filter === 'unread'
                  ? 'Switch to All to see older items.'
                  : 'New events land here as they happen.'}
              </div>
            </div>
          ) : (
            <ul className="max-h-96 divide-y divide-edge-subtle overflow-y-auto">
              {visible.map((n) => (
                <NotificationRow
                  key={n.id}
                  n={n}
                  onRead={() => markRead(n.id)}
                  onDismiss={() => dismiss(n.id)}
                  onOpen={() => {
                    markRead(n.id)
                    if (n.href) setOpen(false)
                  }}
                />
              ))}
            </ul>
          )}

          {items.length > 0 ? (
            <div className="flex items-center justify-between gap-2 border-t border-edge-subtle bg-surface-sunken/60 px-3 py-2 text-[11px]">
              <button
                type="button"
                onClick={markAllRead}
                disabled={unreadCount === 0}
                className={cn(
                  'rounded px-2 py-1 font-medium transition-colors',
                  unreadCount === 0
                    ? 'cursor-not-allowed text-content-subtle'
                    : 'text-content-muted hover:bg-surface-raised hover:text-content',
                )}
              >
                Mark all as read
              </button>
              <button
                type="button"
                onClick={dismissAll}
                className="rounded px-2 py-1 font-medium text-content-muted transition-colors hover:bg-surface-raised hover:text-content"
              >
                Clear all
              </button>
            </div>
          ) : null}
        </Dropdown>
      ) : null}
    </>
  )
}

function FilterTab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick(): void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded px-2 py-1 transition-colors',
        active ? 'bg-surface-raised text-content shadow-sm' : 'text-content-muted hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

function NotificationRow({
  n,
  onRead,
  onDismiss,
  onOpen,
}: {
  n: Notification
  onRead(): void
  onDismiss(): void
  onOpen(): void
}) {
  const body = (
    <div className="flex items-start gap-2.5">
      <span
        aria-hidden
        className={cn(
          'mt-1.5 h-2 w-2 shrink-0 rounded-full',
          n.kind === 'error'
            ? 'bg-rose-500'
            : n.kind === 'warning'
              ? 'bg-amber-500'
              : n.kind === 'success'
                ? 'bg-emerald-500'
                : 'bg-sky-500',
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div
            className={cn(
              'text-sm leading-snug',
              n.read ? 'text-content-muted' : 'font-medium text-content',
            )}
          >
            {n.title}
          </div>
          {!n.read ? (
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" aria-label="Unread" />
          ) : null}
        </div>
        {n.description ? (
          <div className="mt-0.5 line-clamp-2 text-xs text-content-muted">{n.description}</div>
        ) : null}
        <div className="mt-1 flex items-center gap-2 text-[11px] text-content-subtle">
          <span>{safeRelative(n.at)}</span>
          {n.href ? <IconArrowRight /> : null}
        </div>
      </div>
    </div>
  )

  const Wrap = ({ children }: { children: React.ReactNode }) =>
    n.href ? (
      <a
        href={n.href}
        target={n.href.startsWith('http') ? '_blank' : undefined}
        rel={n.href.startsWith('http') ? 'noreferrer' : undefined}
        onClick={onOpen}
        className="block"
      >
        {children}
      </a>
    ) : (
      <button type="button" onClick={onRead} className="block w-full text-left">
        {children}
      </button>
    )

  return (
    <li
      className={cn(
        'group relative transition-colors',
        !n.read && 'bg-surface-sunken/60',
        'hover:bg-surface-sunken',
      )}
    >
      <Wrap>
        <div className="px-3 py-2.5">{body}</div>
      </Wrap>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          onDismiss()
        }}
        aria-label="Dismiss"
        className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded text-content-subtle opacity-0 transition-opacity hover:bg-surface-raised hover:text-content-muted group-hover:opacity-100"
      >
        <IconX />
      </button>
    </li>
  )
}

function UserMenu({ user, onSignOut }: { user: User; onSignOut?(): void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          'flex h-9 items-center gap-2 rounded-lg pl-1 pr-1.5 transition-colors',
          open
            ? 'bg-surface-sunken'
            : 'hover:bg-surface-sunken',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/25',
        )}
      >
        <Avatar name={user.name} size="sm" />
        <div className="hidden text-left sm:block">
          <div className="text-sm font-medium leading-none text-content">{user.name}</div>
          <div className="mt-0.5 text-[11px] capitalize text-content-muted">{user.roles[0]}</div>
        </div>
        <IconChevronDown />
      </button>
      {open ? (
        <Dropdown onClose={() => setOpen(false)} anchorRef={ref} widthClass="w-72">
          <div className="relative overflow-hidden border-b border-edge-subtle bg-linear-to-br from-brand-50/70 dark:from-brand-500/10 via-surface-raised to-surface-raised px-3.5 py-3">
            <div
              className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full bg-brand-100/40 dark:bg-brand-500/15 blur-2xl"
              aria-hidden
            />
            <div className="relative flex items-center gap-3">
              <Avatar name={user.name} size="md" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-content">{user.name}</div>
                <div className="truncate text-[11px] text-content-muted">{user.email}</div>
                {user.roles.length ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {user.roles.slice(0, 2).map((r) => (
                      <span
                        key={r}
                        className="rounded-md bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium capitalize text-content-muted ring-1 ring-edge-subtle"
                      >
                        {r.replace(/-/g, ' ')}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <div className="py-1">
            <DropdownLink to="/profile" icon={<IconUser />} onNavigate={() => setOpen(false)}>
              Your profile
            </DropdownLink>
            <DropdownLink to="/settings" icon={<IconSettings />} onNavigate={() => setOpen(false)}>
              Organization settings
            </DropdownLink>
            <DropdownLink to="/status" icon={<IconActivity />} onNavigate={() => setOpen(false)}>
              Platform status
            </DropdownLink>
          </div>
          <DropdownDivider />
          <div className="py-1">
            {onSignOut ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  onSignOut()
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-medium text-rose-700 dark:text-rose-300 transition-colors hover:bg-rose-50 dark:hover:bg-rose-500/10"
              >
                <span className="text-rose-500">
                  <IconSignOut />
                </span>
                Sign out
              </button>
            ) : (
              <Link
                to="/auth/logout"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-3 py-2 text-sm font-medium text-rose-700 dark:text-rose-300 transition-colors hover:bg-rose-50 dark:hover:bg-rose-500/10"
              >
                <span className="text-rose-500">
                  <IconSignOut />
                </span>
                Sign out
              </Link>
            )}
          </div>
        </Dropdown>
      ) : null}
    </>
  )
}

function Avatar({ name, size = 'sm' }: { name: string; size?: 'sm' | 'md' }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase()
  return (
    <div
      className={cn(
        'flex items-center justify-center rounded-full bg-linear-to-br from-brand-500 via-brand-600 to-brand-800 text-xs font-semibold text-white ring-2 ring-white shadow-sm',
        size === 'sm' ? 'h-7 w-7' : 'h-10 w-10 text-sm',
      )}
    >
      {initials || name.slice(0, 2).toUpperCase()}
    </div>
  )
}

function Dropdown({
  children,
  onClose,
  anchorRef,
  widthClass = 'w-56',
  align = 'right',
}: {
  children: React.ReactNode
  onClose(): void
  /** The trigger button — used to anchor positioning + skip outside-click. */
  anchorRef: RefObject<HTMLElement | null>
  widthClass?: string
  align?: 'right' | 'left'
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; right: number } | null>(null)

  useEffect(() => {
    const update = () => {
      const a = anchorRef.current
      if (!a) return
      const rect = a.getBoundingClientRect()
      setPos({
        top: rect.bottom + 8,
        left: rect.left,
        right: window.innerWidth - rect.right,
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchorRef])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (panelRef.current?.contains(t)) return
      if (anchorRef.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [anchorRef, onClose])

  if (typeof document === 'undefined' || !pos) return null

  const style: React.CSSProperties =
    align === 'right' ? { top: pos.top, right: pos.right } : { top: pos.top, left: pos.left }

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      style={style}
      className={cn(
        'fixed z-[60] overflow-hidden rounded-xl border border-edge-default bg-surface-raised py-1 shadow-xl ring-1 ring-edge-default',
        widthClass,
      )}
    >
      {children}
    </div>,
    document.body,
  )
}

function DropdownLink({
  to,
  icon,
  onNavigate,
  children,
}: {
  to: string
  icon?: React.ReactNode
  onNavigate?(): void
  children: React.ReactNode
}) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      className="group flex items-center gap-2.5 px-3 py-2 text-sm text-content transition-colors hover:bg-surface-sunken"
    >
      {icon ? (
        <span className="flex h-5 w-5 items-center justify-center text-content-subtle transition-colors group-hover:text-brand-600">
          {icon}
        </span>
      ) : null}
      <span className="flex-1">{children}</span>
    </Link>
  )
}

function DropdownAnchor({
  href,
  external,
  icon,
  children,
}: {
  href: string
  external?: boolean
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <a
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noreferrer' : undefined}
      className="group flex items-center gap-2.5 px-3 py-2 text-sm text-content transition-colors hover:bg-surface-sunken"
    >
      {icon ? (
        <span className="flex h-5 w-5 items-center justify-center text-content-subtle transition-colors group-hover:text-brand-600">
          {icon}
        </span>
      ) : null}
      <span className="flex-1">{children}</span>
      {external ? <span className="text-content-subtle">↗</span> : null}
    </a>
  )
}

function DropdownDivider() {
  return <div className="my-1 border-t border-edge-subtle" />
}

function safeRelative(at: string): string {
  try {
    return formatRelative(at)
  } catch {
    return at
  }
}

/* ─────────────────── inline SVG icons ─────────────────── */

function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

function IconQuestion() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </svg>
  )
}

function IconBell() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  )
}

function IconChevronDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-content-subtle">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function IconMenu() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </svg>
  )
}

function IconCheck() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function IconX() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function IconArrowRight() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}

function IconUser() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  )
}

function IconSettings() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function IconActivity() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  )
}

function IconSignOut() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" x2="9" y1="12" y2="12" />
    </svg>
  )
}

function IconBookOpen() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2Z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7Z" />
    </svg>
  )
}

function IconSparkle() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M3 12h4" />
      <path d="M17 12h4" />
      <path d="m5.6 5.6 2.8 2.8" />
      <path d="m15.6 15.6 2.8 2.8" />
      <path d="m18.4 5.6-2.8 2.8" />
      <path d="m8.4 15.6-2.8 2.8" />
    </svg>
  )
}

function IconCompass() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </svg>
  )
}

function IconGlobe() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}
