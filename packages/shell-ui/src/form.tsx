import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { cn } from '@adhar-console/utils'

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
        <label className="flex items-baseline gap-2 text-sm font-medium text-content">
          <span>{label}</span>
          {required ? <span className="text-rose-600">*</span> : null}
          {hint && !error ? (
            <span className="ml-auto text-xs font-normal text-content-subtle">{hint}</span>
          ) : null}
        </label>
      ) : null}
      {children}
      {error ? <div className="text-xs text-rose-600">{error}</div> : null}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────── Input ── */

const FIELD_BASE =
  'w-full rounded-md border bg-surface-raised px-3 py-2 text-sm text-content shadow-sm ' +
  'placeholder:text-content-subtle ' +
  'transition-colors duration-150 ' +
  'focus:outline-none focus-visible:ring-2 ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-content-subtle'

const FIELD_STATES = {
  default: 'border-edge-default focus-visible:border-slate-400 focus-visible:ring-slate-900/10',
  error: 'border-rose-300 focus-visible:border-rose-500 focus-visible:ring-rose-500/20',
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean
  leading?: ReactNode
  trailing?: ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, leading, trailing, className, ...rest },
  ref,
) {
  if (leading || trailing) {
    return (
      <div className="relative">
        {leading ? (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-content-subtle">
            {leading}
          </span>
        ) : null}
        <input
          ref={ref}
          className={cn(
            FIELD_BASE,
            invalid ? FIELD_STATES.error : FIELD_STATES.default,
            leading && 'pl-9',
            trailing && 'pr-9',
            className,
          )}
          {...rest}
        />
        {trailing ? (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-content-subtle">
            {trailing}
          </span>
        ) : null}
      </div>
    )
  }
  return (
    <input
      ref={ref}
      className={cn(
        FIELD_BASE,
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
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, children, invalid, className, ...rest },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          FIELD_BASE,
          'appearance-none pr-8',
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
      <span
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-content-subtle"
      >
        ▾
      </span>
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
      className={cn(
        FIELD_BASE,
        'resize-y',
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
    <label htmlFor={id} className={cn('flex items-start gap-2.5', className)}>
      <input
        type="checkbox"
        id={id}
        className="mt-0.5 h-4 w-4 rounded border-edge-default text-content focus:ring-2 focus:ring-slate-900/20"
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
