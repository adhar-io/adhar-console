import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { cn } from '@adhar/utils'

/* ─────────────────────────────────────────────── Shared field wrapper ── */

interface FieldProps {
  label?: ReactNode
  hint?: ReactNode
  error?: string
  required?: boolean
  className?: string
  children: ReactNode
}

export function Field({ label, hint, error, required, className, children }: FieldProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label ? (
        <label className="flex items-baseline gap-2 text-[13px] font-medium text-content">
          <span>{label}</span>
          {required ? <span aria-hidden className="text-rose-600 dark:text-rose-400">*</span> : null}
          {hint && !error ? (
            <span className="ml-auto text-xs font-normal text-content-subtle">{hint}</span>
          ) : null}
        </label>
      ) : null}
      {children}
      {/* An icon as well as the colour, so the message is not colour-only. */}
      {error ? (
        <div role="alert" className="flex items-start gap-1.5 text-xs text-rose-700 dark:text-rose-300">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mt-px shrink-0">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────── Input ── */

/*
 * Fields share the Button's geometry so a toolbar of Input + Select + Button
 * lines up to the pixel: `md` is 36px (Button `md`, h-9), `sm` is 32px (Button
 * `sm`, h-8), both rounded-md and raised to 44px for a finger like the
 * buttons are. The height used to come from `py-2` + line height, which landed
 * at 38px — two pixels taller than every button beside it.
 *
 * Focus is the brand ring the rest of the console uses (it was a slate ring
 * here, the one control family that did not match).
 */
const FIELD_BASE =
  'w-full rounded-md border bg-surface-raised px-3 text-sm text-content shadow-xs ' +
  'placeholder:text-content-subtle ' +
  'transition-[border-color,box-shadow,background-color] duration-150 ' +
  'hover:border-edge-strong ' +
  'focus:outline-none focus-visible:outline-none focus-visible:ring-[3px] ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-content-subtle disabled:shadow-none disabled:hover:border-edge-default'

const FIELD_HEIGHT = {
  sm: 'h-8 pointer-coarse:h-11 text-[13px]',
  md: 'h-9 pointer-coarse:h-11',
} as const

export type FieldSize = keyof typeof FIELD_HEIGHT

const FIELD_STATES = {
  default: 'border-edge-default focus-visible:border-brand-500 focus-visible:ring-brand-500/20 dark:focus-visible:border-brand-400 dark:focus-visible:ring-brand-400/25',
  error: 'border-rose-400 hover:border-rose-500 focus-visible:border-rose-500 focus-visible:ring-rose-500/20 dark:border-rose-500/60',
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean
  leading?: ReactNode
  trailing?: ReactNode
  /** Control height, matching Button sizes: `md` (default, 36px) or `sm` (32px). */
  controlSize?: FieldSize
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, leading, trailing, controlSize = 'md', className, ...rest },
  ref,
) {
  if (leading || trailing) {
    return (
      <div className="relative">
        {leading ? (
          <span className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 items-center text-content-subtle">
            {leading}
          </span>
        ) : null}
        <input
          ref={ref}
          aria-invalid={invalid || undefined}
          className={cn(
            FIELD_BASE,
            FIELD_HEIGHT[controlSize],
            invalid ? FIELD_STATES.error : FIELD_STATES.default,
            leading && 'pl-9',
            trailing && 'pr-9',
            className,
          )}
          {...rest}
        />
        {trailing ? (
          <span className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center text-content-subtle">
            {trailing}
          </span>
        ) : null}
      </div>
    )
  }
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        FIELD_BASE,
        FIELD_HEIGHT[controlSize],
        invalid ? FIELD_STATES.error : FIELD_STATES.default,
        className,
      )}
      {...rest}
    />
  )
})

/* ────────────────────────────────────────────────────────────── Select ── */

export interface SelectOption {
  value: string
  label: string
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options?: SelectOption[]
  invalid?: boolean
  /** Classes for the positioning wrapper — e.g. `min-w-0 flex-1` to let the select flex. */
  wrapperClassName?: string
  /** Control height, matching Button sizes: `md` (default, 36px) or `sm` (32px). */
  controlSize?: FieldSize
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, children, invalid, className, wrapperClassName, controlSize = 'md', ...rest },
  ref,
) {
  return (
    <div className={cn('relative', wrapperClassName)}>
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          FIELD_BASE,
          FIELD_HEIGHT[controlSize],
          'cursor-pointer appearance-none pr-8 disabled:cursor-not-allowed',
          invalid ? FIELD_STATES.error : FIELD_STATES.default,
          className,
        )}
        {...rest}
      >
        {children ??
          options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
      </select>
      {/* A drawn chevron: the `▾` glyph it replaces sat on the text baseline,
          a pixel or two low, and changed weight with the font. */}
      <svg
        aria-hidden
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-content-subtle"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  )
})

/* ──────────────────────────────────────────────────────────── Textarea ── */

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        FIELD_BASE,
        'min-h-20 resize-y py-2 leading-relaxed',
        invalid ? FIELD_STATES.error : FIELD_STATES.default,
        className,
      )}
      {...rest}
    />
  )
})

/* ─────────────────────────────────────────────────────────── Checkbox ── */

interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode
  description?: ReactNode
}

export function Checkbox({ label, description, className, id: idProp, ...rest }: CheckboxProps) {
  const auto = useId()
  const id = idProp ?? auto
  return (
    <label htmlFor={id} className={cn('flex cursor-pointer items-start gap-2.5 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60', className)}>
      {/* The native control, brand-tinted: it keeps the platform's keyboard,
          indeterminate and high-contrast behaviour for free. */}
      <input
        type="checkbox"
        id={id}
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-brand-600 disabled:cursor-not-allowed dark:accent-brand-500"
        {...rest}
      />
      {label || description ? (
        <div className="min-w-0">
          {label ? <div className="text-sm font-medium text-content">{label}</div> : null}
          {description ? (
            <div className="text-xs text-content-subtle">{description}</div>
          ) : null}
        </div>
      ) : null}
    </label>
  )
}
