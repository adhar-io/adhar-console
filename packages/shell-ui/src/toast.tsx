import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@adhar-console/utils'

/**
 * Application-wide toasts — the ONE way to confirm an outcome to the user.
 *
 * Design rule (see memory: ui-layout-conventions): never render inline text
 * like "Changes saved." — call `toast.success('Changes saved')` instead so
 * success / error / warning / info feedback looks the same everywhere,
 * stacks in the bottom-right, auto-dismisses (errors stay longer), can carry
 * an action ("Undo", "View"), and is announced to assistive tech.
 *
 * Usage:
 *   const toast = useToast()
 *   toast.success('Team created', { description: 'Synced to Keycloak.' })
 *   toast.error('Could not save', { description: err.message })
 *   toast.promise(save(), { loading: 'Saving…', success: 'Saved', error: (e) => e.message })
 *
 * `ToastProvider` is mounted once by the host (`main.tsx`); remotes reach it
 * through the shared shell-ui singleton. Outside a provider the hook degrades
 * to console logging so library code never crashes.
 */

export type ToastKind = 'success' | 'error' | 'warning' | 'info' | 'loading'

export interface ToastOptions {
  description?: ReactNode
  /** ms before auto-dismiss; `0` keeps it until closed. Defaults per kind. */
  duration?: number
  action?: { label: string; onClick(): void }
  /** Reuse an id to update an existing toast in place. */
  id?: string
}

export interface Toast extends ToastOptions {
  id: string
  kind: ToastKind
  title: ReactNode
  createdAt: number
}

export interface ToastApi {
  show(kind: ToastKind, title: ReactNode, opts?: ToastOptions): string
  success(title: ReactNode, opts?: ToastOptions): string
  error(title: ReactNode, opts?: ToastOptions): string
  warning(title: ReactNode, opts?: ToastOptions): string
  info(title: ReactNode, opts?: ToastOptions): string
  loading(title: ReactNode, opts?: ToastOptions): string
  dismiss(id: string): void
  /** Track an async operation: loading → success | error, updated in place. */
  promise<T>(
    p: Promise<T>,
    msgs: {
      loading: ReactNode
      success: ReactNode | ((v: T) => ReactNode)
      error?: ReactNode | ((e: unknown) => ReactNode)
    },
  ): Promise<T>
}

const DEFAULT_DURATION: Record<ToastKind, number> = {
  success: 4000,
  info: 5000,
  warning: 7000,
  error: 9000,
  loading: 0,
}

const MAX_VISIBLE = 5

const ToastContext = createContext<ToastApi | null>(null)

let seq = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef(new Map<string, number>())

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id)
    if (t) globalThis.clearTimeout(t)
    timers.current.delete(id)
    setToasts((prev) => prev.filter((x) => x.id !== id))
  }, [])

  const schedule = useCallback(
    (id: string, kind: ToastKind, duration?: number) => {
      const ms = duration ?? DEFAULT_DURATION[kind]
      const existing = timers.current.get(id)
      if (existing) globalThis.clearTimeout(existing)
      if (ms > 0) timers.current.set(id, globalThis.setTimeout(() => dismiss(id), ms))
    },
    [dismiss],
  )

  const show = useCallback(
    (kind: ToastKind, title: ReactNode, opts: ToastOptions = {}) => {
      const id = opts.id ?? `t${++seq}`
      setToasts((prev) => {
        const next: Toast = { ...opts, id, kind, title, createdAt: Date.now() }
        const idx = prev.findIndex((x) => x.id === id)
        if (idx >= 0) return prev.map((x, i) => (i === idx ? next : x))
        return [...prev, next].slice(-MAX_VISIBLE)
      })
      schedule(id, kind, opts.duration)
      return id
    },
    [schedule],
  )

  useEffect(() => {
    const map = timers.current
    return () => map.forEach((t) => globalThis.clearTimeout(t))
  }, [])

  const api = useMemo<ToastApi>(() => {
    const mk = (kind: ToastKind) => (title: ReactNode, opts?: ToastOptions) => show(kind, title, opts)
    return {
      show,
      success: mk('success'),
      error: mk('error'),
      warning: mk('warning'),
      info: mk('info'),
      loading: mk('loading'),
      dismiss,
      promise: async (p, msgs) => {
        const id = show('loading', msgs.loading)
        try {
          const v = await p
          show('success', typeof msgs.success === 'function' ? msgs.success(v) : msgs.success, { id })
          return v
        } catch (e) {
          const err = msgs.error
          show(
            'error',
            typeof err === 'function' ? err(e) : err ?? (e instanceof Error ? e.message : 'Something went wrong'),
            { id },
          )
          throw e
        }
      },
    }
  }, [show, dismiss])

  return (
    <ToastContext.Provider value={api}>
      {children}
      {typeof document !== 'undefined' ? createPortal(<Viewport toasts={toasts} onDismiss={dismiss} />, document.body) : null}
    </ToastContext.Provider>
  )
}

