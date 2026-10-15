---
title: Elastic autoscaling
category: Scale
summary: Add replicas when load rises and remove them when it falls — on CPU, on latency, or on the length of a queue.
tools: [Kubernetes HPA, KEDA, Scale claim, Prometheus]
order: 10
---

## Why
A fixed replica count is wrong twice a day: too few at peak (latency climbs, requests time out) and too many at night (you pay for idle pods). Capacity should follow demand automatically.

## How Adhar does it
- **CPU / memory** — the `Scale` claim (`platform.adhar.io/v1alpha1`) wraps a HorizontalPodAutoscaler around any Deployment or StatefulSet, with min/max bounds and scale-up/down behaviour.
- **Events** — KEDA scales on what actually drives work: Kafka consumer lag, RabbitMQ queue depth, a Prometheus query, a cron window.
- **Nodes** — the cluster autoscaler of the cloud provider adds nodes when pods stay Pending.

## Use it
```yaml
apiVersion: platform.adhar.io/v1alpha1
kind: Scale
metadata: { name: checkout, namespace: shop-prod }
spec:
  name: checkout
  targetRef: { apiVersion: apps/v1, kind: Deployment, name: checkout }
  minReplicas: 3
  maxReplicas: 30
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 65 } }
```
Or create it from [Platform → Scaling](/platform?section=scaling).

## Watch out
- Set CPU **requests** — utilisation is measured against them; no request, no scaling.
- Scale *in* slowly (a stabilisation window of minutes) to avoid flapping.
- Autoscaling a service that holds a database connection each multiplies connections — put a pooler in front.
