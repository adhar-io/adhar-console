import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@adhar/shell-ui'

/**
 * Small UI atoms shared by the Design editors (ADRs, Diagrams, Whiteboard,
 * API & Schemas): a confirm dialog, a dropdown menu, a segmented control,
 * a search box, a tag editor and a save-state dot.
 */

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Delete',
  danger = true,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  danger?: boolean
  onConfirm(): void
  onClose(): void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      width="sm"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={danger ? 'danger' : 'primary'}
            onClick={() => {
              onConfirm()
              onClose()
            }}
            autoFocus
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <span className="sr-only">{title}</span>
    </Modal>
  )
}

/** Imperative-feeling confirm: `const [ask, dialog] = useConfirm()`. */
export function useConfirm(): [
  (opts: { title: string; description?: React.ReactNode; confirmLabel?: string; danger?: boolean; onConfirm(): void }) => void,
  React.ReactNode,
] {
  const [state, setState] = useState<
    { title: string; description?: React.ReactNode; confirmLabel?: string; danger?: boolean; onConfirm(): void } | null
  >(null)
  const dialog = (
    <ConfirmDialog
      open={!!state}
      title={state?.title ?? ''}
      description={state?.description}
      confirmLabel={state?.confirmLabel}
      danger={state?.danger ?? true}
      onConfirm={() => state?.onConfirm()}
      onClose={() => setState(null)}
    />
  )
  return [setState, dialog]
}

export interface MenuItem {
  label: string
  onSelect(): void
  hint?: string
  danger?: boolean
  disabled?: boolean
  icon?: React.ReactNode
}

