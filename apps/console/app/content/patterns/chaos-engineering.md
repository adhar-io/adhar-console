---
title: Chaos engineering
category: Resilience
summary: Break things on purpose, in a controlled way, to prove the resilience patterns actually work.
tools: [LitmusChaos, k6, Prometheus]
order: 60
---

## Why
Retries, failover and autoscaling are untested code paths until something fails. Chaos experiments make that failure happen at a time you choose, with an observer watching, instead of at 3 a.m.

## How Adhar does it
[Deliver → Chaos Engineering](/deliver?section=chaos) runs **LitmusChaos** experiments — kill pods, add network latency or loss, stress CPU or memory, fail DNS, drain a node — scoped to a namespace and label selector, with a probe that judges the hypothesis and a duration that ends the fault automatically. Combine it with a [k6 load test](/deliver?section=performance) so the system is under realistic traffic while it breaks.

## Use it
1. Write the hypothesis: "If one checkout pod dies, p95 stays under 500 ms and no orders fail."
2. Start steady load with k6.
3. Run a `pod-delete` experiment on one replica.
4. Compare the SLO dashboard before, during and after. Fix what disagreed with the hypothesis.

## Watch out
- Start in staging, small blast radius, short duration. Graduate to production only with a kill switch and an audience.
- An experiment without a hypothesis and a metric is just an outage.
- Chaos operations are restricted to platform operators for a reason.
