import { useEffect, useState, type ReactNode } from 'react'
import { Sidebar } from './sidebar.tsx'
import { Topbar } from './topbar.tsx'
import { ErrorBoundary } from './error-boundary.tsx'
import { CommandPalette, type CommandItem } from './command-palette.tsx'
import { cn } from '@adhar-console/utils'
import type { NavSection } from './nav-tree.tsx'
import type { AppLink } from './app-launcher.tsx'
import type { Notification } from './notifications.ts'
import type { Tenant } from '@adhar-console/tenancy'
import type { User } from '@adhar-console/auth'

/** @deprecated breadcrumbs were removed; the prop is accepted but ignored. */
type LegacyCrumb = { label: string; to?: string }

interface Props {
  children: ReactNode
  user: User
  tenants: Tenant[]
  activeTenantId: string
  onTenantChange(id: string): void
  /** @deprecated ignored — breadcrumbs are no longer rendered. */
  crumbs?: LegacyCrumb[]
  onSignOut?(): void
  notifications?: Notification[]
  /** Override the default app-launcher entries (usually supplied by the BFF). */
  apps?: AppLink[]
  /** Override the default nav tree. Forwarded to <Sidebar /> + <CommandPalette />. */
  sections?: NavSection[]
  /** Extra command-palette items — merged with items derived from `sections`. */
  commandItems?: CommandItem[]
  /** Enable the ⌘K command palette. Defaults to true. */
  commandPaletteEnabled?: boolean
  /**
   * Content width:
   *   • `standard` (default) — `max-w-7xl`, the right size for forms + tables.
   *   • `wide` — `max-w-screen-2xl`, for dense dashboards (Decide / Platform).
   *   • `full` — `max-w-none`, for full-bleed boards (Define Kanban, Discover).
   */
  contentWidth?: 'standard' | 'wide' | 'full'
}

const CONTENT_WIDTH_CLASS = {
  standard: 'max-w-7xl',
  wide: 'max-w-screen-2xl',
  full: 'max-w-none',
} as const

export function AppShell({
  children,
  user,
  tenants,
  activeTenantId,
  onTenantChange,
  onSignOut,
  notifications,
  apps,
  sections,
  commandItems,
  commandPaletteEnabled = true,
  contentWidth = 'standard',
}: Props) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const openPalette = commandPaletteEnabled ? () => setPaletteOpen(true) : undefined

  // Close the mobile drawer if the viewport grows past lg — the sidebar
  // becomes permanent and the overlay would otherwise trap clicks.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(min-width: 1024px)')
    const onChange = () => {
      if (mq.matches) setMobileOpen(false)
    }
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  // Lock body scroll while the mobile sidebar drawer is open.
  useEffect(() => {
    if (typeof document === 'undefined') return
    if (mobileOpen) {
      const prev = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      return () => {
        document.body.style.overflow = prev
      }
    }
  }, [mobileOpen])

  // ESC closes the mobile drawer.
  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mobileOpen])

  return (
    <div className="flex h-screen bg-surface-app text-content">
      {/* Permanent sidebar — shown at lg and above. The wrapper is given a
          stacking context (`relative z-30`) so the collapsed-state expand
          pull-tab (which half-protrudes past the sidebar's right edge)
          renders above the adjacent topbar + main content area. The topbar
          itself uses `sticky z-40` and lives inside the sibling column —
          which we `isolate` further down so its z-40 stays scoped there. */}
      <div className="relative z-30 hidden lg:flex">
        <Sidebar
          tenants={tenants}
          activeTenantId={activeTenantId}
          onTenantChange={onTenantChange}
          sections={sections}
          collapsed={sidebarCollapsed}
          onCollapseChange={setSidebarCollapsed}
          user={user}
          onSignOut={onSignOut}
          onOpenCommandPalette={openPalette}
        />
      </div>

      {/* Mobile slide-over — always rendered so transitions can animate. */}
      <div
        className={cn(
          'fixed inset-0 z-50 flex lg:hidden',
          mobileOpen ? 'pointer-events-auto' : 'pointer-events-none',
        )}
        role="dialog"
        aria-modal={mobileOpen}
        aria-label="Primary navigation"
      >
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
          className={cn(
            'absolute inset-0 bg-slate-900/40 backdrop-blur-[2px] transition-opacity duration-200 ease-smooth',
            mobileOpen ? 'opacity-100' : 'opacity-0',
          )}
        />
        <div
          className={cn(
            'relative flex w-70 max-w-[calc(100vw-3.5rem)] shrink-0 transform-gpu transition-transform duration-250 ease-smooth',
            mobileOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full',
          )}
        >
          <Sidebar
            tenants={tenants}
            activeTenantId={activeTenantId}
            onTenantChange={(id) => {
              onTenantChange(id)
              setMobileOpen(false)
            }}
            sections={sections}
            collapsed={false}
            onCollapseChange={() => {}}
            user={user}
            onSignOut={onSignOut}
            onOpenCommandPalette={openPalette}
          />
        </div>
      </div>

      <div className="isolate flex min-w-0 flex-1 flex-col">
        <Topbar
          user={user}
          notifications={notifications}
          apps={apps}
          onSignOut={onSignOut}
          onOpenCommandPalette={openPalette}
          onOpenSidebar={() => setMobileOpen(true)}
        />
        <main className="isolate flex-1 overflow-y-auto">
          <ErrorBoundary>
            <div
              className={cn(
                'mx-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-8',
                CONTENT_WIDTH_CLASS[contentWidth],
              )}
            >
              {children}
            </div>
          </ErrorBoundary>
        </main>
      </div>

      {commandPaletteEnabled ? (
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          sections={sections}
          items={commandItems}
        />
      ) : null}
    </div>
  )
}
