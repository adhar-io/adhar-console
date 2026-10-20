import { useState } from 'react'
import { Skeleton } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { type FlatCollection, Icon } from './bi-kit.tsx'

/**
 * The collections rail shared by the dashboard and question libraries: a
 * collapsible tree with per-collection counts on desktop, a select on
 * narrow screens.
 */

export function CollectionRail({
  collections,
  counts,
  total,
  active,
  filterActive,
  onPick,
  loading,
  allLabel = 'All dashboards',
}: {
  collections: FlatCollection[]
  counts: Map<string, number>
  total: number
  active: number | 'root' | null
  filterActive: boolean
  onPick(c: 'all' | number | 'root'): void
  loading: boolean
  allLabel?: string
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // Hide the subtree of collapsed collections.
  const visible: FlatCollection[] = []
  let hideBelow: number | null = null
  for (const c of collections) {
    if (hideBelow != null && c.depth > hideBelow) continue
    hideBelow = null
    visible.push(c)
    if (collapsed.has(String(c.id))) hideBelow = c.depth
  }
  const hasKids = (i: number) => collections[i + 1] && collections[i + 1].depth > collections[i].depth
  return (
    <>
      {/* Phone / tablet: a select instead of the rail. */}
      <div className="lg:hidden">
        <select
          aria-label="Collection"
          value={active == null ? 'all' : String(active)}
          onChange={(e) => onPick(e.target.value === 'all' ? 'all' : e.target.value === 'root' ? 'root' : Number(e.target.value))}
          className="h-9 w-full rounded-md border border-edge-default bg-surface-raised px-2 text-sm text-content"
        >
          <option value="all">{allLabel} ({total})</option>
          {collections.map((c) => (
            <option key={String(c.id)} value={String(c.id)}>
              {' '.repeat(c.depth)}
              {c.name} ({counts.get(String(c.id)) ?? 0})
            </option>
          ))}
        </select>
      </div>
      <nav aria-label="Collections" className="hidden lg:block">
        <div className="sticky top-4 max-h-[calc(100vh-8rem)] overflow-y-auto pr-1">
          <RailItem label={allLabel} count={total} active={active == null && !filterActive} depth={0} icon="dashboard" onClick={() => onPick('all')} />
          <div className="my-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Collections</div>
          {loading ? (
            <div className="space-y-2 px-2">
              <Skeleton width="80%" height={10} />
              <Skeleton width="60%" height={10} />
            </div>
          ) : (
            visible.map((c) => {
              const i = collections.indexOf(c)
              const key = String(c.id)
              return (
                <RailItem
                  key={key}
                  label={c.name}
                  count={counts.get(key) ?? 0}
                  active={active != null && String(active) === key}
                  depth={c.depth}
                  icon={c.personal ? 'user' : 'folder'}
                  official={c.official}
                  expandable={!!hasKids(i)}
                  expanded={!collapsed.has(key)}
                  onToggle={() =>
                    setCollapsed((s) => {
                      const n = new Set(s)
                      if (n.has(key)) n.delete(key)
                      else n.add(key)
                      return n
                    })}
                  onClick={() => onPick(c.id)}
                />
              )
            })
          )}
        </div>
      </nav>
    </>
  )
}

function RailItem({
  label,
  count,
  active,
  depth,
  icon,
  official,
  expandable,
  expanded,
  onToggle,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  depth: number
  icon: 'dashboard' | 'folder' | 'user'
  official?: boolean
  expandable?: boolean
  expanded?: boolean
  onToggle?(): void
  onClick(): void
}) {
  return (
    <div className={cn('group flex items-center rounded-md', active ? 'bg-brand-50 dark:bg-brand-500/15' : 'hover:bg-surface-sunken')} style={{ paddingLeft: depth * 12 }}>
      {expandable ? (
        <button type="button" onClick={onToggle} aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`} className="flex h-7 w-5 items-center justify-center text-content-subtle hover:text-content">
          <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} />
        </button>
      ) : (
        <span className="w-5" />
      )}
      <button type="button" onClick={onClick} aria-current={active ? 'true' : undefined} className={cn('flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left text-[13px]', active ? 'font-medium text-brand-800 dark:text-brand-200' : 'text-content')}>
        <Icon name={icon} size={14} className={cn(official ? 'text-amber-600 dark:text-amber-300' : 'text-content-subtle')} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="text-[11px] tabular-nums text-content-subtle">{count || ''}</span>
      </button>
    </div>
  )
}

