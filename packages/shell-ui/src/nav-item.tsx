import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useRouterState } from '@tanstack/react-router'
import { cn } from '@adhar-console/utils'
import type { NavBadge, NavItem as TNavItem } from './nav-tree.tsx'
import { ownsDestination } from './nav-ownership.ts'

interface Props {
  item: TNavItem
  depth?: number
  collapsed?: boolean
  userRoles?: string[]
  /** Id of the currently-expanded top-level item (accordion model). */
  expandedId?: string | null
  /** Called with the clicked item's id (or null to collapse). */
  onExpandChange?(id: string | null): void
}

/**
 * Row layout (expanded sidebar):
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ icon   label · description       badge › ▾  │ ← parent item (has children)
 *   ├─────────────────────────────────────────────┤
 *   │   ·   child label                   badge   │ ← sub-item (rail on left)
 *   │   ·   child label                           │
 *   └─────────────────────────────────────────────┘
 *
 * Rules:
 *   - Parent row navigates on click; a small chevron on the **right** edge
 *     toggles expand/collapse. No leading arrow.
 *   - Sub-items align with the parent label (icon column is reserved blank)
 *     and get a subtle vertical rail on the left so the grouping is obvious.
 */
export function NavItem({
  item,
  depth = 0,
  collapsed = false,
  userRoles,
  expandedId,
  onExpandChange,
}: Props) {
  if (item.roles && userRoles && !item.roles.some((r) => userRoles.includes(r))) {
    return null
  }

  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const search = useRouterState({ select: (s) => s.location.search })

  const hasChildren = !!item.children?.length
  const hasActiveDescendant = useMemo(
    () =>
      !!item.children?.some(
        (c) => isItemActive(c, pathname, search) || descendantsActive(c, pathname, search),
      ),
    [item, pathname, search],
  )
  // A parent row highlights as active only when it *is* the current route and
  // none of its children are — otherwise the specific child owns the solid
  // highlight and the parent shows the subtle "has active descendant" style.
  // This keeps parents that share a route+section with their first child (e.g.
  // "Adhar Resources" and its "Catalog" child, both `/platform?catalog`) from
  // lighting up at the same time — the exact behaviour every other group has.
  const isActive = useMemo(
    () => isItemActive(item, pathname, search) && !hasActiveDescendant,
    [item, pathname, search, hasActiveDescendant],
  )

  // Accordion-mode: a single `expandedId` at the sidebar level gates all
  // top-level items. Sub-items (depth > 0) never have their own children in
  // our tree, so they don't participate. Auto-expansion based on the
  // active route lives in the Sidebar — this component just reflects the
  // controlled `expandedId` and lets the user toggle parents manually.
  const expanded = hasChildren && expandedId === item.id

  const toggleExpanded = () => {
    onExpandChange?.(expanded ? null : item.id)
  }

  if (collapsed) {
    return (
      <CollapsedItem
        item={item}
        isActive={isActive || hasActiveDescendant}
        userRoles={userRoles}
        pathname={pathname}
        search={search}
      />
    )
  }

  const isSub = depth > 0
  /**
   * Whether this row wears the highlight.
   *
   * A top-level row keeps it while one of its CHILDREN is the current page —
   * otherwise opening a sub-item made the section it belongs to look inactive,
   * and the only thing marking your place was a small rail beside a row with
   * no other emphasis. The sliding rail already parks on the parent for the
   * same reason (see `data-nav-active` below), so this makes the row it lands
   * on look like it was landed on.
   *
   * Sub-items are excluded: they carry their own ChildRail, and bleeding them
   * to the sidebar edge would break the indent that shows they are nested.
   */
  const highlighted = isActive || (!isSub && hasActiveDescendant)

  return (
    <div>
      {/*
        data-nav-active is how the shuttle (nav-shuttle.tsx) finds the row to
        park its rail against: the attribute must sit on the ROW element, since
        that is the box the rail is measured against.

        TOP-LEVEL ONLY. Sub-items carry their own indicator (ChildRail turns
        brand-coloured when active), so a second full-height rail beside them
        was two marks doing one job. When a sub-item is the current route the
        rail stays on its PARENT — which is what keeps the top-level "you are
        in Deliver" context visible while the child rail says which page.
      */}
      <div
        data-nav-active={!isSub && (isActive || hasActiveDescendant) ? 'true' : undefined}
        className={cn(
          'group relative flex items-center gap-2.5 text-sm',
          'transition-[background-color,color,box-shadow,transform] duration-200 ease-out',
          'active:scale-[0.985] active:duration-75 motion-reduce:transform-none motion-reduce:transition-none',
          // Rows size to their content. A floor was tried here to even out the
          // few rows with no description (Overview, Workspace, Platform
          // status) and it padded them into the same box as two-line rows,
          // which read as loose rather than regular. The rail measures
          // whichever row is active, so it tracks either height correctly
          // without the rows having to match.
          isSub ? 'py-1 pl-3 pr-2' : 'py-1.5 pr-2',
          // The HIGHLIGHTED row bleeds through the nav's own `px-3` to touch the
          // sidebar's left edge: `-ml-3` pulls it out by the 12px of padding,
          // and `pl-5.5` (22px) puts the content back exactly where an
          // unhighlighted row's `pl-2.5` inside that padding would put it — so
          // selecting a row moves the highlight, never the label.
          !isSub && (highlighted ? '-ml-3 pl-5.5' : 'pl-2.5'),
          // A tinted row rather than a solid brand fill. The fill competed with
          // the sliding rail for the same job — two strong marks saying "you are
          // here" — and at 14 rows it made the column read as a stack of
          // buttons. The rail carries the emphasis; the row carries the context.
          highlighted
            ? 'bg-brand-600/12 text-brand-700 dark:bg-brand-400/15 dark:text-brand-100'
            : 'text-content-muted hover:bg-surface-sunken hover:text-content',
          // Only a TOP-LEVEL highlight squares its left corner, because only
          // that one has the sliding rail butted against it to continue the
          // shape. A sub-item has nothing on its left, so squaring it there
          // just read as a clipped corner — it keeps all four.
          highlighted && !isSub ? 'rounded-l-none rounded-r-lg' : 'rounded-lg',
          // The page you are ON is bolder than the section you are IN, so a
          // parent holding the highlight for its open child never looks like
          // the current page itself.
          isActive ? 'font-semibold' : highlighted ? 'font-medium' : '',
        )}
      >
        {isSub ? (
          <ChildRail active={isActive} />
        ) : (
          <IconSlot icon={item.icon} isActive={isActive} hasActiveDescendant={hasActiveDescendant} />
        )}

        <ItemLink
          item={item}
          isActive={isActive}
          isSub={isSub}
          onRowClick={hasChildren ? toggleExpanded : undefined}
        />

        {item.badge !== undefined ? <Badge value={item.badge} active={isActive} /> : null}

        {hasChildren ? (
          <span
            aria-hidden
            className={cn(
              'flex h-5 w-5 shrink-0 items-center justify-center transition-transform duration-150',
              isActive
                ? 'text-brand-600 dark:text-brand-200'
                : 'text-content-subtle group-hover:text-content-muted',
              expanded && 'rotate-180',
            )}
          >
            <ChevronIcon />
          </span>
        ) : null}
      </div>

      {hasChildren ? (
        // Smooth accordion: animate `grid-template-rows` 0fr→1fr so the
        // submenu slides open/closed with no JS height measurement. Children
        // stay mounted; `overflow-hidden` clips them while collapsing.
        <div
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
            expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
          )}
        >
          <div className="overflow-hidden">
            <div
              className={cn(
                'relative mt-0.5 space-y-0.5 pb-1 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                expanded ? 'translate-y-0' : '-translate-y-1',
              )}
            >
              {item.children!.map((child) => (
                <NavItem key={child.id} item={child} depth={depth + 1} userRoles={userRoles} />
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ─── Row pieces ──────────────────────────────────────────────────────── */

function IconSlot({
  icon,
  isActive,
  hasActiveDescendant,
}: {
  icon?: React.ReactNode
  isActive: boolean
  hasActiveDescendant: boolean
}) {
  return (
    <span
      className={cn(
        'flex h-4.5 w-4.5 shrink-0 items-center justify-center transition-colors',
        isActive
          ? 'text-brand-600 dark:text-brand-200'
          : hasActiveDescendant
            ? 'text-brand-700 dark:text-brand-300'
            : 'text-content-subtle group-hover:text-content',
      )}
    >
      {icon ?? <span className="h-1 w-1 rounded-full bg-current opacity-40" aria-hidden />}
    </span>
  )
}

function ChildRail({ active }: { active: boolean }) {
  // Fixed-width spacer that aligns sub-item text with parent text (icon col
  // is 18px + 10px gap = ~28px, rail sits in the middle of that column).
  //
  // The bar is 3px, not 2px. `rounded-full` on a 2px bar is a 1px radius —
  // technically round, visibly square. 3px is the narrowest width at which the
  // cap actually reads, and it matches the top-level rail's weight. The
  // margins absorb the extra pixel (8 + 3 + 13 = 24) so sub-item text stays
  // exactly where it was.
  return (
    <span
      aria-hidden
      className="relative ml-2 mr-3.25 flex h-5 w-[3px] shrink-0 items-center justify-center"
    >
      <span
        className={cn(
          'absolute inset-y-0 left-0 w-[3px] rounded-full transition-colors',
          // Warm, against the top-level rail's cool brand ramp. The two rails
          // are the same shape at different indents, so hue is what separates
          // them — blue flush at the edge for the section you are in, amber
          // indented for the page you are on.
          active ? 'bg-amber-400' : 'bg-edge-default group-hover:bg-edge-strong',
        )}
      />
    </span>
  )
}

function ItemLink({
  item,
  isActive,
  isSub,
  onRowClick,
}: {
  item: TNavItem
  isActive: boolean
  isSub: boolean
  /** Called in addition to navigation — used to expand/collapse parents. */
  onRowClick?: () => void
}) {
  const label = (
    <div className="min-w-0 flex-1">
      <div className="truncate leading-tight">{item.label}</div>
      {!isSub && item.description ? (
        <div
          className={cn(
            'mt-0.5 truncate text-[11px] font-normal leading-tight',
            isActive ? 'text-brand-700/70 dark:text-brand-100/70' : 'text-content-subtle',
          )}
        >
          {item.description}
        </div>
      ) : null}
    </div>
  )

  // No `to` and no row action → static label (unusual).
  if (!item.to && !onRowClick) return label

  // No `to` but has children → clicking toggles expand via the wrapper button.
  if (!item.to && onRowClick) {
    return (
      <button
        type="button"
        onClick={onRowClick}
        className="flex min-w-0 flex-1 items-center rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-500/25"
      >
        {label}
      </button>
    )
  }

  // Has `to` → navigate on click, AND expand when the parent has children.
  // cmd/ctrl-click keeps default browser behavior (new tab) without expanding.
  return (
    <Link
      to={item.to!}
      search={{ section: item.search } as never}
      aria-current={isActive ? 'page' : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        onRowClick?.()
      }}
      className="flex min-w-0 flex-1 items-center rounded outline-none focus-visible:ring-2 focus-visible:ring-brand-500/25"
    >
      {label}
    </Link>
  )
}

function CollapsedItem({
  item,
  isActive,
  userRoles,
  pathname,
  search,
}: {
  item: TNavItem
  isActive: boolean
  userRoles?: string[]
  pathname: string
  search: Record<string, unknown>
}) {
  const triggerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const closeTimer = useRef<number | null>(null)

  const hasChildren = !!item.children?.length

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const scheduleOpen = () => {
    cancelClose()
    setOpen(true)
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(false), 90)
  }

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const r = triggerRef.current?.getBoundingClientRect()
      if (!r) return
      setPos({ top: r.top, left: r.right + 10 })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [open])

  useEffect(() => {
    return () => cancelClose()
  }, [])

  const icon = (
    <span
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-200 ease-out',
        'hover:scale-105 active:scale-95 motion-reduce:transform-none motion-reduce:transition-none',
        '[&>svg]:h-[18px] [&>svg]:w-[18px]',
        isActive
          ? 'bg-brand-600 text-white shadow-sm ring-1 ring-inset ring-white/10'
          : 'text-content-muted hover:bg-surface-sunken hover:text-content',
      )}
    >
      {item.icon ?? <span className="h-1.5 w-1.5 rounded-full bg-current opacity-50" />}
    </span>
  )

  const trigger = item.to ? (
    <Link
      to={item.to}
      search={{ section: item.search } as never}
      className="block"
      aria-label={item.label}
      aria-current={isActive ? 'page' : undefined}
      onClick={() => setOpen(false)}
    >
      {icon}
    </Link>
  ) : (
    icon
  )

  return (
    <div
      ref={triggerRef}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocus={scheduleOpen}
      onBlur={scheduleClose}
      className="relative"
    >
      {trigger}
      {open && pos
        ? createPortal(
            <div
              onMouseEnter={scheduleOpen}
              onMouseLeave={scheduleClose}
              style={{ top: pos.top, left: pos.left }}
              role={hasChildren ? 'menu' : 'tooltip'}
              className="fixed z-[55]"
            >
              {hasChildren ? (
                <FlyoutPanel
                  item={item}
                  userRoles={userRoles}
                  pathname={pathname}
                  search={search}
                  onNavigate={() => setOpen(false)}
                />
              ) : (
                <TooltipBubble label={item.label} description={item.description} />
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

function TooltipBubble({ label, description }: { label: string; description?: string }) {
  return (
    <div className="pointer-events-none -translate-y-1.5 overflow-hidden rounded-lg bg-slate-900 px-2.5 py-1.5 text-white shadow-lg ring-1 ring-black/5">
      <div className="text-[12px] font-medium leading-tight">{label}</div>
      {description ? (
        <div className="mt-0.5 text-[11px] leading-tight text-slate-300">{description}</div>
      ) : null}
    </div>
  )
}

function FlyoutPanel({
  item,
  userRoles,
  pathname,
  search,
  onNavigate,
}: {
  item: TNavItem
  userRoles?: string[]
  pathname: string
  search: Record<string, unknown>
  onNavigate(): void
}) {
  return (
    <div className="-translate-y-2 overflow-hidden rounded-xl border border-edge-default bg-surface-raised py-1.5 shadow-xl ring-1 ring-edge-default w-60">
      <div className="flex items-center gap-2 border-b border-edge-subtle px-3 pb-2 pt-1">
        <span className="flex h-5 w-5 items-center justify-center text-brand-700 dark:text-brand-300 [&>svg]:h-4 [&>svg]:w-4">
          {item.icon}
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-content">{item.label}</div>
          {item.description ? (
            <div className="truncate text-[11px] text-content-muted">{item.description}</div>
          ) : null}
        </div>
      </div>
      <ul className="max-h-[60vh] overflow-y-auto py-1">
        {item.children!.map((child) => {
          if (child.roles && userRoles && !child.roles.some((r) => userRoles.includes(r))) {
            return null
          }
          const childActive =
            isChildActive(child, pathname, search) || descendantsActive(child, pathname, search)
          return (
            <li key={child.id}>
              <Link
                to={child.to ?? item.to ?? '/'}
                search={{ section: child.search } as never}
                onClick={onNavigate}
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 text-[13px] transition-colors',
                  childActive
                    ? 'bg-brand-50 dark:bg-brand-500/10 font-semibold text-brand-800 dark:text-brand-300'
                    : 'text-content hover:bg-surface-sunken',
                )}
              >
                <span className="flex-1 truncate">{child.label}</span>
                {child.badge !== undefined ? <Badge value={child.badge} active={childActive} /> : null}
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function isChildActive(
  item: TNavItem,
  pathname: string,
  search: Record<string, unknown>,
): boolean {
  if (!item.to) return false
  if (item.to === '/') return pathname === '/'
  if (pathname !== item.to && !pathname.startsWith(item.to + '/')) return false
  if (item.search) return (search as { section?: string }).section === item.search
  return true
}

function Badge({ value, active }: { value: NavBadge; active: boolean }) {
  const base =
    'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none tabular-nums'
  if (typeof value === 'string' || typeof value === 'number') {
    return (
      <span
        className={cn(
          base,
          active
            ? 'bg-brand-600/20 text-brand-800 dark:bg-brand-300/20 dark:text-brand-100'
            : 'bg-surface-sunken text-content-muted',
        )}
      >
        {value}
      </span>
    )
  }
  const toneMap: Record<typeof value.kind, string> = {
    healthy: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
    degraded: 'bg-rose-100 dark:bg-rose-500/15 text-rose-800 dark:text-rose-300',
    progressing: 'bg-indigo-100 dark:bg-indigo-500/15 text-indigo-800 dark:text-indigo-300',
    paused: 'bg-amber-100 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300',
    failed: 'bg-rose-200 dark:bg-rose-500/15 text-rose-900 dark:text-rose-200',
    unknown: 'bg-surface-sunken text-content-muted',
    info: 'bg-sky-100 dark:bg-sky-500/15 text-sky-800 dark:text-sky-300',
  }
  return (
    <span
      className={cn(
        base,
        active
          ? 'bg-brand-600/20 text-brand-800 dark:bg-brand-300/20 dark:text-brand-100'
          : toneMap[value.kind],
      )}
    >
      {value.value}
    </span>
  )
}

function ChevronIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

export function isItemActive(
  item: TNavItem,
  pathname: string,
  search: Record<string, unknown>,
): boolean {
  if (!item.to) return false
  // A cross-link borrows another group's page and never owns the highlight, so a
  // single URL always resolves to exactly one active row (nav-ownership.ts).
  if (!ownsDestination(item)) return false
  if (item.to === '/') {
    if (pathname !== '/') return false
  } else if (pathname !== item.to && !pathname.startsWith(item.to + '/')) {
    return false
  }
  if (item.search) {
    return (search as { section?: string }).section === item.search
  }
  return !('section' in search)
}

function descendantsActive(
  item: TNavItem,
  pathname: string,
  search: Record<string, unknown>,
): boolean {
  return (item.children ?? []).some(
    (c) => isItemActive(c, pathname, search) || descendantsActive(c, pathname, search),
  )
}

export function hasActiveDescendant(
  item: TNavItem,
  pathname: string,
  search: Record<string, unknown>,
): boolean {
  return descendantsActive(item, pathname, search)
}
