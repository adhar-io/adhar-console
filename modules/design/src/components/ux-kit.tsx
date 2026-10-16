import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@adhar/utils'
import { initials } from '../data/ux-lib.ts'

/**
 * Small building blocks shared by the Dashboard, Personas, Journey Maps,
 * Design Tokens and Component Catalog views: persona avatars, inline editing,
 * a debounced autosave "draft" hook, a segmented control, and copy/download
 * helpers. Kept local to the Design module (shell-ui is shared by every
 * module and stays untouched).
 */

/* ───────────────────────────── avatar ───────────────────────────── */

export const AVATAR_COLORS = ['brand', 'violet', 'emerald', 'amber', 'rose', 'sky', 'teal', 'slate'] as const
export type AvatarColor = (typeof AVATAR_COLORS)[number]

const AVATAR_TONE: Record<AvatarColor, string> = {
  brand: 'bg-brand-100 text-brand-800 dark:bg-brand-500/25 dark:text-brand-100',
  violet: 'bg-violet-100 text-violet-800 dark:bg-violet-500/25 dark:text-violet-100',
  emerald: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/25 dark:text-emerald-100',
  amber: 'bg-amber-100 text-amber-900 dark:bg-amber-500/25 dark:text-amber-100',
  rose: 'bg-rose-100 text-rose-800 dark:bg-rose-500/25 dark:text-rose-100',
  sky: 'bg-sky-100 text-sky-800 dark:bg-sky-500/25 dark:text-sky-100',
  teal: 'bg-teal-100 text-teal-800 dark:bg-teal-500/25 dark:text-teal-100',
  slate: 'bg-slate-200 text-slate-800 dark:bg-slate-500/30 dark:text-slate-100',
}

/** Solid swatch per colour key (colour pickers, chart dots). */
export const AVATAR_SWATCH: Record<AvatarColor, string> = {
  brand: 'bg-brand-500',
  violet: 'bg-violet-500',
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  rose: 'bg-rose-500',
  sky: 'bg-sky-500',
  teal: 'bg-teal-500',
  slate: 'bg-slate-500',
}

/** Stable colour for a persona without an explicit one. */
export function avatarColor(key: string | undefined, seed: string): AvatarColor {
  if (key && (AVATAR_COLORS as readonly string[]).includes(key)) return key as AvatarColor
  let h = 0
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

export function PersonaAvatar({
  name,
  avatar,
  color,
  size = 40,
  className,
}: {
  name: string
  avatar?: string
  color?: string
  size?: number
  className?: string
}) {
  const tone = AVATAR_TONE[avatarColor(color, name)]
  const emoji = avatar?.trim()
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold ring-2 ring-surface-raised',
        tone,
        className,
      )}
      style={{ width: size, height: size, fontSize: emoji ? size * 0.5 : size * 0.38 }}
    >
      {emoji || initials(name)}
    </span>
  )
}

/* ───────────────────────────── autosave draft ───────────────────────────── */

/**
 * A local working copy of one stored entity that saves itself after a short
 * pause. Typing never waits on the network and never flickers back to the
 * server copy mid-edit: the server copy only replaces the draft when there is
 * nothing pending or in flight, or when a different entity is selected.
 * Pending edits are flushed when the selection changes and on unmount.
 */
export function useDraft<T extends { id: string }>(
  source: T | null,
  save: (next: T) => Promise<unknown>,
  delay = 700,
) {
  const [draft, setDraft] = useState<T | null>(source)
  const draftRef = useRef<T | null>(source)
  const pending = useRef<T | null>(null)
  const inFlight = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const saveRef = useRef(save)
  saveRef.current = save
  const idRef = useRef(source?.id)
  const [saving, setSaving] = useState(false)

  const flush = useCallback(() => {
    clearTimeout(timer.current)
    const next = pending.current
    pending.current = null
    if (!next) return
    inFlight.current++
    setSaving(true)
    void saveRef.current(next).finally(() => {
      inFlight.current--
      if (!inFlight.current) setSaving(false)
    })
  }, [])

  useEffect(() => {
    if (source?.id !== idRef.current) {
      flush()
      idRef.current = source?.id
      draftRef.current = source
      setDraft(source)
      return
    }
    if (!pending.current && !inFlight.current) {
      draftRef.current = source
      setDraft(source)
    }
  }, [source, flush])

  useEffect(() => () => flush(), [flush])

  const update = useCallback(
    (fn: (d: T) => T) => {
      const cur = draftRef.current
      if (!cur) return
      const next = fn(cur)
      draftRef.current = next
      setDraft(next)
      pending.current = next
      clearTimeout(timer.current)
      timer.current = setTimeout(flush, delay)
    },
    [delay, flush],
  )

  return { draft, update, flush, saving }
}

