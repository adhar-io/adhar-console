import { StatusBadge, type StatusKind } from '@adhar-console/shell-ui'
import { summarize, useDecideSignals } from '../data/k8s.ts'

interface Signal {
  name: string
  value: string
  kind: StatusKind
  sub?: string
}

export function HealthSummary() {
  const data = useDecideSignals()
  const s = summarize(data)

  const nodeKind: StatusKind =
    s.nodes.total === 0 ? 'unknown' : s.nodes.ready === s.nodes.total ? 'healthy' : 'progressing'
  const podKind: StatusKind = s.pods.failing > 0 ? 'degraded' : 'healthy'
  const depKind: StatusKind =
    s.healthyDeploymentsPct >= 95 ? 'healthy' : s.healthyDeploymentsPct >= 75 ? 'progressing' : 'degraded'
  const argoKind: StatusKind = !s.argo.installed
    ? 'unknown'
    : s.argo.synced === s.argo.total
      ? 'healthy'
      : 'progressing'
  const rolloutKind: StatusKind = !s.rollouts.installed
    ? 'unknown'
    : s.rollouts.healthy === s.rollouts.total
      ? 'healthy'
      : 'progressing'
  const policyKind: StatusKind = !s.policy.installed
    ? 'unknown'
    : s.policy.fail > 0
      ? 'degraded'
      : 'healthy'

  const signals: Signal[] = [
    {
      name: 'Nodes ready',
      value: `${s.nodes.ready} / ${s.nodes.total}`,
      kind: nodeKind,
    },
    {
      name: 'Pods running',
      value: `${s.pods.running} / ${s.pods.total}`,
      kind: podKind,
      sub: s.pods.failing ? `${s.pods.failing} failing` : undefined,
    },
    {
      name: 'Deployments healthy',
      value: `${s.healthyDeploymentsPct}%`,
      kind: depKind,
      sub: `${s.activeDeployments} / ${s.totalDeployments}`,
    },
    {
      name: 'ArgoCD synced',
      value: s.argo.installed ? `${s.argo.synced} / ${s.argo.total}` : 'not installed',
      kind: argoKind,
    },
    {
      name: 'Rollouts healthy',
      value: s.rollouts.installed ? `${s.rollouts.healthy} / ${s.rollouts.total}` : 'not installed',
      kind: rolloutKind,
    },
    {
      name: 'Policy compliance',
      value: s.policy.installed
        ? s.policy.fail === 0
          ? '100% pass'
          : `${s.policy.fail} failing`
        : 'not installed',
      kind: policyKind,
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {signals.map((sig) => (
        <div
          key={sig.name}
          className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm"
        >
          <div className="text-xs text-content-subtle">{sig.name}</div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="truncate text-xl font-semibold text-content">{sig.value}</div>
            <StatusBadge kind={sig.kind}>
              {sig.kind === 'healthy'
                ? 'OK'
                : sig.kind === 'degraded' || sig.kind === 'failed'
                  ? '!'
                  : sig.kind === 'unknown'
                    ? '—'
                    : '…'}
            </StatusBadge>
          </div>
          {sig.sub ? <div className="mt-1 text-xs text-content-muted">{sig.sub}</div> : null}
        </div>
      ))}
    </div>
  )
}
