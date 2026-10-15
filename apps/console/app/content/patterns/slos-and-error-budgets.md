---
title: SLOs and error budgets
category: Operations
summary: Agree how reliable a service must be, measure it from the user's side, and spend the remainder on shipping.
tools: [Prometheus, Grafana, Alertmanager, Grafana OnCall, Argo Rollouts]
order: 20
---

## Why
"100% uptime" is impossible and chasing it freezes delivery. An **SLO** (say, 99.9% of checkout requests succeed under 500 ms over 30 days) states the target; the **error budget** (0.1%) is the room left for risk. When budget is plenty, ship faster; when it's burning, slow down and fix.

## How Adhar does it
SLOs are defined on Prometheus metrics and tracked under [Discover → SLOs](/discover?section=slos). Alerts fire on **burn rate** — how fast the budget is being consumed — and route through Alertmanager to Grafana OnCall. The same SLI queries feed Argo Rollouts analysis, so a canary that would burn the budget is rolled back before full rollout. Delivery health is tracked alongside as DORA metrics in [Decide](/decide?section=dora).

## Use it
1. Pick 1–3 SLIs per user journey (availability, latency).
2. Set the target from what users need, not what you measure today.
3. Alert on a fast burn (page) and a slow burn (ticket).

## Watch out
- Measure at the edge (gateway), not inside the pod — users don't see your pod.
- An SLO nobody acts on is a dashboard; agree what happens when the budget is gone.
- Fewer, better SLOs beat one per endpoint.
