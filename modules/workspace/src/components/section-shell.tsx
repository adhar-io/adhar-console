import type { ReactNode } from 'react'
import { cn } from '@adhar-console/utils'
import { RequiredRolePill } from './role-gate.tsx'
import type { Role } from '../data/access.ts'

/**
 * Consistent page-level shell every Settings view renders into. Owns the
 * H1, description, action slot, and optional required-role pill so the
 * subviews stay focused on their forms / tables.
 */
export function ViewShell({
  title,
  description,
  actions,
  required,
  children,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  /** Roles allowed to *write* in this view — surfaced as a pill in the header. */
  required?: Role[]
  children: ReactNode
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold tracking-tight text-content">{title}</h2>
            {required ? <RequiredRolePill required={required} /> : null}
          </div>
          {description ? (
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-content-muted">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  )
}

/** Card / grouped form section with a title row. */
export function SettingsCard({
  title,
  description,
  actions,
  className,
  children,
}: {
  title?: string
  description?: ReactNode
  actions?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section
      className={cn(
        'overflow-hidden rounded-2xl border border-edge-default bg-white shadow-sm',
        className,
      )}
    >
      {title || description || actions ? (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-edge-subtle px-5 py-3.5">
          <div className="min-w-0">
            {title ? (
              <h3 className="text-sm font-semibold text-content">{title}</h3>
            ) : null}
            {description ? (
              <p className="mt-0.5 text-[12px] text-content-muted">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className="p-5">{children}</div>
    </section>
  )
}

/** Two-column row inside a settings card: label/help on left, control on right. */
export function SettingsRow({
  label,
  description,
  hint,
  children,
}: {
  label: ReactNode
  description?: ReactNode
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="grid gap-3 border-t border-edge-subtle py-4 first:border-0 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,_1fr)_minmax(0,_360px)] sm:gap-6">
      <div className="min-w-0">
        <div className="text-sm font-medium text-content">{label}</div>
        {description ? (
          <p className="mt-1 text-[12px] leading-relaxed text-content-muted">{description}</p>
        ) : null}
        {hint ? (
          <p className="mt-1 text-[11px] text-content-subtle">{hint}</p>
        ) : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/* ─────────── small form primitives — match the rest of the app ─────────── */

export function TextField({
  value,
  onChange,
  placeholder,
  type = 'text',
  readOnly,
  mono,
  block,
}: {
  value: string
  onChange?(v: string): void
  placeholder?: string
  type?: 'text' | 'email' | 'url' | 'password' | 'number'
  readOnly?: boolean
  mono?: boolean
  block?: boolean
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      readOnly={readOnly}
      placeholder={placeholder}
      className={cn(
        'h-9 rounded-lg border border-edge-default bg-white px-3 text-sm text-content shadow-sm placeholder:text-content-subtle',
        'focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20',
        'disabled:cursor-not-allowed disabled:opacity-60',
        readOnly && 'bg-surface-sunken',
        mono && 'font-mono text-[13px]',
        block ? 'w-full' : 'w-full',
      )}
    />
  )
}

export function SelectField<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange?(v: T): void
  options: { value: T; label: string }[]
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange?.(e.target.value as T)}
      className="h-9 w-full rounded-lg border border-edge-default bg-white px-2.5 text-sm text-content shadow-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function ToggleField({
  checked,
  onChange,
  disabled,
  label,
  description,
}: {
  checked: boolean
  onChange?(v: boolean): void
  disabled?: boolean
  label?: ReactNode
  description?: ReactNode
}) {
  return (
    <label
      className={cn(
        'flex items-center justify-between gap-3 rounded-lg border border-edge-default bg-white px-3 py-2.5 shadow-sm',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <div className="min-w-0">
        {label ? <div className="text-sm font-medium text-content">{label}</div> : null}
        {description ? (
          <div className="text-[11px] text-content-muted">{description}</div>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
          checked ? 'bg-brand-600' : 'bg-edge-strong',
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </button>
    </label>
  )
}

export function PrimaryButton({
  children,
  type = 'button',
  disabled,
  onClick,
}: {
  children: ReactNode
  type?: 'button' | 'submit'
  disabled?: boolean
  onClick?(): void
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white shadow-sm transition-all hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  )
}

export function SecondaryButton({
  children,
  type = 'button',
  disabled,
  onClick,
  tone = 'neutral',
}: {
  children: ReactNode
  type?: 'button' | 'submit'
  disabled?: boolean
  onClick?(): void
  tone?: 'neutral' | 'rose'
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-lg border bg-white px-3 text-sm font-medium shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        tone === 'rose'
          ? 'border-rose-200 text-rose-700 hover:border-rose-300 hover:bg-rose-50'
          : 'border-edge-default text-content hover:border-edge-strong hover:bg-surface-sunken',
      )}
    >
      {children}
    </button>
  )
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  tone?: 'default' | 'good' | 'warn' | 'bad'
}) {
  const valueClass =
    tone === 'good'
      ? 'text-emerald-700'
      : tone === 'warn'
        ? 'text-amber-700'
        : tone === 'bad'
          ? 'text-rose-700'
          : 'text-content'
  return (
    <div className="rounded-xl border border-edge-default bg-white p-4 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
        {label}
      </div>
      <div className={cn('mt-1 text-xl font-semibold tabular-nums tracking-tight', valueClass)}>
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-[11px] text-content-muted">{hint}</div> : null}
    </div>
  )
}
