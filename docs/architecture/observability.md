# Observability (LGTM)

The console exposes three layers: **Grafana** dashboards (overview),
**Loki** (logs), **Mimir** (metrics), **Tempo** (traces), all tied together
by **OpenTelemetry** + **Beyla** for instrumentation.

## Data sources

| Source      | What it carries                                      | Ingested by           |
| ----------- | ---------------------------------------------------- | --------------------- |
| Prometheus  | Real-time scrape metrics                             | Mimir (long-term)     |
| OpenTelemetry Collector | OTLP traces, metrics, logs from any instrumented workload | Mimir, Tempo, Loki |
| Beyla       | eBPF auto-instrumentation (HTTP, gRPC, DB) — no code | OTel Collector        |
| Fluentbit   | Container logs from every node                       | Loki                  |

## In the console

The **Discover** phase (`modules/discover`) has four tabs:

- **Dashboards** — Grafana embeds (`kiosk=tv` mode) for curated views.
- **Logs** — LogQL query box, results streamed from Loki.
- **Metrics** — PromQL query box, results rendered as inline sparklines.
  Uses `modules/discover/src/views/sparkline.tsx` to avoid a charting lib in
  v1; graduates to Grafana scene panels in v0.3.x.
- **Traces** — Tempo search by service + time range.

Every view goes through the BFF's LGTM client, which talks to the
Grafana-proxied endpoints for Loki/Mimir/Tempo. Same auth context as the
rest of the console — no separate Grafana login.

## Cross-phase observability hooks

- **Develop → Discover.** Clicking a pipeline in Workflows deep-links to
  its traces in the Discover tab.
- **Deliver → Discover.** An ArgoCD Application card has "open dashboard"
  that jumps to a service-specific Grafana dashboard.
- **Platform → Discover.** Pod detail has a "logs" link that pre-fills a
  Loki query scoped to that pod.
- **Decide.** Aggregates (DORA KPIs, health score, spend) are Prometheus
  queries against metrics Mimir has accumulated.

## Console-native signals

What the console itself produces:

- **Traces.** Deno-native fetch is auto-instrumented by Beyla at the node
  level, so each BFF server function becomes a span. SSR render is also
  wrapped as a span.
- **Metrics.** Standard Nitro `/metrics` endpoint on port 3000.
- **Logs.** Structured JSON to stdout with `{ level, msg, tenantId, userId,
  requestId }`. Request-id is forwarded to every downstream client call so
  a trace connects "user clicked" → "Gitea returned".

## Dashboards we ship

`modules/discover/src/views/dashboards.tsx` hard-codes a starter set. Real
dashboard UIDs are provisioned into Grafana via its file provisioning
(`adhar-platform/grafana-dashboards` — separate repo; not in v1 of the
console).

- **Cluster overview** — node/pod counts, saturation.
- **Golden signals** — by service.
- **Deployments** — rollout health, version drift.
- **Service map (OTel)** — dependency graph from spans.
- **Beyla network (eBPF)** — traffic without code instrumentation.

## Retention + cost

Configurable per org, defaults on the Business plan:

| Signal  | Retention   |
| ------- | ----------- |
| Metrics | 13 months   |
| Logs    | 30 days hot, 180 days cold in object storage |
| Traces  | 7 days      |

All three stores scale independently. Mimir storage is dominant for large
tenants; Loki is cheap thanks to chunk compression. Traces almost never
dominate unless you're tracing the web tier at 100% sample rate.
