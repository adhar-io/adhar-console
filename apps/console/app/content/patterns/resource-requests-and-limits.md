---
title: Resource requests and limits
category: Scale
summary: Requests make scheduling honest, limits contain the noisy neighbour, and quotas cap what a team can ask for.
tools: [Kubernetes, LimitRange, ResourceQuota, metrics-server, Scorecards]
order: 70
---

## Why
The scheduler places pods by their **requests**, not by what they use. A pod with no request counts as zero, so nodes the scheduler thinks are half empty can run at 95% real memory — and then the kubelet starts killing things. Limits and quotas stop one workload from starving the rest.

## How Adhar does it
- **Defaults where they're missing.** Every `Environment` composes a ResourceQuota and LimitRange from `cpuQuota`, `memoryQuota` and `podQuota`. In the platform namespace, the LimitRange `adhar-platform-defaults` adds a *request* (20m CPU, 64Mi memory) to containers that declare none — deliberately no default limit.
- **Team ceilings.** The `adhar-tenant-quotas` admission webhook keeps a team's total within its allowance.
- **Right-sizing.** The scorer's `resources`, `cpu_right_sized` and `memory_right_sized` signals compare live usage from metrics-server with requests — see [Scorecards](/scorecards). Quotas are visible in [Platform → Quotas](/platform?section=quotas).

## Use it
```yaml
resources:
  requests: { cpu: 100m, memory: 256Mi }
  limits:   { memory: 256Mi }
```
Set requests from observed p95 usage. Memory limit = request gives the pod predictable memory; leaving out a CPU limit avoids throttling.

## Watch out
- A memory limit below real peak means OOM kills; a CPU limit means throttling, not kills.
- `Guaranteed` QoS (requests = limits for all resources) is evicted last — use it for stateful services.
- JVMs and build pods vary widely; measure before you cap them.
