---
title: Canary and blue-green releases
category: Resilience
summary: Expose a new version to a slice of traffic, measure it, and promote or roll back automatically.
tools: [Argo Rollouts, Prometheus, Cilium Gateway API]
order: 20
---

## Why
Tests can't reproduce production. The safest way to find out whether a release is good is to let a little real traffic decide — and to undo it in seconds if it isn't.

## How Adhar does it
**Argo Rollouts** replaces a Deployment with a `Rollout`. Each step shifts weight to the new version and runs an `AnalysisTemplate` against Prometheus (error rate, p95 latency). A failed analysis aborts and returns all traffic to the stable version — no human in the loop. Watch progress under [Deliver → Rollouts](/deliver?section=rollouts).

## Use it
```yaml
strategy:
  canary:
    steps:
      - setWeight: 10
      - analysis: { templates: [{ templateName: error-rate }] }
      - setWeight: 50
      - pause: { duration: 5m }
      - setWeight: 100
```
Blue-green is the same object with `strategy.blueGreen`: the new version runs at full size behind a preview Service, then the active Service switches in one step.

## Watch out
- Analysis needs **traffic** to be meaningful; at 10 requests a minute a canary proves nothing. Use longer steps or synthetic checks.
- Both versions run at once — they must share a compatible database schema and message format.
- Pick metrics that reflect users (errors, latency), not pod health.
