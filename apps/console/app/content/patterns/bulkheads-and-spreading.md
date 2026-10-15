---
title: Bulkheads and failure domains
category: Resilience
summary: Isolate resources and spread replicas so one failure can't take everything with it.
tools: [Kubernetes, ResourceQuota, Cilium, Kyverno]
order: 40
---

## Why
Ships have bulkheads so one breach doesn't sink the hull. A noisy tenant that eats all CPU, three replicas on one node, or every pod in one availability zone are the platform equivalents of an open hull.

## How Adhar does it
- **Per-team limits** — [Environments](/platform?section=environments) and [Teams](/platform?section=teams) create namespaces with RBAC, quotas and network policy, so one team's runaway job can't starve another.
- **Spread** — topology spread constraints put replicas on different nodes and zones.
- **Disruption budgets** — PodDisruptionBudgets keep a minimum running through drains and upgrades.
- **Guardrails** — Kyverno policies can require requests, limits and anti-affinity on production workloads.

## Use it
```yaml
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: ScheduleAnyway
    labelSelector: { matchLabels: { app: checkout } }
```

## Watch out
- Separate **connection pools** per dependency in code too — one shared pool is a single failure domain.
- Critical system components deserve their own node pool (taints + tolerations).
- Spreading needs enough nodes in each zone; check before relying on it.
