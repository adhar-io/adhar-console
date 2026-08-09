import { useState } from 'react'
import { cn } from '@adhar-console/utils'
import type { Tenant } from '@adhar-console/tenancy'

interface Props {
  tenants: Tenant[]
  activeId: string
  onChange(id: string): void
  /** Icon-only when true — shows just the org avatar. */
  collapsed?: boolean
  /** Whether the menu opens upward (true when placed in the sidebar footer). */
  placement?: 'top' | 'bottom'
}

export function TenantSwitcher({
  tenants,
  activeId,
  onChange,
  collapsed = false,
  placement = 'bottom',
}: Props) {
  const [open, setOpen] = useState(false)
  const active = tenants.find((t) => t.id === activeId) ?? tenants[0]
  if (!active) return null

  if (collapsed) {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          title={active.name}
          aria-label={`Active organization: ${active.name}. Click to switch.`}
          className="block rounded-lg p-0.5 ring-1 ring-edge-default transition-all hover:ring-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20"
        >
          <OrgAvatar name={active.name} />
        </button>
        {open ? (
          <Menu
            placement={placement}
            collapsed
            tenants={tenants}
            activeId={activeId}
            onSelect={(id) => {
              onChange(id)
              setOpen(false)
            }}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </div>
    )
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg border px-2 py-1.5 text-left transition-all',
          'border-edge-default bg-surface-raised shadow-sm hover:border-slate-300 hover:bg-surface-sunken',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10',
        )}
      >
        <OrgAvatar name={active.name} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-content">{active.name}</div>
          <div className="truncate text-[11px] text-content-subtle">
            {active.description ?? `${active.namespacePrefix}.*`}
          </div>
        </div>
        <IconChevronUpDown />
      </button>
      {open ? (
        <Menu
          placement={placement}
          tenants={tenants}
          activeId={activeId}
          onSelect={(id) => {
            onChange(id)
            setOpen(false)
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  )
}

function Menu({
  placement,
  collapsed = false,
  tenants,
  activeId,
  onSelect,
  onClose,
}: {
  placement: 'top' | 'bottom'
  collapsed?: boolean
  tenants: Tenant[]
  activeId: string
  onSelect(id: string): void
  onClose(): void
}) {
  return (
    <>
      <div className="fixed inset-0 z-40" aria-hidden onClick={onClose} />
      <div
        role="listbox"
        className={cn(
          'absolute z-50 overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-lg ring-1 ring-edge-default',
          collapsed ? 'left-full ml-2 w-64' : 'left-0 right-0',
          placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
        )}
      >
        <div className="border-b border-edge-subtle px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
          Switch organization
        </div>
        <ul className="max-h-72 overflow-y-auto py-1">
          {tenants.map((t) => {
            const isActive = t.id === activeId
            return (
              <li key={t.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => onSelect(t.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
                    isActive ? 'bg-surface-sunken' : 'hover:bg-surface-sunken',
                  )}
                >
                  <OrgAvatar name={t.name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-content">
                        {t.name}
                      </span>
                      {isActive ? <IconCheck /> : null}
                    </div>
                    <div className="truncate text-[11px] text-content-subtle">
                      {t.description ?? `${t.namespacePrefix}.*`}
                    </div>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
        <div className="border-t border-edge-subtle p-1">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
          >
            <IconPlus />
            New organization
          </button>
        </div>
      </div>
    </>
  )
}

function OrgAvatar({ name }: { name: string }) {
  const initials = name.slice(0, 2).toUpperCase()
  const hue = hashHue(name)
  return (
    <div
      aria-hidden
      style={{
        backgroundImage: `linear-gradient(135deg, hsl(${hue} 60% 42%), hsl(${(hue + 30) % 360} 60% 28%))`,
      }}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold text-white shadow-sm ring-1 ring-edge-default"
    >
      {initials}
    </div>
  )
}

/** Stable hue from a string — keeps the same org always the same color. */
function hashHue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return Math.abs(h) % 360
}

function IconChevronUpDown() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0 text-content-subtle"
    >
      <path d="m7 15 5 5 5-5" />
      <path d="m7 9 5-5 5 5" />
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
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="ml-auto shrink-0 text-content"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function IconPlus() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
