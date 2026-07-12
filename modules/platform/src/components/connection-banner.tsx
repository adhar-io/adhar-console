import { useConnection } from '../data/hooks.ts'
import { Spinner, StatusBadge } from '@adhar-console/shell-ui'

export function ConnectionGate({ children }: { children: React.ReactNode }) {
  const q = useConnection()
  if (q.isPending) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-edge-default bg-white px-5 py-4 text-sm text-content-muted shadow-sm">
        <Spinner />
        Connecting to the cluster…
      </div>
    )
  }
  if (q.isError) {
    return <NotConnected error={q.error} />
  }
  return <>{children}</>
}

function NotConnected({ error }: { error: unknown }) {
  const status = (error as { status?: number }).status
  const isUnauth = status === 401 || status === 403
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error'
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-6 shadow-sm">
      <div className="flex items-start gap-3">
        <StatusBadge kind={isUnauth ? 'failed' : 'degraded'}>
          {isUnauth ? 'Not authorized' : 'Cluster unreachable'}
        </StatusBadge>
        <div className="min-w-0 flex-1 text-sm text-amber-900">
          <div className="font-medium">Can't reach the Kubernetes API.</div>
          <p className="mt-1 text-amber-800/90">
            The console talks to your cluster via{' '}
            <code className="rounded bg-amber-100 px-1 font-mono text-[12px]">kubectl proxy</code>.
            {isUnauth
              ? ' Your kubeconfig user was rejected — check RBAC.'
              : ' Start the proxy in a separate terminal:'}
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-900 px-4 py-3 text-[12px] leading-relaxed text-slate-100">
            <span className="text-slate-500">$ </span>
            kubectl proxy --port=8001
          </pre>
          <p className="mt-3 text-xs text-amber-700">
            The console proxies <code className="font-mono">/kube-api/*</code> to
            <code className="font-mono"> http://127.0.0.1:8001</code>. Override with{' '}
            <code className="font-mono">ADHAR_K8S_PROXY</code> before running{' '}
            <code className="font-mono">pnpm dev</code>.
          </p>
          <details className="mt-3 text-xs text-amber-700">
            <summary className="cursor-pointer font-medium">Raw error</summary>
            <pre className="mt-2 overflow-x-auto rounded bg-amber-100/80 p-2 font-mono text-[11px] text-amber-900">
              {status ? `HTTP ${status} · ` : ''}
              {message}
            </pre>
          </details>
        </div>
      </div>
    </div>
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