const FALLBACK: ToastApi = (() => {
  const log = (kind: ToastKind) => (title: ReactNode) => {
    console[kind === 'error' ? 'error' : kind === 'warning' ? 'warn' : 'info'](`[toast:${kind}]`, title)
    return ''
  }
  return {
    show: (kind, title) => log(kind)(title),
    success: log('success'),
    error: log('error'),
    warning: log('warning'),
    info: log('info'),
    loading: log('loading'),
    dismiss: () => {},
    promise: async (p) => p,
  }
})()

/** Toast API — safe to call anywhere; no-ops (logs) when no provider is mounted. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? FALLBACK
}

/* ─────────── viewport ─────────── */

function Viewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss(id: string): void }) {
  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      className="pointer-events-none fixed bottom-4 right-4 z-[120] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  )
}

const KIND_STYLE: Record<ToastKind, { ring: string; icon: string; bar: string }> = {
  success: { ring: 'border-emerald-200 dark:border-emerald-500/30', icon: 'bg-emerald-500 text-white', bar: 'bg-emerald-500' },
  error: { ring: 'border-rose-200 dark:border-rose-500/30', icon: 'bg-rose-500 text-white', bar: 'bg-rose-500' },
  warning: { ring: 'border-amber-200 dark:border-amber-500/30', icon: 'bg-amber-500 text-white', bar: 'bg-amber-500' },
  info: { ring: 'border-sky-200 dark:border-sky-500/30', icon: 'bg-sky-500 text-white', bar: 'bg-sky-500' },
  loading: { ring: 'border-edge-default', icon: 'bg-surface-sunken text-content-muted', bar: 'bg-brand-500' },
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss(): void }) {
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])
  const s = KIND_STYLE[toast.kind]
  const duration = toast.duration ?? DEFAULT_DURATION[toast.kind]
  return (
    <div
      role={toast.kind === 'error' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto relative overflow-hidden rounded-xl border bg-surface-raised shadow-lg ring-1 ring-black/5 transition-all duration-200 ease-out dark:ring-white/10',
        s.ring,
        entered ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
      )}
    >
      <div className="flex items-start gap-3 p-3 pr-2">
        <span className={cn('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full', s.icon)}>
          <KindIcon kind={toast.kind} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-5 text-content">{toast.title}</div>
          {toast.description ? <div className="mt-0.5 text-[12px] leading-relaxed text-content-muted">{toast.description}</div> : null}
          {toast.action ? (
            <button
              type="button"
              onClick={() => {
                toast.action?.onClick()
                onDismiss()
              }}
              className="mt-1.5 text-[12px] font-semibold text-brand-700 hover:underline dark:text-brand-300"
            >
              {toast.action.label}
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      {duration > 0 ? (
        <span
          aria-hidden
          className={cn('absolute bottom-0 left-0 h-0.5 opacity-60', s.bar)}
          style={{ width: '100%', animation: `adhar-toast-drain ${duration}ms linear forwards` }}
        />
      ) : null}
      <style>{`@keyframes adhar-toast-drain { from { width: 100%; } to { width: 0%; } }`}</style>
    </div>
  )
}

function KindIcon({ kind }: { kind: ToastKind }) {
  const common = { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  switch (kind) {
    case 'success':
      return <svg {...common}><path d="M20 6 9 17l-5-5" /></svg>
    case 'error':
      return <svg {...common}><path d="M18 6 6 18M6 6l12 12" /></svg>
    case 'warning':
      return <svg {...common}><path d="M12 8v5M12 17h.01" /></svg>
    case 'info':
      return <svg {...common}><path d="M12 11v6M12 7h.01" /></svg>
    default:
      return (
        <svg {...common} className="animate-spin" strokeWidth={3}>
          <circle cx="12" cy="12" r="9" strokeOpacity="0.25" />
          <path d="M21 12a9 9 0 0 0-9-9" />
        </svg>
      )
  }
}
