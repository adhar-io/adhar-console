import { type ReactNode } from 'react'
import { cn } from '@adhar-console/utils'

/**
 * Core display primitives — every card-shaped surface in the app should use
 * these instead of hand-rolled borders/shadows. One cohesive elevation system
 * that tracks the active theme via design tokens.
 *
 * Elevation system:
 *   • `flat`   — border only, no shadow          — default resting state
 *   • `raised` — flat + `shadow-sm`              — sits on the canvas
 *   • `float`  — raised + `shadow-md` on hover   — interactive cards
 *   • `pop`    — `shadow-xl ring-1 ring-black/5` — dropdowns + drawers
 */

/* ───────────────────────────────────────────────────────────── Card ── */

interface CardProps {
  children?: ReactNode
  className?: string
  /** Adds a subtle hover-lift — use for interactive cards (links, tile rows). */
  interactive?: boolean
  /** Elevation depth. Defaults to `raised`. */
  elevation?: 'flat' | 'raised' | 'float'
  as?: 'div' | 'section' | 'article'
}

const ELEVATION: Record<NonNullable<CardProps['elevation']>, string> = {
  flat: '',
  raised: 'shadow-sm',
  float: 'shadow-md',
}

export function Card({
  children,
  className,
  interactive = false,
  elevation = 'raised',
  as: As = 'div',
}: CardProps) {
  return (
    <As
      className={cn(
        'rounded-xl border border-edge-default bg-white',
        ELEVATION[elevation],
        interactive &&
          'transition-[transform,box-shadow,border-color] duration-150 ease-smooth hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-md',
        className,
      )}
    >
      {children}
    </As>
  )
}

export function CardHeader({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('border-b border-edge-subtle px-5 py-3.5', className)}>{children}</div>
  )
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('px-5 py-4', className)}>{children}</div>
}

export function CardFooter({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex items-center border-t border-edge-subtle bg-surface-sunken/60 px-5 py-3',
        className,
      )}
    >
      {children}
    </div>
  )
}

/* ───────────────────────────────────────────────────── Skeleton ── */

interface SkeletonProps {
  width?: number | string
  height?: number | string
  className?: string
  rounded?: 'sm' | 'md' | 'lg' | 'full'
}

const ROUNDED: Record<NonNullable<SkeletonProps['rounded']>, string> = {
  sm: 'rounded',
  md: 'rounded-md',
  lg: 'rounded-lg',
  full: 'rounded-full',
}

export function Skeleton({ width, height, className, rounded = 'md' }: SkeletonProps) {
  return (
    <span
      aria-hidden
      className={cn(
        // Shimmer beats a flat pulse on long rows — tracks the `shimmer` keyframe
        // registered in apps/console/app/styles.css.
        'skeleton-shimmer block',
        ROUNDED[rounded],
        className,
      )}
      style={{ width, height }}
    />
  )
}

/* ───────────────────────────────────────────────────── Separator ── */

export function Separator({
  orientation = 'horizontal',
  className,
}: {
  orientation?: 'horizontal' | 'vertical'
  className?: string
}) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(
        'bg-edge-default',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
    />
  )
}

/* ──────────────────────────────────────────────────────────── Kbd ── */

export function Kbd({
  children,
  className,
  size = 'sm',
}: {
  children: ReactNode
  className?: string
  size?: 'xs' | 'sm'
}) {
  return (
    <kbd
      className={cn(
        'inline-flex select-none items-center justify-center rounded-md border border-edge-default bg-surface-sunken font-mono font-medium text-content-muted shadow-[inset_0_-1px_0_rgb(0_0_0/.06)]',
        size === 'xs'
          ? 'min-w-[1.1rem] px-1 py-0 text-[10px]'
          : 'min-w-[1.25rem] px-1.5 py-0.5 text-[11px]',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

/* ─────────────────────────────────────────────────────────── Badge ── */

type BadgeTone =
  | 'slate'
  | 'brand'
  | 'emerald'
  | 'rose'
  | 'amber'
  | 'indigo'
  | 'sky'
  | 'violet'

const BADGE_TONE: Record<BadgeTone, string> = {
  slate: 'bg-surface-sunken text-content-muted ring-edge-default',
  brand: 'bg-brand-50 text-brand-700 ring-brand-200',
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  rose: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  sky: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  violet: 'bg-violet-50 text-violet-700 ring-violet-600/20',
}

export function Badge({
  tone = 'slate',
  children,
  className,
}: {
  tone?: BadgeTone
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        BADGE_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/* ───────────────────────────────────────────────────── Spinner ── */

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={cn('animate-spin text-content-subtle', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="3"
      />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}
