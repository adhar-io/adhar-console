import { useEffect, useRef, useState } from 'react'
import { cn } from '@adhar-console/utils'
import type { gitea } from '@adhar-console/api-clients'
import { useRepos } from '../data/git.ts'

/**
 * Compact repo switcher chip — used in PageHeader title and per-view
 * scope bars. Mirrors the Project picker pattern from Define.
 */
export function RepoPicker({
  value,
  onChange,
  align = 'left',
}: {
  value?: string
  onChange(name: string): void
  align?: 'left' | 'right'
}) {
  const q = useRepos()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  const repos = q.data ?? []
  const active = repos.find((r) => r.name === value)
  const f = filter.trim().toLowerCase()
  const filtered = f
    ? repos.filter((r) => r.name.toLowerCase().includes(f) || (r.description ?? '').toLowerCase().includes(f))
    : repos

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClick)
      window.removeEventListener('keydown', onKey)
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
        title={active ? `Switch repo — currently ${active.full_name}` : 'Pick a repo'}
        className={cn(
          'group inline-flex max-w-[16rem] items-center gap-2 rounded-lg border border-transparent bg-surface-sunken/60 px-2 py-1 text-left transition-colors',
          'hover:border-edge-default hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/25',
          open && 'border-brand-400 bg-surface-raised ring-2 ring-brand-400/20',
        )}
    >
        <RepoMark name={active?.name} />
        <span className="min-w-0 truncate text-base font-semibold tracking-tight text-content sm:text-lg">
          {active ? active.name : 'Pick a repo'}
        </span>
        {active ? (
          <span className="hidden rounded-md bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] font-semibold text-content-muted ring-1 ring-edge-subtle sm:inline">
            {active.default_branch}
          </span>
        ) : null}
        <IconChevron />
      </button>
      {open ? (
        <div
          role="listbox"
          className={cn(
            'absolute top-full z-40 mt-2 w-[min(22rem,calc(100vw-1rem))] overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-xl ring-1 ring-black/5',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          <div className="border-b border-edge-subtle p-2">
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-content-subtle">
                <IconSearch />
              </span>
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search repos…"
                className="block w-full rounded-md border border-edge-default bg-surface-raised py-1.5 pl-7 pr-2 text-xs text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
              />
            </div>
          </div>
          {q.isLoading ? (
            <div className="px-3 py-4 text-sm text-content-muted">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-4 text-sm text-content-muted">
              {repos.length === 0 ? 'No repos yet.' : 'No matches.'}
            </div>
          ) : (
            <ul className="max-h-80 overflow-y-auto py-1">
              {filtered.map((r) => {
                const on = r.name === value
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onChange(r.name)
                        setOpen(false)
                      }}
                      role="option"
                      aria-selected={on}
                      className={cn(
                        'flex w-full items-start gap-3 px-3 py-2 text-left transition-colors',
                        on ? 'bg-brand-50' : 'hover:bg-surface-sunken',
                      )}
                    >
                      <RepoMark name={r.name} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-content">
                          {r.name}
                        </span>
                        <span className="block truncate text-[11px] text-content-subtle">
                          {r.description ?? r.full_name}
                        </span>
                        <span className="mt-0.5 inline-flex items-center gap-1.5 text-[10px] text-content-subtle">
                          <span className="rounded bg-surface-sunken px-1 font-mono">
                            {r.default_branch}
                          </span>
                          {r.private ? '· private' : '· public'}
                          {r.language ? ` · ${r.language}` : ''}
                        </span>
                      </span>
                      {on ? (
                        <span className="text-brand-700">
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

export function RepoMark({ name }: { name?: string }) {
  if (!name) {
    return (
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-surface-sunken text-xs text-content-subtle">
        ?
      </span>
    )
  }
  const hue = hashHue(name)
  return (
    <span
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-bold text-white shadow-sm"
      style={{
        backgroundImage: `linear-gradient(135deg, oklch(0.7 0.13 ${hue}), oklch(0.5 0.16 ${(hue + 35) % 360}))`,
      }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

export function statusToneForRepo(r: gitea.Repo): 'brand' | 'amber' | 'rose' | 'emerald' {
  if (r.open_issues_count > 10) return 'rose'
  if (r.open_issues_count > 4) return 'amber'
  if (r.open_issues_count === 0) return 'emerald'
  return 'brand'
}

function hashHue(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

function IconChevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-content-subtle">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}
function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
function IconSearch() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}
