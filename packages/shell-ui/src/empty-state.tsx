import type { ReactNode } from 'react'
import { cn } from '@adhar/utils'

interface Props {
  title: string
  description?: ReactNode
  action?: ReactNode
  /** Icon slot — a decorative symbol shown at the top. */
  icon?: ReactNode
  /** Compact variant for inline use inside data-table empties. */
  compact?: boolean
  /**
   * `error` — a region that FAILED to load, not one with nothing in it: the
   * tile turns rose and the default glyph becomes an alert, so "couldn't read"
   * never looks like "nothing here". Defaults to `default`.
   */
  tone?: 'default' | 'error'
  /**
   * Drop the dashed frame and tinted fill — for an empty state that already
   * sits inside a bordered card or table, where a second frame reads as a box
   * in a box.
   */
  bare?: boolean
  className?: string
}

export function EmptyState({ title, description, action, icon, compact = false, tone = 'default', bare = false, className }: Props) {
  const error = tone === 'error'
  return (
    <div
      data-empty-state=""
      role={error ? 'alert' : undefined}
      className={cn(
        'flex flex-col items-center justify-center text-center',
        bare ? '' : 'rounded-xl border border-dashed border-edge-strong bg-surface-sunken/40',
        compact ? 'px-4 py-8' : 'px-6 py-14',
        className,
      )}
    >
      <Illustration compact={compact} error={error}>
        {icon ?? (error ? <ErrorIcon compact={compact} /> : <DefaultIcon compact={compact} />)}
      </Illustration>
      <div className={cn('font-semibold tracking-tight text-content', compact ? 'text-sm' : 'text-base')}>
        {title}
      </div>
      {description ? (
        <p
          className={cn(
            // `anywhere` so an error message carrying a long URL wraps
            // inside the card instead of widening the page on a phone.
            'max-w-full leading-relaxed text-content-muted [overflow-wrap:anywhere] sm:max-w-md',
            compact ? 'mt-1 text-xs' : 'mt-1.5 text-sm',
          )}
        >
          {description}
        </p>
      ) : null}
      {action ? (
        <div className={cn('flex flex-wrap items-center justify-center gap-2', compact ? 'mt-3' : 'mt-5')}>{action}</div>
      ) : null}
    </div>
  )
}

/**
 * The picture above the copy: the icon on a raised tile, set in two faint
 * concentric rings with a soft brand glow behind — enough of an illustration
 * that an empty page reads as designed rather than broken, drawn from tokens
 * so it sits right in both themes. Decorative; the title carries the meaning.
 */
function Illustration({ compact, error, children }: { compact: boolean; error?: boolean; children: ReactNode }) {
  return (
    <div aria-hidden className={cn('relative flex items-center justify-center', compact ? 'mb-3 h-16 w-16' : 'mb-5 h-28 w-28')}>
      <span
        className={cn(
          'absolute inset-0 rounded-full',
          error
            ? 'bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--color-rose-500)_14%,transparent),transparent)]'
            : 'bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--color-brand-500)_16%,transparent),transparent)]',
        )}
      />
      <span className="absolute inset-[6%] rounded-full border border-edge-default/70" />
      <span className={cn('absolute rounded-full border border-dashed border-edge-strong/70', compact ? 'inset-[22%]' : 'inset-[20%]')} />
      {compact ? null : (
        <>
          <span className="absolute right-[14%] top-[16%] h-1.5 w-1.5 rounded-full bg-brand-400/70" />
          <span className="absolute bottom-[18%] left-[12%] h-1 w-1 rounded-full bg-accent-500/60" />
        </>
      )}
      <span
        className={cn(
          'relative flex items-center justify-center rounded-xl border border-edge-default bg-surface-raised shadow-md',
          error ? 'text-rose-600 dark:text-rose-300' : 'text-brand-600 dark:text-brand-300',
          compact ? 'h-9 w-9' : 'h-12 w-12',
        )}
      >
        {children}
      </span>
    </div>
  )
}

function DefaultIcon({ compact }: { compact: boolean }) {
  const size = compact ? 16 : 22
  // An empty tray — "nothing here yet" — rather than the alert glyph it
  // replaces, which read as an error on pages that were simply new.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  )
}

function ErrorIcon({ compact }: { compact: boolean }) {
  const size = compact ? 16 : 22
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}
