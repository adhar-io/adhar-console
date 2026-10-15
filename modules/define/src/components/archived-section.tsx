import { useState } from 'react'
import { Button, Spinner, useToast } from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import { planeError } from '../data/plane.ts'

/**
 * A collapsed "Archived" section under a list of cycles or modules. Nothing
 * is fetched until it is opened — archive lists only grow, and Plane's API
 * key is shared by everyone under a per-minute limit.
 */
export function ArchivedSection({ noun, open, onToggle, loading, items, onRestore, restoring }: {
  noun: string
  open: boolean
  onToggle(): void
  loading: boolean
  items: Array<{ id: string; name: string; archived_at?: string | null; meta?: string }>
  onRestore(id: string): Promise<unknown>
  restoring: boolean
}) {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  return (
    <section className="border-t border-edge-subtle pt-4">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-content-subtle hover:text-content">
        <span className={open ? 'rotate-90 transition-transform' : 'transition-transform'}>›</span>
        Archived {noun}s{open && !loading ? ` · ${items.length}` : ''}
      </button>
      {open ? (
        loading ? (
          <div className="mt-3 flex items-center gap-2 text-[12px] text-content-muted"><Spinner size={12} /> Loading…</div>
        ) : items.length === 0 ? (
          <p className="mt-3 text-[12px] text-content-subtle">Nothing archived. Archiving hides a finished {noun} without losing its history.</p>
        ) : (
          <ul className="mt-3 divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-raised">
            {items.map((it) => (
              <li key={it.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                <span className="min-w-0 flex-1 truncate text-content">{it.name}</span>
                {it.meta ? <span className="text-[11px] text-content-subtle">{it.meta}</span> : null}
                {it.archived_at ? <span className="text-[11px] text-content-subtle">archived {formatRelative(it.archived_at)}</span> : null}
                <Button
                  size="xs"
                  loading={restoring && busy === it.id}
                  onClick={async () => {
                    setBusy(it.id)
                    try {
                      await onRestore(it.id)
                      toast.success(`Restored ${it.name}`)
                    } catch (e) {
                      toast.error(planeError(e, `Couldn't restore the ${noun}.`))
                    } finally {
                      setBusy(null)
                    }
                  }}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  )
}
