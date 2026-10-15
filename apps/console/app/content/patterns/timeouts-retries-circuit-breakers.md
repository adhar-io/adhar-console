---
title: Timeouts, retries and circuit breakers
category: Resilience
summary: Stop one slow dependency from tying up every thread that calls it.
tools: [Dapr, Cilium]
order: 30
---

## Why
In a distributed system the failure you get most is not "down" but "slow". Without limits, callers wait, pile up, exhaust their pools and fail too — a cascade from one sick service.

## How Adhar does it
**Dapr** (installed as a platform component) applies resiliency policies to service invocation, pub/sub and state calls declaratively, without code changes. Cilium provides the network layer: identity-aware policies and L7 visibility through Hubble, so you can see which call is slow.

## Use it
```yaml
apiVersion: dapr.io/v1alpha1
kind: Resiliency
metadata: { name: checkout }
spec:
  policies:
    timeouts: { fast: 2s }
    retries: { idempotent: { policy: exponential, maxInterval: 5s, maxRetries: 3 } }
    circuitBreakers:
      payments: { maxRequests: 1, timeout: 30s, trip: consecutiveFailures >= 5 }
  targets:
    apps:
      payments: { timeout: fast, retry: idempotent, circuitBreaker: payments }
```

## Watch out
- **Every** network call gets a timeout, shorter than the caller's own deadline.
- Retry only **idempotent** operations, with backoff and jitter — or retries become the outage.
- An open circuit needs a fallback: a cached value, a default, a clear error. Failing fast is the point.