/* ───────────────────────────── inline editing ───────────────────────────── */

/**
 * Text that reads as text and edits in place. Commits on blur / Enter
 * (Shift+Enter for a newline when `multiline`), reverts on Escape.
 */
export function InlineText({
  value,
  onCommit,
  placeholder,
  multiline = false,
  className,
  ariaLabel,
  autoFocus,
}: {
  value: string
  onCommit(next: string): void
  placeholder?: string
  multiline?: boolean
  className?: string
  ariaLabel?: string
  autoFocus?: boolean
}) {
  const [local, setLocal] = useState(value)
  const focused = useRef(false)
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)
  useEffect(() => {
    if (!focused.current) setLocal(value)
  }, [value])
  useEffect(() => {
    if (multiline && ref.current) autosize(ref.current as HTMLTextAreaElement)
  }, [local, multiline])

  const commit = () => {
    focused.current = false
    if (local !== value) onCommit(local)
  }
  const base = cn(
    'w-full rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-content outline-none transition-colors',
    'placeholder:text-content-subtle hover:border-edge-default focus:border-brand-400 focus:bg-surface-raised focus:ring-2 focus:ring-brand-400/20',
    className,
  )
  const common = {
    value: local,
    placeholder,
    'aria-label': ariaLabel ?? placeholder,
    autoFocus,
    onFocus: () => {
      focused.current = true
    },
    onBlur: commit,
  }
  if (multiline) {
    return (
      <textarea
        {...common}
        ref={(el) => {
          ref.current = el
        }}
        rows={1}
        onChange={(e) => setLocal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            ;(e.target as HTMLTextAreaElement).blur()
          }
          if (e.key === 'Escape') {
            setLocal(value)
            focused.current = false
            ;(e.target as HTMLTextAreaElement).blur()
          }
        }}
        className={cn(base, 'resize-none overflow-hidden leading-relaxed')}
      />
    )
  }
  return (
    <input
      {...common}
      ref={(el) => {
        ref.current = el
      }}
      onChange={(e) => setLocal(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setLocal(value)
          focused.current = false
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      className={base}
    />
  )
}

function autosize(el: HTMLTextAreaElement) {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

/**
 * An editable bullet list: click an item to edit, × to remove, type in the
 * last row and press Enter to add. Empty edits remove the item.
 */
export function ListEditor({
  items,
  onChange,
  placeholder = 'Add…',
  dotClass = 'bg-content-subtle',
  compact = false,
}: {
  items: string[]
  onChange(next: string[]): void
  placeholder?: string
  dotClass?: string
  compact?: boolean
}) {
  const [adding, setAdding] = useState('')
  const add = () => {
    const v = adding.trim()
    if (!v) return
    onChange([...items, v])
    setAdding('')
  }
  return (
    <ul className={cn('space-y-0.5', compact ? 'text-xs' : 'text-sm')}>
      {items.map((it, i) => (
        <li key={`${i}-${it.slice(0, 12)}`} className="group/item flex items-start gap-1">
          <span className={cn('mt-[0.6em] h-1.5 w-1.5 shrink-0 rounded-full', dotClass)} />
          <InlineText
            multiline
            value={it}
            ariaLabel={`Item ${i + 1}`}
            onCommit={(v) => {
              const t = v.trim()
              onChange(t ? items.map((x, k) => (k === i ? t : x)) : items.filter((_, k) => k !== i))
            }}
          />
          <button
            type="button"
            aria-label="Remove item"
            onClick={() => onChange(items.filter((_, k) => k !== i))}
            className="mt-0.5 shrink-0 rounded p-0.5 text-content-subtle opacity-0 transition-opacity hover:bg-surface-sunken hover:text-rose-600 focus:opacity-100 group-hover/item:opacity-100"
          >
            <IconX size={11} />
          </button>
        </li>
      ))}
      <li className="flex items-center gap-1">
        <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full border border-dashed border-content-subtle" />
        <input
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          onBlur={add}
          placeholder={placeholder}
          aria-label={placeholder}
          className="w-full rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-content outline-none placeholder:text-content-subtle hover:border-edge-default focus:border-brand-400 focus:bg-surface-raised focus:ring-2 focus:ring-brand-400/20"
        />
      </li>
    </ul>
  )
}

/* ───────────────────────────── segmented control ───────────────────────────── */

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'sm',
  ariaLabel,
}: {
  value: T
  onChange(v: T): void
  options: ReadonlyArray<{ value: T; label: ReactNode; title?: string }>
  size?: 'xs' | 'sm'
  ariaLabel?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-edge-default bg-surface-sunken p-0.5"
    >
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md font-medium transition-colors',
              size === 'xs' ? 'h-6 px-2 text-[11px]' : 'h-7 px-2.5 text-xs',
              on ? 'bg-surface-raised text-content shadow-sm ring-1 ring-edge-default' : 'text-content-muted hover:text-content',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/* ───────────────────────────── chips ───────────────────────────── */

export function Chip({
  children,
  onRemove,
  active,
  onClick,
  className,
}: {
  children: ReactNode
  onRemove?(): void
  active?: boolean
  onClick?(): void
  className?: string
}) {
  const cls = cn(
    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset transition-colors',
    active
      ? 'bg-brand-50 text-brand-700 ring-brand-300 dark:bg-brand-500/15 dark:text-brand-200 dark:ring-brand-400/40'
      : 'bg-surface-sunken text-content-muted ring-edge-default',
    onClick && 'hover:text-content',
    className,
  )
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cls} aria-pressed={active}>
        {children}
      </button>
    )
  }
  return (
    <span className={cls}>
      {children}
      {onRemove ? (
        <button type="button" aria-label="Remove" onClick={onRemove} className="rounded-full hover:text-rose-600">
          <IconX size={10} />
        </button>
      ) : null}
    </span>
  )
}

