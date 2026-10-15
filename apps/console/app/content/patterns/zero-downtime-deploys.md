---
title: Zero-downtime deploys
category: Resilience
summary: Ship every change without dropping a request — new pods take traffic only when ready, old ones drain before they stop.
tools: [Kubernetes, Argo CD, Argo Rollouts]
order: 10
---

## Why
Most outages are self-inflicted: a deploy that kills pods mid-request, a pod that receives traffic before it can serve, a migration that breaks the version still running. Zero downtime is a set of small habits, not a product.

## How Adhar does it
Argo CD applies every change as a **rolling update** (or a Rollout), and the platform's golden-path templates ship the pieces that make it safe: readiness and liveness probes, a PodDisruptionBudget, resource requests and a graceful shutdown window.

## Use it
```yaml
spec:
  replicas: 3
  strategy: { type: RollingUpdate, rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } }
  template:
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: api
          readinessProbe: { httpGet: { path: /readyz, port: 8080 } }
          lifecycle: { preStop: { exec: { command: ["sleep", "5"] } } }
```
Plus a `PodDisruptionBudget` with `minAvailable: 2` so node drains and upgrades can't take you to zero.

## Watch out
- **Database changes go expand → migrate → contract**: add the column, deploy code that writes both, backfill, then remove the old one in a later release. Never ship a schema change the running version can't read.
- `/readyz` must check the app can serve, not that its dependencies are perfect — or one slow database marks every pod unready.
- The `preStop` sleep gives load balancers time to stop routing before the process exits.
