import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { cn } from '@adhar-console/utils'
import type { Tenant } from '@adhar-console/tenancy'
import type { User } from '@adhar-console/auth'
import { TenantSwitcher } from './tenant-switcher.tsx'
import { hasActiveDescendant, isItemActive, NavItem } from './nav-item.tsx'
import { DEFAULT_NAV, type NavItem as TNavItem, type NavSection } from './nav-tree.tsx'
import { filterNavByRole, useConsoleRole } from './roles.ts'
import { AdharSymbol, AdharWordmarkStack } from './brand.tsx'

interface Props {
  tenants: Tenant[]
  activeTenantId: string
  onTenantChange(id: string): void
  /** Override the default nav tree. Falls back to `DEFAULT_NAV`. */
  sections?: NavSection[]
  /** Controlled collapse state. When omitted the component manages its own. */
  collapsed?: boolean
  onCollapseChange?(collapsed: boolean): void
  /** User is only used for role-based menu filtering — the user menu lives in the Topbar. */
  user?: User
  onSignOut?(): void
  /** Wires the ⌘K keyboard shortcut. The visible trigger lives in the Topbar. */
  onOpenCommandPalette?(): void
}

/**
 * Sidebar layout
 * ─────────────────────────────────────────────
 *   ┌──────────────────────────┐
 *   │  Header (logo + toggle)  │
 *   ├──────────────────────────┤
 *   │                          │
 *   │  Nav (scrolls)           │
 *   │                          │
 *   ├──────────────────────────┤
 *   │  Tenant switcher         │
 *   └──────────────────────────┘
 *
 * User menu + search both live in the Topbar — keep the sidebar focused on
 * navigation.
 */