/* ───────────────────────────── copy / download ───────────────────────────── */

export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  ta.remove()
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  downloadBlob(filename, new Blob([text], { type: `${mime};charset=utf-8` }))
}

/** Rasterise an SVG string to a PNG blob (2× by default for crisp output). */
export function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(width * scale)
      canvas.height = Math.ceil(height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        reject(new Error('Canvas is not available'))
        return
      }
      ctx.scale(scale, scale)
      ctx.drawImage(img, 0, 0, width, height)
      URL.revokeObjectURL(url)
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png')
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not render the SVG'))
    }
    img.src = url
  })
}

export function fileSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export'
}

/* ───────────────────────────── code block ───────────────────────────── */

export function CodeBlock({
  code,
  className,
  maxHeight = 420,
  actions,
}: {
  code: string
  className?: string
  maxHeight?: number
  actions?: ReactNode
}) {
  return (
    <div className={cn('relative overflow-hidden rounded-lg border border-edge-default bg-slate-950', className)}>
      {actions ? <div className="absolute right-2 top-2 z-10 flex gap-1">{actions}</div> : null}
      <pre
        className="overflow-auto p-4 font-mono text-[12px] leading-relaxed text-slate-100"
        style={{ maxHeight }}
      >
        <code>{code}</code>
      </pre>
    </div>
  )
}

/* ───────────────────────────── icons ───────────────────────────── */

type IconProps = { size?: number; className?: string }

function Svg({ size = 14, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {children}
    </svg>
  )
}

export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
)
export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Svg>
)
export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
  </Svg>
)
export const IconUpload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
  </Svg>
)
export const IconEdit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Svg>
)
export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </Svg>
)
export const IconDuplicate = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8" y="8" width="13" height="13" rx="2" />
    <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
  </Svg>
)
export const IconLink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </Svg>
)
export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h14M12 5l7 7-7 7" />
  </Svg>
)
export const IconGrip = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="6" r="1" />
    <circle cx="15" cy="6" r="1" />
    <circle cx="9" cy="12" r="1" />
    <circle cx="15" cy="12" r="1" />
    <circle cx="9" cy="18" r="1" />
    <circle cx="15" cy="18" r="1" />
  </Svg>
)
export const IconColumns = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 3v18M15 3v18" />
  </Svg>
)
export const IconGridView = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </Svg>
)
export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </Svg>
)
export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </Svg>
)
export const IconHistory = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5M12 7v5l4 2" />
  </Svg>
)
export const IconReset = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </Svg>
)
export const IconChevron = (p: IconProps & { dir?: 'left' | 'right' | 'down' | 'up' }) => {
  const d = { left: 'm15 18-6-6 6-6', right: 'm9 18 6-6-6-6', down: 'm6 9 6 6 6-6', up: 'm18 15-6-6-6 6' }[p.dir ?? 'right']
  return (
    <Svg {...p}>
      <path d={d} />
    </Svg>
  )
}
export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Svg>
)
export const IconImage = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
  </Svg>
)
export const IconWarning = (p: IconProps) => (
  <Svg {...p}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
    <path d="M12 9v4M12 17h.01" />
  </Svg>
)
export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4M12 8h.01" />
  </Svg>
)
