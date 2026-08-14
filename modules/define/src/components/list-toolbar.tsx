import { useEffect, type ReactNode } from 'react'
import { Button } from '@adhar-console/shell-ui'

/**
 * Shared toolbar for list pages — left side shows count + search,
 * right side hosts the primary "New X" button. Keyboard `n` (with no
 * modifier and no focused input) triggers `onNew`.
 */
export function ListToolbar({
  count,
  noun,
  search,
  onSearch,
  searchPlaceholder = 'Search…',
  onNew,
  newLabel,
  disabled = false,
}: {
  count: number
  noun: string
  search: string
  onSearch(v: string): void
  searchPlaceholder?: string
  onNew(): void
  newLabel: string
  disabled?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return
      if (disabled) return
      const t = e.target as HTMLElement | null
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      )
        return
      e.preventDefault()
      onNew()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onNew, disabled])

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="text-[11px] text-content-muted">
        {count} {noun}
        {count === 1 ? '' : 's'} in this project
      </div>
      <div className="ml-auto flex items-center gap-2">
        <SearchInput value={search} onChange={onSearch} placeholder={searchPlaceholder} />
        <Button size="sm" onClick={onNew} leading={<IconPlus />} disabled={disabled}>
          {newLabel}
          <KeyHint>N</KeyHint>
        </Button>
      </div>
    </div>
  )
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
}: {
  value: string
  onChange(v: string): void
  placeholder?: string
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-content-subtle">
        <IconSearch />
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="block h-9 w-44 rounded-lg border border-edge-default bg-surface-raised pl-7 pr-2 text-sm placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20 sm:w-56"
      />
    </div>
  )
}

function KeyHint({ children }: { children: ReactNode }) {
  return (
    <kbd className="ml-1 hidden rounded border border-white/40 bg-white/15 px-1 text-[10px] font-mono font-semibold text-white/85 sm:inline">
      {children}
    </kbd>
  )
}

function IconPlus() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function IconSearch() {
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
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}
