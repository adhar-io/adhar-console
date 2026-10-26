import { useEffect, useRef, useState } from 'react'
import { cn } from '@adhar/utils'
import { autofocusSearch } from '@adhar/shell-ui'
import { useProjects } from '../data/plane.ts'
import type { plane } from '@adhar/api-clients'
import { projectEmoji, projectIconColor } from '../data/project-cover.ts'

/**
 * Workspace-wide project switcher rendered in every Define page header.
 *
 * Click → dropdown listing every project in the workspace, with the current
 * one badged. ESC + outside-click close. Persists the chosen id via the
 * `useActiveProject` provider in `home.tsx`.
 */
export function ProjectPicker({
  value,
  onChange,
  align = 'right',
  variant = 'title',
  allSelected = false,
  onSelectAll,
}: {
  value?: string
  onChange(id: string): void
  align?: 'left' | 'right'
  /** `title` sits in a page title; `compact` is a toolbar control (button height). */
  variant?: 'title' | 'compact'
  /** When set, the list starts with an "All projects" entry. */
  onSelectAll?(): void
  allSelected?: boolean
}) {
  const q = useProjects()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  const projects = q.data ?? []
  const active = allSelected ? undefined : projects.find((p) => p.id === value)
  const compact = variant === 'compact'
  const filtered = filter.trim()
    ? projects.filter((p) => {
        const f = filter.trim().toLowerCase()
        return (
          p.name.toLowerCase().includes(f) ||
          (p.identifier ?? '').toLowerCase().includes(f)
        )
      })
    : projects

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    globalThis.addEventListener('mousedown', onClick)
    globalThis.addEventListener('keydown', onKey)
    return () => {
      globalThis.removeEventListener('mousedown', onClick)
      globalThis.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (!open) setFilter('')
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={allSelected ? 'Showing every Plane project — switch to one project' : active ? `Switch project — currently ${active.name}` : 'Pick a project'}
        className={cn(
          'group inline-flex items-center gap-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40',
          compact
            ? 'h-9 max-w-[min(18rem,70vw)] rounded-lg border border-edge-default bg-surface-raised pl-1.5 pr-2.5 shadow-sm hover:border-edge-strong'
            : 'max-w-[min(24rem,58vw)] rounded-lg border border-transparent bg-surface-sunken/60 px-2 py-1 hover:border-edge-default hover:bg-surface-raised',
          open && 'border-brand-400 bg-surface-raised ring-2 ring-brand-400/20',
        )}
      >
        {allSelected ? <AllMark small={compact} /> : <ProjectMark project={active} small={compact} />}
        <span className={cn('min-w-0 truncate font-semibold tracking-tight text-content', compact ? 'text-[13px]' : 'text-base sm:text-lg')}>
          {allSelected ? 'All projects' : active ? active.name : 'Pick a project'}
        </span>
        {active && !compact ? (
          <span className="hidden rounded-md bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] font-semibold text-content-muted ring-1 ring-edge-subtle sm:inline">
            {active.identifier}
          </span>
        ) : null}
        {allSelected && compact && projects.length ? (
          <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-content-muted">{projects.length}</span>
        ) : null}
        <IconChevron />
      </button>
      {open ? (
        <div
          role="listbox"
          className={cn(
            'absolute top-full z-40 mt-2 w-[min(20rem,calc(100vw-1rem))] overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-xl ring-1 ring-black/5',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          <div className="border-b border-edge-subtle p-2">
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-content-subtle">
                <IconSearch />
              </span>
              <input
                autoFocus={autofocusSearch()}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search projects…"
                className="block w-full rounded-md border border-edge-default bg-surface-raised py-1.5 pl-7 pr-2 text-xs text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
              />
            </div>
          </div>
          {q.isLoading ? (
            <div className="px-3 py-4 text-sm text-content-muted">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-4 text-sm text-content-muted">
              {projects.length === 0 ? 'No projects yet.' : 'No matches.'}
            </div>
          ) : (
            <ul className="max-h-80 overflow-y-auto py-1">
              {onSelectAll && !filter.trim() ? (
                <li className="border-b border-edge-subtle pb-1">
                  <button
                    type="button"
                    onClick={() => {
                      onSelectAll()
                      setOpen(false)
                    }}
                    role="option"
                    aria-selected={allSelected}
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors',
                      allSelected ? 'bg-brand-50 text-brand-800 dark:bg-brand-500/15 dark:text-brand-200' : 'hover:bg-surface-sunken',
                    )}
                  >
                    <AllMark />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-content">All projects</span>
                      <span className="block text-[11px] text-content-subtle">Every project in the Plane workspace</span>
                    </span>
                    {allSelected ? <span className="text-brand-700 dark:text-brand-300"><IconCheck /></span> : null}
                  </button>
                </li>
              ) : null}
              {filtered.map((p) => {
                const on = !allSelected && p.id === value
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onChange(p.id)
                        setOpen(false)
                      }}
                      role="option"
                      aria-selected={on}
                      className={cn(
                        'flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors',
                        on ? 'bg-brand-50 text-brand-800 dark:bg-brand-500/15 dark:text-brand-200' : 'hover:bg-surface-sunken',
                      )}
                    >
                      <ProjectMark project={p} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-content">{p.name}</span>
                        <span className="block text-[11px] text-content-subtle">
                          {p.identifier} · {p.total_members ?? 0} members
                        </span>
                      </span>
                      {on ? (
                        <span className="text-brand-700 dark:text-brand-300">
                          <IconCheck />
                        </span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}

function IconSearch() {
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
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

function ProjectMark({ project, small }: { project?: plane.Project; small?: boolean }) {
  const box = small ? 'h-6 w-6 text-xs' : 'h-7 w-7 text-sm'
  if (!project) {
    return (
      <span className={cn('flex shrink-0 items-center justify-center rounded-md bg-surface-sunken text-content-subtle', box)}>
        ?
      </span>
    )
  }
  // Plane's emoji when it has one; otherwise a stable theme-tinted gradient
  // (the project's icon colour when Plane sets one) with its initial.
  const emoji = projectEmoji(project)
  const hue = hashHue(project.identifier ?? project.id)
  const tint = projectIconColor(project)
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center rounded-md font-semibold shadow-sm', box)}
      style={{
        backgroundImage: tint
          ? `linear-gradient(135deg, ${tint}, color-mix(in oklab, ${tint} 70%, black))`
          : `linear-gradient(135deg, oklch(0.7 0.15 ${hue}), oklch(0.5 0.18 ${(hue + 30) % 360}))`,
        color: 'white',
      }}
    >
      {emoji ?? project.identifier?.slice(0, 1).toUpperCase() ?? '?'}
    </span>
  )
}

function AllMark({ small }: { small?: boolean }) {
  return (
    <span className={cn('flex shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200 dark:bg-brand-500/15 dark:text-brand-200 dark:ring-brand-500/30', small ? 'h-6 w-6' : 'h-7 w-7')}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </svg>
    </span>
  )
}

export { hashHue }
export { ProjectMark }

function hashHue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) % 360
  }
  return h
}

function IconChevron() {
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
      className="text-content-subtle"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function IconCheck() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
