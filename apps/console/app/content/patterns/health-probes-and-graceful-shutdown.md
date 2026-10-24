---
title: Health probes and graceful shutdown
category: Resilience
summary: Tell Kubernetes when a pod can take traffic and give it time to finish in-flight work before it stops.
tools: [Kubernetes, Argo Rollouts, Scorecards, Kyverno]
order: 15
---

## Why
Without a readiness probe, a pod gets traffic before it can serve. Without a graceful shutdown, every deploy, scale-down and node drain cuts the requests that were in flight. Both look like random 502s, and both are cheap to fix.

## How Adhar does it
- **Templates set it up.** The `go-web-service` skeleton's Rollout has readiness and liveness probes on `/healthz`, a `preStop` sleep of 5 seconds, `terminationGracePeriodSeconds: 30` and a PodDisruptionBudget.
- **Scorecards check it.** The platform scorer has a `probes` signal (every container has probes) and a `graceful_shutdown` signal (every container has a `preStop` hook) — see [Scorecards](/scorecards).
- **Policy can audit it.** The optional `adhar-policy-packs` package includes `soc2-require-pod-probes` in Audit mode. Nothing enforces probes by default.

## Use it
```yaml
readinessProbe:
  httpGet: { path: /healthz, port: http }
  periodSeconds: 5
livenessProbe:
  httpGet: { path: /healthz, port: http }
  initialDelaySeconds: 10
lifecycle:
  preStop: { exec: { command: ["sleep", "5"] } }
```
In the app: on `SIGTERM`, stop accepting new work, finish what is in flight, then exit — within the grace period.

## Watch out
- Liveness must not check dependencies; a slow database would then restart every pod at once.
- Use a `startupProbe` for slow starters (JVMs) instead of a long liveness delay.
- The `preStop` sleep covers the time endpoints take to drop the pod; without it, traffic still arrives after `SIGTERM`.