export function Sidebar({
  tenants,
  activeTenantId,
  onTenantChange,
  sections = DEFAULT_NAV,
  collapsed: controlledCollapsed,
  onCollapseChange,
  user,
  onOpenCommandPalette,
}: Props) {
  const [internalCollapsed, setInternalCollapsed] = useState(false)
  const collapsed = controlledCollapsed ?? internalCollapsed

  /*
   * Role-aware nav: resolve the console persona (session first, `user` prop
   * as fallback, `viewer` when anonymous) and prune the tree up-front so the
   * accordion, keyboard shortcuts and rendering all agree on what exists.
   * Items without a `roles` annotation stay visible to everyone; the raw
   * `user.roles` are passed through so legacy Keycloak-role annotations on
   * custom trees keep matching.
   */
  const role = useConsoleRole(user)
  const visibleSections = useMemo(
    () => filterNavByRole(sections, role, user?.roles),
    [sections, role, user?.roles],
  )

  /*
   * Accordion expansion is derived from the active route — whichever
   * parent owns the current page is the one that auto-expands. The user
   * can manually override (chevron click) but a route change to a
   * different parent's domain trumps the manual choice. This prevents
   * stale parents (Kubernetes was previously hard-coded as
   * `defaultExpanded`) from staying open when the user navigates to a
   * different section like Workspace settings.
   */
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const routeSearch = useRouterState({ select: (s) => s.location.search })

  const autoExpandedId = useMemo<string | null>(() => {
    for (const section of visibleSections) {
      for (const item of section.items) {
        if (!item.children?.length) continue
        const hasActiveChild = item.children.some((c) =>
          isItemActive(c, pathname, routeSearch as Record<string, unknown>) ||
          hasActiveDescendant(c, pathname, routeSearch as Record<string, unknown>),
        )
        const isParentActive = isItemActive(item, pathname, routeSearch as Record<string, unknown>)
        if (hasActiveChild || isParentActive) return item.id
      }
    }
    return null
  }, [visibleSections, pathname, routeSearch])

  // Single source of truth for which parent is expanded. The auto-expand
  // computed from the active route seeds it on initial render and on every
  // route change; clicking a parent overrides freely until the route shifts.
  // This lets the user collapse the auto-expanded parent (and re-open it).
  const [expandedId, setExpandedId] = useState<string | null>(autoExpandedId)
  useEffect(() => {
    setExpandedId(autoExpandedId)
  }, [autoExpandedId])

  const toggleCollapsed = () => {
    const next = !collapsed
    if (onCollapseChange) onCollapseChange(next)
    else setInternalCollapsed(next)
  }

  // ⌘K listener lives here so it fires even when the Topbar button is
  // invisible on smaller viewports.
  useEffect(() => {
    if (!onOpenCommandPalette) return
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        onOpenCommandPalette()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onOpenCommandPalette])

  // Two-key Vim-style shortcut sequences declared on nav items via the
  // `shortcut` field (e.g. "g h"). The dispatcher is global so the user
  // can fire shortcuts from anywhere except inside an editable element.
  const navigate = useNavigate()
  const lastKeyRef = useRef<{ key: string; at: number } | null>(null)
  const shortcutsMap = useMemo(() => {
    const m = new Map<string, TNavItem>()
    const walk = (items: TNavItem[]) => {
      for (const it of items) {
        if (it.shortcut) m.set(it.shortcut.toLowerCase().replace(/\s+/g, ' ').trim(), it)
        if (it.children?.length) walk(it.children)
      }
    }
    for (const s of visibleSections) walk(s.items)
    return m
  }, [visibleSections])

  useEffect(() => {
    if (!shortcutsMap.size) return
    const onKey = (e: KeyboardEvent) => {
      // Bail when typing — the palette / inputs / textareas / contenteditable.
      const eventTarget = e.target as HTMLElement | null
      if (
        eventTarget &&
        (eventTarget.tagName === 'INPUT' ||
          eventTarget.tagName === 'TEXTAREA' ||
          eventTarget.tagName === 'SELECT' ||
          eventTarget.isContentEditable)
      ) {
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key.length !== 1) return
      const now = performance.now()
      const ch = e.key.toLowerCase()
      const prev = lastKeyRef.current
      if (prev && now - prev.at < 1200) {
        const seq = `${prev.key} ${ch}`
        const matched = shortcutsMap.get(seq)
        if (matched?.to) {
          e.preventDefault()
          lastKeyRef.current = null
          navigate({
            to: matched.to,
            search: matched.search ? ({ section: matched.search } as never) : undefined,
          })
          return
        }
      }
      lastKeyRef.current = { key: ch, at: now }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcutsMap, navigate])

  return (
    <aside
      className={cn(
        'relative z-20 flex h-full shrink-0 flex-col border-r border-edge-default bg-surface-sidebar',
        'transition-[width] duration-300 ease-in-out',
        collapsed ? 'w-16' : 'w-64',
      )}
    >
      <Header collapsed={collapsed} onToggle={toggleCollapsed} />

      <nav
        aria-label="Primary navigation"
        className={cn(
          // Hide the scrollbar visually but keep wheel / trackpad / keyboard
          // scrolling. `scrollbar-width: none` covers Firefox;
          // `::-webkit-scrollbar { display: none }` covers Chromium + Safari.
          // `overscroll-contain` stops scroll-chaining into the main content.
          'sidebar-scroll flex-1 overflow-y-auto overscroll-contain',
          collapsed ? 'px-2 py-3' : 'px-3 pb-4 pt-2',
        )}
      >
        {visibleSections.map((section, i) => (
          <Section
            key={section.id}
            section={section}
            collapsed={collapsed}
            isFirst={i === 0}
            expandedId={expandedId}
            onExpandChange={setExpandedId}
          />
        ))}
      </nav>

      <Footer
        collapsed={collapsed}
        tenants={tenants}
        activeTenantId={activeTenantId}
        onTenantChange={onTenantChange}
      />
    </aside>
  )
}

function Header({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle(): void
}) {
  return (
    <div
      className={cn(
        'relative shrink-0 border-b border-edge-default bg-surface-raised/70 backdrop-blur-sm',
        collapsed
          ? 'flex h-14 items-center justify-center px-2'
          : 'flex h-14 items-center justify-between pl-4 pr-2',
      )}
    >
      <Link
        to="/"
        aria-label="Adhar Console — home"
        className="group flex min-w-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand-500/25"
      >
        <div className="shrink-0 transition-transform duration-200 ease-out group-hover:scale-105">
          <AdharSymbol size={36} />
        </div>
        <div
          className={cn(
            'min-w-0 origin-left transition-all duration-300 ease-out',
            collapsed
              ? 'pointer-events-none w-0 -translate-x-1 scale-95 opacity-0'
              : 'translate-x-0 scale-100 opacity-100',
          )}
          aria-hidden={collapsed}
        >
          <AdharWordmarkStack fontSize={17} subtitle="Console" />
        </div>
      </Link>
      {collapsed ? (
        <button
          type="button"
          onClick={onToggle}
          aria-label="Expand sidebar"
          title="Expand sidebar"
          className={cn(
            'absolute top-1/2 -right-3.5 z-30 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full',
            'border border-edge-default bg-surface-raised text-content-muted shadow-md transition-all duration-200',
            'hover:scale-105 hover:border-brand-300 hover:text-brand-700 dark:hover:text-brand-300 hover:shadow-lg',
          )}
        >
          <IconChevronsRight />
        </button>
      ) : (
        <button
          type="button"
          onClick={onToggle}
          aria-label="Collapse sidebar"
          className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-surface-sunken hover:text-content"
        >
          <IconSidebarCollapse />
        </button>
      )}
    </div>
  )
}

function Section({
  section,
  collapsed,
  isFirst,
  expandedId,
  onExpandChange,
}: {
  section: NavSection
  collapsed: boolean
  isFirst: boolean
  expandedId: string | null
  onExpandChange(id: string | null): void
}) {
  if (collapsed) {
    return (
      <div
        className={cn(
          'flex flex-col items-center',
          !isFirst && 'mt-2 pt-2',
        )}
      >
        {!isFirst ? (
          <span aria-hidden className="mb-2 h-px w-6 rounded-full bg-edge-subtle" />
        ) : null}
        <div className="space-y-1">
          {section.items.map((item) => (
            <NavItem key={item.id} item={item} collapsed />
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className={cn(!isFirst && 'mt-5', isFirst && 'mt-2')}>
      {section.label ? (
        <div className="mb-1.5 flex items-center gap-2 px-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
            {section.label}
          </span>
          <span className="h-px flex-1 bg-edge-subtle" aria-hidden />
        </div>
      ) : null}
      <div className="space-y-0.5">
        {section.items.map((item) => (
          <NavItem
            key={item.id}
            item={item}
            expandedId={expandedId}
            onExpandChange={onExpandChange}
          />
        ))}
      </div>
    </div>
  )
}

function Footer({
  collapsed,
  tenants,
  activeTenantId,
  onTenantChange,
}: {
  collapsed: boolean
  tenants: Tenant[]
  activeTenantId: string
  onTenantChange(id: string): void
}) {
  if (collapsed) {
    return (
      <div className="flex shrink-0 flex-col items-center gap-2 border-t border-edge-default bg-surface-raised/80 px-2 py-2.5 backdrop-blur-sm">
        <TenantSwitcher
          tenants={tenants}
          activeId={activeTenantId}
          onChange={onTenantChange}
          collapsed
          placement="top"
        />
      </div>
    )
  }
  return (
    <div className="shrink-0 space-y-2 border-t border-edge-default bg-surface-raised/80 p-3 backdrop-blur-sm">
      <TenantSwitcher
        tenants={tenants}
        activeId={activeTenantId}
        onChange={onTenantChange}
        placement="top"
      />
    </div>
  )
}

function IconSidebarCollapse() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d="m14 10-2 2 2 2" />
    </svg>
  )
}

function IconChevronsRight() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m6 17 5-5-5-5" />
      <path d="m13 17 5-5-5-5" />
    </svg>
  )
}


