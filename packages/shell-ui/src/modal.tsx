import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@adhar-console/utils'

interface ModalProps {
  open: boolean
  onClose(): void
  title: ReactNode
  description?: ReactNode
  /** Body content. */
  children: ReactNode
  /** Footer slot — typically Cancel / primary action buttons. */
  footer?: ReactNode
  /** Width preset. Defaults to `md` (max-w-lg). */
  width?: 'sm' | 'md' | 'lg' | 'xl'
  /** Optional brand-tinted gradient header (used by create dialogs). */
  branded?: boolean
}

const WIDTH = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
} as const

/**
 * Centered, accessible dialog with backdrop blur, ESC-to-close, body-scroll
 * lock while open, and a consistent header / body / footer layout. Used for
 * every create / edit / confirm flow in the console so they all look the same.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'md',
  branded = false,
}: ModalProps) {
  // ESC closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return
    if (typeof document === 'undefined') return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  if (!open) return null
  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-60 flex items-start justify-center px-4 py-10"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
      />
      <div
        className={cn(
          'relative w-full overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-2xl ring-1 ring-edge-default',
          WIDTH[width],
        )}
      >
        <header
          className={cn(
            'flex items-start justify-between gap-3 border-b border-edge-subtle px-6 py-4',
            branded
              ? 'bg-linear-to-br from-brand-50 dark:from-brand-500/10 to-white'
              : 'bg-surface-raised',
          )}
        >
          <div>
            {typeof title === 'string' ? (
              <h2 className="text-base font-semibold tracking-tight text-content">{title}</h2>
            ) : (
              title
            )}
            {description ? (
              <div className="mt-1 text-[11px] text-content-muted">{description}</div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto px-6 py-5">{children}</div>

        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-t border-edge-subtle bg-surface-sunken/60 px-6 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
