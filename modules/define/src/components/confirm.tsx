import { type ReactNode, useSyncExternalStore } from 'react'
import { Button, Modal } from '@adhar/shell-ui'

/**
 * Define's confirm dialog. `confirmAction()` is the drop-in for the browser's
 * `confirm()` — same yes/no answer, but as the console's own modal (themed,
 * focus-trapped, Esc to cancel) instead of a native prompt. One `<ConfirmHost />`
 * lives in the module home and renders whichever question is pending.
 */
export interface ConfirmOptions {
  title: string
  description?: ReactNode
  /** Label of the confirming button. Defaults to "Delete". */
  confirmLabel?: string
  /** Destructive (rose) confirm button. Defaults to true. */
  danger?: boolean
}

type Pending = ConfirmOptions & { resolve(ok: boolean): void }

let pending: Pending | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

function settle(ok: boolean) {
  const p = pending
  pending = null
  emit()
  p?.resolve(ok)
}

export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  // No host on the page (a component rendered on its own): keep the native prompt.
  if (!listeners.size) {
    const text = typeof opts.description === 'string' ? `${opts.title}\n\n${opts.description}` : opts.title
    return Promise.resolve(typeof globalThis.confirm === 'function' ? globalThis.confirm(text) : false)
  }
  // A second question replaces the first, which answers "no".
  pending?.resolve(false)
  return new Promise((resolve) => {
    pending = { ...opts, resolve }
    emit()
  })
}

export function ConfirmHost() {
  const p = useSyncExternalStore(subscribe, () => pending, () => null)
  return (
    <Modal
      open={!!p}
      onClose={() => settle(false)}
      title={p?.title ?? ''}
      width="sm"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={() => settle(false)}>Cancel</Button>
          <Button size="sm" variant={p?.danger === false ? 'primary' : 'danger'} onClick={() => settle(true)} autoFocus>
            {p?.confirmLabel ?? 'Delete'}
          </Button>
        </>
      }
    >
      {p?.description
        ? <div className="text-sm leading-relaxed text-content-muted">{p.description}</div>
        : <span className="sr-only">{p?.title}</span>}
    </Modal>
  )
}