/** Button + popover menu. Closes on outside click and Escape. */
export function Menu({
  label,
  items,
  align = 'right',
  variant = 'secondary',
  icon,
  ariaLabel,
}: {
  label?: React.ReactNode
  items: (MenuItem | 'separator')[]
  align?: 'left' | 'right'
  variant?: 'secondary' | 'ghost'
  icon?: React.ReactNode
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="relative" ref={ref}>
      <Button
        size="sm"
        variant={variant}
        onClick={() => setOpen((o) => !o)}
        leading={icon}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        trailing={label ? <Chevron /> : undefined}
      >
        {label}
      </Button>
      {open
        ? (
          <div
            role="menu"
            className={`absolute z-40 mt-1 min-w-48 overflow-hidden rounded-lg border border-edge-default bg-surface-raised py-1 shadow-xl ${
              align === 'right' ? 'right-0' : 'left-0'
            }`}
          >
            {items.map((it, i) =>
              it === 'separator'
                ? <div key={`sep-${i}`} className="my-1 border-t border-edge-subtle" />
                : (
                  <button
                    key={it.label}
                    type="button"
                    role="menuitem"
                    disabled={it.disabled}
                    onClick={() => {
                      setOpen(false)
                      it.onSelect()
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] disabled:opacity-40 ${
                      it.danger
                        ? 'text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10'
                        : 'text-content hover:bg-surface-sunken'
                    }`}
                  >
                    {it.icon ? <span className="w-4 text-content-subtle">{it.icon}</span> : null}
                    <span className="flex-1">{it.label}</span>
                    {it.hint ? <span className="font-mono text-[10px] text-content-subtle">{it.hint}</span> : null}
                  </button>
                )
            )}
          </div>
        )
        : null}
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'sm',
}: {
  value: T
  onChange(v: T): void
  options: { id: T; label: React.ReactNode; title?: string }[]
  size?: 'xs' | 'sm'
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-edge-default bg-surface-sunken/60 p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          title={o.title}
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={`rounded-md ${size === 'xs' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-[12px]'} font-medium transition ${
            value === o.id
              ? 'bg-surface-raised text-content shadow-sm ring-1 ring-edge-default'
              : 'text-content-muted hover:text-content'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function SearchBox({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string
  onChange(v: string): void
  placeholder: string
  className?: string
}) {
  return (
    <div className={`relative ${className ?? ''}`}>
      <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-content-subtle">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="block h-8 w-full rounded-lg border border-edge-default bg-surface-raised pl-8 pr-2 text-[13px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
      />
    </div>
  )
}

/** Chip-style tag editor: Enter / comma adds, Backspace on empty removes. */
export function TagInput({
  value,
  onChange,
  placeholder = 'Add tag…',
  suggestions = [],
  prefix = '#',
  lowercase = true,
}: {
  value: string[]
  onChange(tags: string[]): void
  placeholder?: string
  suggestions?: string[]
  /** Shown before each chip (`#` for tags, '' for people). */
  prefix?: string
  lowercase?: boolean
}) {
  const [draft, setDraft] = useState('')
  const listId = useRef(`tags-${Math.random().toString(36).slice(2, 8)}`).current
  const add = (raw: string) => {
    const trimmed = raw.trim().replace(/^#/, '')
    const t = lowercase ? trimmed.toLowerCase() : trimmed
    if (t && !value.includes(t)) onChange([...value, t])
    setDraft('')
  }
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-surface-raised px-1.5 py-1 focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-400/20">
      {value.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] font-medium text-content-muted">
          {prefix}{t}
          <button
            type="button"
            aria-label={`Remove ${t}`}
            onClick={() => onChange(value.filter((x) => x !== t))}
            className="text-content-subtle hover:text-content"
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        list={suggestions.length ? listId : undefined}
        onChange={(e) => {
          const v = e.target.value
          if (v.endsWith(',')) add(v.slice(0, -1))
          else setDraft(v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add(draft)
          } else if (e.key === 'Backspace' && !draft && value.length) {
            onChange(value.slice(0, -1))
          }
        }}
        onBlur={() => draft && add(draft)}
        placeholder={value.length ? '' : placeholder}
        className="min-w-24 flex-1 bg-transparent px-1 text-[12px] text-content placeholder:text-content-subtle focus:outline-none"
      />
      {suggestions.length
        ? (
          <datalist id={listId}>
            {suggestions.filter((s) => !value.includes(s)).map((s) => <option key={s} value={s} />)}
          </datalist>
        )
        : null}
    </div>
  )
}

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

/** A quiet save-state dot with a label for screen readers and hover. */
export function SaveDot({ state }: { state: SaveState }) {
  if (state === 'idle') return null
  const map: Record<Exclude<SaveState, 'idle'>, { cls: string; label: string }> = {
    dirty: { cls: 'bg-amber-400', label: 'Unsaved changes' },
    saving: { cls: 'bg-amber-400 animate-pulse', label: 'Saving…' },
    saved: { cls: 'bg-emerald-500', label: 'All changes saved' },
    error: { cls: 'bg-rose-500', label: 'Save failed' },
  }
  const m = map[state]
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-content-subtle" title={m.label}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.cls}`} />
      <span className="hidden sm:inline">{m.label}</span>
    </span>
  )
}

export function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

/** 14px stroke icon set used across the Design editors. */
export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name]}
    </svg>
  )
}

export type IconName =
  | 'plus' | 'back' | 'download' | 'copy' | 'link' | 'trash' | 'more' | 'git' | 'upload' | 'eye'
  | 'edit' | 'check' | 'template' | 'code' | 'split' | 'history' | 'undo' | 'redo' | 'image' | 'search'

const ICONS: Record<IconName, React.ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  back: <path d="m15 18-6-6 6-6" />,
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </>
  ),
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5" />
      <path d="M12 3v12" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>
  ),
  more: (
    <>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </>
  ),
  git: (
    <>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <path d="M6 9v12" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  edit: <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />,
  check: <path d="M20 6 9 17l-5-5" />,
  template: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  code: <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />,
  split: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M12 3v18" />
    </>
  ),
  history: (
    <>
      <path d="M3 3v5h5" />
      <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
      <path d="M12 7v5l4 2" />
    </>
  ),
  undo: (
    <>
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
    </>
  ),
  redo: (
    <>
      <path d="M21 7v6h-6" />
      <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
}
