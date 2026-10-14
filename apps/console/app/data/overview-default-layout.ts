/**
 * The default Overview arrangement, written as rows.
 *
 * Every row fills the 12-column grid exactly — one Full, two Halves, three
 * Thirds or four Quarters — so a fresh Overview has no ragged edges at any
 * desktop width. (Below `lg` every panel stacks full-width anyway.) Panels
 * are grouped so a row reads as one story: delivery, traffic, mesh, runtime
 * security, data, CI, code, tenancy, cost.
 *
 * `overview-default-layout_test.ts` holds the rows to that rule; add a panel
 * by adding or completing a row, never by appending a lone card.
 *
 * Deliberately no imports: the test loads this file on its own.
 */

export type DefaultSize = 'sm' | 'md' | 'lg' | 'xl'

/** Column span of each size on the 12-column desktop grid. */
export const SIZE_SPAN: Record<DefaultSize, number> = { sm: 3, md: 4, lg: 6, xl: 12 }

export const DEFAULT_ROWS: ReadonlyArray<ReadonlyArray<readonly [string, DefaultSize]>> = [
  [['dora', 'xl']],
  [['cluster', 'xl']],
  [['platform-health', 'lg'], ['resource-utilization', 'lg']],
  [['golden-signals', 'lg'], ['alerts', 'lg']],
  [['mesh-traffic', 'md'], ['latency-distribution', 'md'], ['top-error-sources', 'md']],
  [['traffic-stream', 'lg'], ['service-health-grid', 'lg']],
  [['mtls-coverage', 'md'], ['cilium-flows', 'md'], ['ingress-traffic', 'md']],
  [['runtime', 'md'], ['tetragon-runtime', 'md'], ['cert-expiry', 'md']],
  [['compliance', 'xl']],
  [['tools-health', 'lg'], ['k8s-events', 'lg']],
  [['database-pool', 'md'], ['cnpg-clusters', 'md'], ['cache-performance', 'md']],
  [['backup-status', 'md'], ['storage-treemap', 'md'], ['pod-restarts', 'md']],
  [['build-runtime', 'md'], ['pipeline-success', 'md'], ['workflow-triggers', 'md']],
  [['gitops-sync', 'md'], ['deploy-heatmap', 'md'], ['dora-radar', 'md']],
  [['engineering-velocity', 'lg'], ['team-activity', 'lg']],
  [['pr-throughput', 'md'], ['gitea-repos', 'md'], ['develop-prs', 'md']],
  [['tenant-overview', 'lg'], ['tenant-usage', 'lg']],
  [['define-issues', 'md'], ['sprint-progress', 'md'], ['issue-backlog', 'md']],
  [['cost-trend', 'md'], ['budget-bullet', 'md'], ['region-spread', 'md']],
  [['incident-timeline', 'md'], ['slo-health', 'md'], ['audit-log', 'md']],
  [['notifications', 'lg'], ['pinned-apps', 'lg']],
]

/**
 * Panels that exist but are off by default — sources the platform doesn't
 * ship populated (Kafka, Trivy, Airbyte, Metabase, PostHog) or views that
 * repeat a default one. Listed in complete rows too, so enabling a whole row
 * from Customize still lands flush.
 */
export const OPTIONAL_ROWS: ReadonlyArray<ReadonlyArray<readonly [string, DefaultSize]>> = [
  [['queue-depth', 'md'], ['kafka-brokers', 'md'], ['vuln-summary', 'md']],
  [['deliver-apps', 'md'], ['pipelines', 'md'], ['bi-dashboards', 'md']],
  [['business-kpis', 'lg'], ['analytics', 'lg']],
  [['service-topology', 'xl']],
]

export const rowSpan = (row: ReadonlyArray<readonly [string, DefaultSize]>): number =>
  row.reduce((n, [, size]) => n + SIZE_SPAN[size], 0)

/**
 * Fit a sequence of panel spans into full 12-column rows.
 *
 * Panels are placed in order; a panel that doesn't fit in the current row
 * starts the next one. A row left short — a panel switched off, a size
 * changed, a custom drag order — is closed by sharing the 12 columns evenly
 * among its panels (one to four panels always divide 12), so no layout the
 * user can produce leaves a hole. Rows that already fill exactly keep their
 * sizes untouched.
 */
export function packRows(spans: readonly number[]): number[] {
  const out: number[] = []
  let row: number[] = []
  let used = 0
  const close = () => {
    if (!row.length) return
    if (used === 12) out.push(...row)
    else if (12 % row.length === 0) out.push(...row.map(() => 12 / row.length))
    else out.push(...row.slice(0, -1), row[row.length - 1] + (12 - used))
    row = []
    used = 0
  }
  for (const raw of spans) {
    const s = Math.min(12, Math.max(1, Math.round(raw)))
    if (used + s > 12) close()
    row.push(s)
    used += s
  }
  close()
  return out
}
