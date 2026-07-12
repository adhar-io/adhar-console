import { Card, CardBody, CardHeader, Sparkline, StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import type { metabase } from '@adhar-console/api-clients'
import { KpiCard } from './kpi-card.tsx'
import { summarize, useDecideSignals } from '../data/k8s.ts'
import { useDashboards, useQuestions } from '../data/bi.ts'
import { DoraSummary } from './dora.tsx'
import { HealthSummary } from './health-summary.tsx'
import { SpendSummary } from './spend.tsx'

/**
 * Decide overview — the original cross-cutting analytics page, now with a
 * BI hero strip on top showing Metabase scalar KPIs and links into the
 * BI dashboards.
 */
export function Overview() {
  const data = useDecideSignals()
  const s = summarize(data)
  const questions = useQuestions()
  const dashboards = useDashboards()

  const scalarQuestions = (questions.data ?? []).filter((q) => q.scalar != null && q.display === 'scalar')

  return (
    <div className="space-y-8">
      {scalarQuestions.length > 0 ? (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-content-subtle">
              Business KPIs
            </h2>
            <a
              href="?dashboards"
              className="text-[11px] font-medium text-brand-700 hover:underline"
            >
              All BI dashboards →
            </a>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {scalarQuestions.slice(0, 4).map((q) => (
              <BiScalarCard key={q.id} q={q} />
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-content-subtle">
            Platform KPIs
          </h2>
          <span className="text-xs text-content-subtle">live · 15s refresh</span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Deploy frequency (7d)"
            value={`${s.deployFrequencyPerWeek} / week`}
            delta={s.deployFrequencyPerWeek > 0 ? 'live cluster' : 'no recent'}
            trend={s.deployFrequencyPerWeek > 0 ? 'up' : 'flat'}
            accent={s.deployFrequencyPerWeek > 0 ? 'emerald' : 'slate'}
          />
          <KpiCard
            label="Healthy deployments"
            value={`${s.healthyDeploymentsPct}%`}
            delta={`${s.activeDeployments} / ${s.totalDeployments}`}
            trend={s.healthyDeploymentsPct >= 95 ? 'up' : s.healthyDeploymentsPct >= 75 ? 'flat' : 'down'}
            accent={
              s.healthyDeploymentsPct >= 95 ? 'emerald' : s.healthyDeploymentsPct >= 75 ? 'amber' : 'rose'
            }
          />
          <KpiCard
            label="Pods running"
            value={`${s.pods.running} / ${s.pods.total}`}
            delta={s.pods.failing ? `${s.pods.failing} failing` : 'no failures'}
            trend={s.pods.failing ? 'down' : 'up'}
            accent={s.pods.failing ? 'rose' : 'emerald'}
          />
          <KpiCard
            label="Nodes ready"
            value={`${s.nodes.ready} / ${s.nodes.total}`}
            delta={s.nodes.ready === s.nodes.total ? 'all green' : 'attention'}
            trend={s.nodes.ready === s.nodes.total ? 'up' : 'down'}
            accent={s.nodes.ready === s.nodes.total ? 'emerald' : 'amber'}
          />
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-content-subtle">
            DORA
          </h2>
          <a href="?dora" className="text-[11px] font-medium text-brand-700 hover:underline">
            Open DORA →
          </a>
        </div>
        <DoraSummary />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-content-subtle">
          Platform health
        </h2>
        <HealthSummary />
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-content-subtle">
            Spend
          </h2>
          <a href="?spend" className="text-[11px] font-medium text-brand-700 hover:underline">
            Open Spend →
          </a>
        </div>
        <SpendSummary />
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-content-subtle">
            Compliance & security posture
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Card>
            <CardBody>
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-content">Policy compliance</div>
                {s.policy.installed ? (
                  <StatusBadge kind={s.policy.fail === 0 ? 'healthy' : 'degraded'}>
                    {s.policy.fail === 0
                      ? '100% pass'
                      : `${Math.round((s.policy.pass / Math.max(s.policy.pass + s.policy.fail, 1)) * 100)}% pass`}
                  </StatusBadge>
                ) : (
                  <StatusBadge kind="unknown">Kyverno not installed</StatusBadge>
                )}
              </div>
              <div className="mt-2 text-xs text-content-muted">
                {s.policy.installed
                  ? `${s.policy.fail} failing · ${s.policy.warn} warnings · ${s.policy.pass} passes`
                  : 'Install Kyverno to see policy reports aggregated here.'}
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-content">GitOps drift</div>
                {s.argo.installed ? (
                  <StatusBadge kind={s.argo.synced === s.argo.total ? 'healthy' : 'degraded'}>
                    {s.argo.synced} / {s.argo.total} synced
                  </StatusBadge>
                ) : (
                  <StatusBadge kind="unknown">Argo CD not installed</StatusBadge>
                )}
              </div>
              <div className="mt-2 text-xs text-content-muted">
                {s.argo.installed
                  ? `${s.argo.healthy} apps healthy · live across every namespace`
                  : 'Install Argo CD to track GitOps drift across your apps.'}
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-content">Image vulnerabilities</div>
                <StatusBadge kind="unknown">Harbor external</StatusBadge>
              </div>
              <div className="mt-2 text-xs text-content-muted">
                Wired via the Trivy operator — see Deliver → Vuln scans for the full vulnerability table.
              </div>
            </CardBody>
          </Card>
        </div>
      </section>

      {dashboards.data?.length ? (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-content-subtle">
              BI dashboards
            </h2>
            <a href="?dashboards" className="text-[11px] font-medium text-brand-700 hover:underline">
              All boards →
            </a>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {dashboards.data.slice(0, 3).map((d) => (
              <Card key={d.id}>
                <CardHeader>
                  <div className="text-sm font-semibold text-content">{d.name}</div>
                  <div className="text-[11px] text-content-subtle">{d.description}</div>
                </CardHeader>
                <CardBody className="flex items-center justify-between">
                  <span className="text-[11px] text-content-muted">
                    {d.cards.length} cards · {d.view_count ?? 0} views
                  </span>
                  <a
                    href={`?dashboards`}
                    className="text-[11px] font-medium text-brand-700 hover:underline"
                  >
                    Open →
                  </a>
                </CardBody>
              </Card>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}

function BiScalarCard({ q }: { q: metabase.Question }) {
  const delta = q.scalar_delta ?? 0
  const tone = delta >= 0 ? 'emerald' : 'rose'
  const formatted = formatScalar(q.scalar ?? 0, q.scalar_unit)
  return (
    <Card className="bg-linear-to-br from-brand-50 to-white ring-1 ring-inset ring-edge-subtle">
      <CardBody className="space-y-1 p-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
          {q.name}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums tracking-tight text-content">
            {formatted}
          </span>
          {q.scalar_delta != null ? (
            <span className={`text-[12px] font-mono tabular-nums ${tone === 'emerald' ? 'text-emerald-700' : 'text-rose-700'}`}>
              {delta >= 0 ? '+' : ''}
              {(delta * 100).toFixed(1)}%
            </span>
          ) : null}
        </div>
        {q.updated_at ? (
          <div className="text-[10px] text-content-subtle">
            updated {formatRelative(q.updated_at)} · {q.view_count ?? 0} views
          </div>
        ) : null}
        {q.result?.kind === undefined && q.result?.rows ? (
          <div className="mt-1 -mb-1">
            <Sparkline
              points={q.result.rows.map((r) => Number(r[1] ?? 0))}
              color="var(--color-brand-500)"
              height={20}
              strokeWidth={1.5}
            />
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}

function formatScalar(v: number, unit?: string): string {
  if (unit === 'USD') {
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
    if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
    return `$${v.toFixed(0)}`
  }
  if (unit === '%') return `${(v * 100).toFixed(1)}%`
  if (unit === '×') return `${v.toFixed(2)}×`
  if (unit === 'min') return `${v.toFixed(0)} min`
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M ${unit ?? ''}`.trim()
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K ${unit ?? ''}`.trim()
  return `${v.toFixed(0)} ${unit ?? ''}`.trim()
}
