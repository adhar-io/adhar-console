---
title: Observability by default
category: Operations
summary: Metrics, logs, traces and profiles for every service from its first deploy — correlated, not four separate tools.
tools: [Prometheus, Mimir, Loki, Tempo, Grafana, Alloy, Beyla, Pyroscope, OpenTelemetry]
order: 10
---

## Why
You can't fix what you can't see, and the time to add instrumentation is not during the incident. When telemetry is part of the platform, every service is observable on day one and every signal links to the others.

## How Adhar does it
- **Metrics** — Prometheus scrapes every ServiceMonitor; Mimir keeps long-term data.
- **Logs** — Loki, labelled with namespace, app and tenant.
- **Traces** — Tempo, fed by OpenTelemetry through **Alloy**; **Beyla** auto-instruments HTTP/gRPC services with eBPF — no code change.
- **Profiles** — Pyroscope for continuous CPU and memory profiling.
- The console's [Discover](/discover?section=dashboard) and the service map join them: from a slow endpoint to its trace, to the pod's logs at that second.

## Use it
Log in JSON with a `trace_id` field, expose `/metrics`, and propagate W3C `traceparent` headers — the rest is collected for you.

## Watch out
- **Cardinality** is the cost driver: never put user ids or request ids in metric labels.
- Sample traces (keep all errors, a fraction of successes).
- Dashboards nobody reads are noise; alert on symptoms users feel.
