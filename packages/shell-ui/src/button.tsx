import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Link, type LinkProps } from '@tanstack/react-router'
import { cn } from '@adhar-console/utils'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

interface Common {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Spinner / disable during an async action. */
  loading?: boolean
  /** Icon rendered before the label. */
  leading?: ReactNode
  /** Icon rendered after the label. */
  trailing?: ReactNode
  /** Force full-width. */
  block?: boolean
  className?: string
  children?: ReactNode
}

export type ButtonProps = Common & ButtonHTMLAttributes<HTMLButtonElement>

/** Link-styled button that routes through TanStack Router. */
export type ButtonLinkProps = Common & LinkProps

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-600 text-white shadow-sm ring-1 ring-inset ring-white/10 hover:bg-brand-700 active:bg-brand-800 ' +
    'focus-visible:ring-2 focus-visible:ring-brand-500/40 focus-visible:ring-offset-1 ' +
    'disabled:bg-brand-300 disabled:text-white/70 disabled:ring-0',
  secondary:
    'border border-edge-default bg-white text-content shadow-sm hover:border-edge-strong hover:bg-surface-sunken ' +
    'focus-visible:ring-2 focus-visible:ring-brand-500/20 ' +
    'disabled:text-content-subtle disabled:bg-surface-sunken',
  ghost:
    'text-content-muted hover:bg-surface-sunken hover:text-content ' +
    'focus-visible:ring-2 focus-visible:ring-brand-500/20 ' +
    'disabled:text-content-subtle',
  danger:
    'bg-rose-600 text-white shadow-sm ring-1 ring-inset ring-white/10 hover:bg-rose-700 active:bg-rose-800 ' +
    'focus-visible:ring-2 focus-visible:ring-rose-500/40 focus-visible:ring-offset-1 ' +
    'disabled:bg-rose-300',
  link:
    'text-brand-700 underline-offset-2 hover:text-brand-800 hover:underline ' +
    'focus-visible:ring-2 focus-visible:ring-brand-500/20 rounded-sm ' +
    'disabled:text-content-subtle',
}

const SIZES: Record<ButtonSize, string> = {
  xs: 'h-7 rounded-md px-2 text-xs gap-1',
  sm: 'h-8 rounded-md px-2.5 text-sm gap-1.5',
  md: 'h-9 rounded-md px-4 text-sm gap-2',
  lg: 'h-10 rounded-lg px-5 text-base gap-2',
}

const BASE =
  'inline-flex items-center justify-center whitespace-nowrap font-medium ' +
  'transition-all duration-150 outline-none disabled:cursor-not-allowed disabled:shadow-none'

function classes(
  variant: ButtonVariant,
  size: ButtonSize,
  block: boolean,
  extra?: string,
) {
  return cn(BASE, VARIANTS[variant], SIZES[size], block && 'w-full', extra)
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    leading,
    trailing,
    block = false,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      data-loading={loading ? '' : undefined}
      className={classes(variant, size, block, className)}
      {...rest}
    >
      {loading ? <Spinner size={size} /> : leading}
      {children}
      {!loading ? trailing : null}
    </button>
  )
})

export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  leading,
  trailing,
  block = false,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link className={classes(variant, size, block, className)} {...rest}>
      {leading}
      {children}
      {trailing}
    </Link>
  )
}

function Spinner({ size }: { size: ButtonSize }) {
  const dim = size === 'xs' ? 10 : size === 'sm' ? 12 : size === 'lg' ? 16 : 14
  return (
    <svg
      className="animate-spin"
      width={dim}
      height={dim}
      viewBox="0 0 24 24"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="4"
      />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  )
}
