import { type ReactNode, useId, useRef } from 'react'
import { useOverlayDismiss } from './overlay.ts'
import { createPortal } from 'react-dom'
import { cn } from '@adhar/utils'

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
  /**
   * Controls for the header's right-hand cluster, placed before Close — e.g.
   * a "View YAML" toggle. Title left, actions right, like every drawer.
   */
  headerActions?: ReactNode
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
  headerActions,
}: ModalProps) {
  // ESC to close + body-scroll lock, shared with the hand-rolled drawers, plus
  // the dialog focus contract: focus in on open, Tab trapped, back on close.
  const panelRef = useRef<HTMLDivElement>(null)
  useOverlayDismiss(open, onClose, { focusRef: panelRef })
  const titleId = useId()

  if (!open) return null
  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      // A string title gets an id to point at; a custom node names itself.
      aria-labelledby={typeof title === 'string' ? titleId : undefined}
      // A bottom sheet on phones — a centred dialog in a 390px viewport is a
      // postage stamp with the keyboard up — and a dialog from sm upward.
      className="fixed inset-0 z-60 flex items-end justify-center sm:items-start sm:px-4 sm:py-10"
    >
      {/* Pointer-only scrim: out of the tab order and hidden from AT, or the
          first Tab stop of every dialog is an invisible full-screen button
          (the header already has a real, labelled Close). */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
        className="fade-in absolute inset-0 bg-scrim/45 backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          'pop-in relative flex max-h-[92dvh] w-full flex-col outline-none overflow-hidden rounded-t-2xl border border-edge-default bg-surface-raised shadow-2xl sm:max-h-none sm:rounded-2xl',
          WIDTH[width],
        )}
      >
        {/* Grab handle — reads as a sheet on a phone; nothing to drag on desktop. */}
        <span aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-edge-strong sm:hidden" />
        <header
          className={cn(
            'flex shrink-0 items-start justify-between gap-3 border-b border-edge-subtle px-5 py-4 sm:px-6',
            branded
              ? 'bg-linear-to-br from-brand-50 dark:from-brand-500/10 to-surface-raised'
              : 'bg-surface-raised',
          )}
        >
          <div className="min-w-0 flex-1">
            {typeof title === 'string' ? (
              <h2 id={titleId} className="text-[15px] font-semibold leading-6 tracking-tight text-content">{title}</h2>
            ) : (
              title
            )}
            {description ? (
              <div className="mt-0.5 text-[13px] leading-relaxed text-content-muted">{description}</div>
            ) : null}
          </div>
          <div className="-mr-1.5 -mt-0.5 flex shrink-0 items-center gap-1">
            {headerActions}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              title="Close (Esc)"
              className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-surface-sunken hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:max-h-[70vh] sm:px-6 sm:py-5">{children}</div>

        {footer ? (
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-edge-subtle bg-surface-sunken/60 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
