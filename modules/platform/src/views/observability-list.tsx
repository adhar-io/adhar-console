import { Card, CardBody, CardHeader, EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import { useGeneric } from '../data/hooks.ts'
import { age } from '../data/format.ts'

const PROMETHEUS_GVR = {
  group: 'monitoring.coreos.com',
  version: 'v1',
  resource: 'prometheuses',
  namespaced: true,
}
const SERVICE_MONITOR_GVR = {
  group: 'monitoring.coreos.com',
  version: 'v1',
  resource: 'servicemonitors',
  namespaced: true,
}

/**
 * Observability overview. Shows whether the common monitoring operators are
 * deployed; deep metric dashboards are the Discover phase's job.
 */
export function ObservabilityView() {
  const prom = useGeneric(PROMETHEUS_GVR)
  const sm = useGeneric(SERVICE_MONITOR_GVR)

  const promStatus = detectInstallState(prom)
  const smStatus = detectInstallState(sm)

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <OperatorCard
          name="Prometheus Operator"
          state={promStatus}
          count={prom.data?.length ?? 0}
          docsHref="https://prometheus-operator.dev/docs/getting-started/installation/"
          description="Defines Prometheus / Alertmanager / ServiceMonitor CRDs. Required for in-cluster metrics scraping."
          rows={(prom.data ?? []).map((p) => ({
            name: p.metadata.name,
            ns: p.metadata.namespace ?? '—',
            version: ((p.spec as { version?: string }) ?? {}).version ?? '—',
            age: age(p.metadata.creationTimestamp),
          }))}
        />
        <OperatorCard
          name="ServiceMonitors"
          state={smStatus}
          count={sm.data?.length ?? 0}
          docsHref="https://prometheus-operator.dev/docs/user-guides/alerting/"
          description="Where Prometheus should scrape. A healthy cluster typically has at least kube-state-metrics + kubelet SMs."
          rows={(sm.data ?? []).slice(0, 6).map((m) => ({
            name: m.metadata.name,
            ns: m.metadata.namespace ?? '—',
            version: '—',
            age: age(m.metadata.creationTimestamp),
          }))}
        />
      </div>

      <Card>
        <CardHeader>
          <div className="text-sm font-semibold text-content">Open Discover phase</div>
        </CardHeader>
        <CardBody className="space-y-2">
          <p className="text-sm text-content-muted">
            Grafana dashboards, Loki logs, Mimir metrics, and Tempo traces live in the{' '}
            <span className="font-medium text-content">Discover</span> phase. Switch there from
            the sidebar to open dashboards against your LGTM stack.
          </p>
          <div className="text-xs text-content-subtle">
            Configure the Grafana URL via <code className="font-mono">GRAFANA_URL</code> — see{' '}
            <code className="font-mono">.env.example</code>.
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

type State = 'loading' | 'installed' | 'missing' | 'error'

function detectInstallState(q: { isLoading: boolean; isError: boolean; error: unknown; data?: unknown[] }): State {
  if (q.isLoading) return 'loading'
  if (q.isError) {
    const status = (q.error as { status?: number })?.status
    return status === 404 ? 'missing' : 'error'
  }
  return 'installed'
}

function OperatorCard({
  name,
  state,
  count,
  description,
  docsHref,
  rows,
}: {
  name: string
  state: State
  count: number
  description: string
  docsHref: string
  rows: Array<{ name: string; ns: string; version: string; age: string }>
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-content">{name}</div>
          <StateBadge state={state} count={count} />
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-sm text-content-muted">{description}</p>
        {state === 'missing' ? (
          <EmptyState
            compact
            title="Not installed"
            description={
              <>
                Install the operator to enable this view.{' '}
                <a
                  className="text-brand-700 underline"
                  target="_blank"
                  rel="noreferrer"
                  href={docsHref}
                >
                  Upstream docs
                </a>
                .
              </>
            }
          />
        ) : rows.length === 0 ? (
          <div className="text-xs text-content-subtle">No instances.</div>
        ) : (
          <ul className="divide-y divide-edge-subtle rounded-lg border border-edge-default bg-white">
            {rows.map((r, i) => (
              <li key={i} className="flex items-center justify-between px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-content">{r.name}</div>
                  <div className="text-xs text-content-muted">{r.ns}</div>
                </div>
                <div className="text-right text-xs">
                  <div className="font-mono text-content-muted">{r.version}</div>
                  <div className="text-content-subtle">{r.age}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

function StateBadge({ state, count }: { state: State; count: number }) {
  if (state === 'loading') return <StatusBadge kind="progressing">Checking…</StatusBadge>
  if (state === 'missing') return <StatusBadge kind="unknown">Not installed</StatusBadge>
  if (state === 'error') return <StatusBadge kind="failed">Error</StatusBadge>
  return <StatusBadge kind={count > 0 ? 'healthy' : 'paused'}>{count > 0 ? `${count} installed` : 'Installed, 0 instances'}</StatusBadge>
}
