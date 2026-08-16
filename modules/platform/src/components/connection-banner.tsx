import { useConnection } from '../data/hooks.ts'
import { Button } from '@adhar-console/shell-ui'

/**
 * Gate for the Kubernetes-backed platform views. The connection to the cluster
 * is made transparently in the background through the console's authenticated
 * gateway (`/api/k8s`) — there is nothing for the user to run or configure.
 *
 *   - connecting → a calm, centered loading state (no jarring banner)
 *   - connected  → the children render
 *   - failed     → a clean, illustrated error screen with a Retry action
 */
export function ConnectionGate({ children }: { children: React.ReactNode }) {
  const q = useConnection()
  if (q.isPending) return <Connecting />
  if (q.isError) return <NotConnected error={q.error} onRetry={() => q.refetch()} />
  return <>{children}</>
}

function Connecting() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[40vh] flex-col items-center justify-center gap-4 text-center"
    >
      <ClusterMark pulse />
      <p className="text-sm text-content-muted">Connecting to your cluster…</p>
    </div>
  )
}

function NotConnected({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const status = (error as { status?: number })?.status
  const isUnauth = status === 401 || status === 403
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error'

  const title = isUnauth ? 'Not authorized for this cluster' : 'Can’t reach the cluster'
  const body = isUnauth
    ? 'Your account is signed in, but it doesn’t have permission to view these resources. Ask a platform administrator to grant the right Kubernetes RBAC role.'
    : 'The console couldn’t reach the Kubernetes API just now. This is usually temporary — retry in a moment. If it keeps happening, the cluster may be starting up or unavailable.'

  return (
    <div className="flex min-h-[52vh] items-center justify-center px-4">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-6 w-fit">
          <ClusterIllustration unauthorized={isUnauth} />
        </div>
        <h2 className="text-lg font-semibold tracking-tight text-content">{title}</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-content-muted">{body}</p>

        <div className="mt-6 flex items-center justify-center gap-2.5">
          {!isUnauth ? (
            <Button variant="primary" onClick={onRetry}>
              <RetryIcon /> Try again
            </Button>
          ) : null}
          <a
            href="/api/diagnostics"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-3 text-sm font-medium text-content-muted shadow-sm transition-colors hover:border-edge-strong hover:text-content"
          >
            Run diagnostics <ExternalIcon />
          </a>
        </div>

        <details className="group mx-auto mt-6 max-w-sm text-left">
          <summary className="cursor-pointer list-none text-center text-[11px] font-medium text-content-subtle transition-colors hover:text-content-muted">
            <span className="group-open:hidden">Show technical details</span>
            <span className="hidden group-open:inline">Hide technical details</span>
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-lg border border-edge-subtle bg-surface-sunken px-3 py-2 font-mono text-[11px] leading-relaxed text-content-muted">
            {status ? `HTTP ${status} · ` : ''}
            {message}
          </pre>
        </details>
      </div>
    </div>
  )
}

/* ─────────── illustration ─────────── */

/** Small hexagon cluster mark (used in the connecting state). */
function ClusterMark({ pulse }: { pulse?: boolean }) {
  return (
    <span
      className={`inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-500/10 text-brand-600 ring-1 ring-inset ring-brand-500/20 dark:text-brand-300 ${
        pulse ? 'motion-safe:animate-pulse' : ''
      }`}
    >
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 2 3.5 7v10L12 22l8.5-5V7L12 2Z" />
        <circle cx="12" cy="12" r="2.6" />
        <path d="M12 4.4v4.9M12 14.6v4.9M5.8 8.3l4.1 2.4M14.1 13.3l4.1 2.4M18.2 8.3l-4.1 2.4M9.9 13.3l-4.1 2.4" />
      </svg>
    </span>
  )
}

/**
 * A calm illustrated state for the error screen — a cluster hexagon with a
 * broken link (unreachable) or a shield/lock accent (unauthorized), tinted with
 * the active theme's brand/amber tokens. Theme-aware, no hardcoded colors.
 */
function ClusterIllustration({ unauthorized }: { unauthorized?: boolean }) {
  const tint = unauthorized
    ? 'text-amber-500 bg-amber-500/10 ring-amber-500/20'
    : 'text-brand-500 bg-brand-500/10 ring-brand-500/20 dark:text-brand-300'
  return (
    <div className={`relative flex h-24 w-24 items-center justify-center rounded-3xl ring-1 ring-inset ${tint}`}>
      <svg width="56" height="56" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M24 4 8 13v18l16 9 16-9V13L24 4Z" opacity="0.9" />
        <circle cx="24" cy="24" r="4.5" />
        <path d="M24 8v7M24 29v7" opacity="0.5" />
        {unauthorized ? (
          <>
            <rect x="19.5" y="21.5" width="9" height="7" rx="1.5" fill="currentColor" fillOpacity="0.15" />
            <path d="M21.5 21.5v-1.5a2.5 2.5 0 0 1 5 0v1.5" />
          </>
        ) : (
          <>
            <path d="M13 15.5 20 19.5M35 15.5 28 19.5" opacity="0.5" />
            {/* broken link glyph */}
            <path d="M30 30l-3.2 3.2a3.5 3.5 0 0 1-5-5l1.6-1.6" strokeDasharray="0.1 3.2" />
            <path d="M18 34l3.2-3.2a3.5 3.5 0 0 1 5 5L24.6 37.4" strokeDasharray="0.1 3.2" />
          </>
        )}
      </svg>
    </div>
  )
}

function RetryIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  )
}
function ExternalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 17 17 7M8 7h9v9" />
    </svg>
  )
}

export function RelativeTime({ iso }: { iso?: string }) {
  if (!iso) return <span>—</span>
  const ms = Date.now() - new Date(iso).getTime()
  return <span title={iso}>{humanize(ms)}</span>
}

function humanize(ms: number): string {
  if (ms < 0) return 'now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}
