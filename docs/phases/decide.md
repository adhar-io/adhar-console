# Phase · Decide

Cross-cutting executive / tech-lead view. Aggregates every other phase.

- **Primary backers:** derived — reads from LGTM (Prometheus/Mimir) and
  Workspace (audit, projects, envs).
- **Module:** `modules/decide` → exposes `./Home`, `./DoraSummary`.
- **Port in dev:** 5106.

## Top-line KPIs

Four headline cards driven by PromQL against Mimir:

- **Deploy frequency** — deploys-per-week per service.
- **Lead time for changes** — commit-to-prod median.
- **Change failure rate** — rollback count ÷ deploy count.
- **MTTR** — incident duration median.

## Sections

| Section        | Source                                                   |
| -------------- | -------------------------------------------------------- |
| DORA           | Per-service deploy / lead / CFR / MTTR + tier ranking    |
| Platform health| Clusters / nodes / apps synced / rollouts healthy        |
| Spend          | FinOps summary per tenant (Kubecost / custom collector)  |
| Posture        | Image vulns (Harbor), policy pass rate (Kyverno), SBOM%  |

## Rollups

All rollups are expressed as a PromQL query that the BFF forwards to Mimir.
Adding a new metric takes three steps:

1. Add a PromQL expression + label mapping to
   `modules/decide/src/views/<section>.tsx`.
2. Make sure the metric is produced somewhere (instrument a service,
   provision a recording rule, or add a Prometheus exporter).
3. Wire the query through the Discover BFF's `queryMetrics`.

## Who uses it

Engineering leaders, SREs, platform owners. "What's the health of my world
in one page."
