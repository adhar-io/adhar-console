import { useCallback, useEffect, useRef, useState } from 'react'
import { docStore, DocStoreError, useOptionalUser } from '@adhar/shell-ui'
import { type DashboardLayout, defaultLayout, normalizeLayout } from './dashboard-layout.ts'

/**
 * Per-user dashboard layout, saved in docStore (`define.dashboard`, one
 * document per console user). When the console has no database the layout
 * still works for this browser (localStorage) and the view says so.
 */

const KIND = 'define.dashboard'
const LOCAL = 'adhar.define.dashboard'

export function layoutDocId(userId: string): string {
  const s = `u-${userId}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120)
  return /^[A-Za-z0-9]/.test(s) ? s : `u${s}`
}

function readLocal(): DashboardLayout | null {
  try {
    const raw = localStorage.getItem(LOCAL)
    return raw ? normalizeLayout(JSON.parse(raw)) : null
  } catch {
    return null
  }
}
function writeLocal(l: DashboardLayout) {
  try {
    localStorage.setItem(LOCAL, JSON.stringify(l))
  } catch { /* private mode */ }
}

export type LayoutPersistence = 'loading' | 'account' | 'browser'

export function useDashboardLayout() {
  const user = useOptionalUser()
  const [layout, setLayout] = useState<DashboardLayout>(() => readLocal() ?? defaultLayout())
  const [persistence, setPersistence] = useState<LayoutPersistence>('loading')
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = user ? layoutDocId(user.id) : null

  useEffect(() => {
    if (!id) {
      setPersistence('browser')
      return
    }
    let cancelled = false
    docStore.get<DashboardLayout>(KIND, id)
      .then((doc) => {
        if (cancelled) return
        if (doc) {
          const l = normalizeLayout(doc.data)
          setLayout(l)
          writeLocal(l)
        }
        setPersistence('account')
      })
      .catch(() => !cancelled && setPersistence('browser'))
    return () => {
      cancelled = true
    }
  }, [id])

  const update = useCallback(
    (next: DashboardLayout) => {
      setLayout(next)
      writeLocal(next)
      if (!id || persistence === 'browser') return
      if (timer.current) clearTimeout(timer.current)
      // Debounced: dragging through several positions writes once.
      timer.current = setTimeout(() => {
        docStore.put(KIND, id, next).then(() => setError(null)).catch((e) => {
          setError(e instanceof DocStoreError ? e.message : 'Could not save the layout.')
          setPersistence('browser')
        })
      }, 600)
    },
    [id, persistence],
  )

  return { layout, update, persistence, error, reset: () => update(defaultLayout()) }
}
