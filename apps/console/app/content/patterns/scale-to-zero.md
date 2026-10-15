---
title: Scale to zero
category: Scale
summary: Run nothing when nothing is happening, and wake up on the first request or event.
tools: [Knative Serving, KEDA, Coder]
order: 20
---

## Why
Preview environments, internal tools, batch consumers and dev workspaces sit idle most of the day. Keeping one replica of each warm is the single largest line of waste on a shared platform.

## How Adhar does it
- **HTTP** — Knative Serving routes requests through an activator. With no traffic the revision drops to zero pods; the first request is held while a pod starts.
- **Events** — KEDA sets `minReplicaCount: 0` on a consumer and brings it back when the Kafka lag or queue depth is above zero.
- **Workspaces** — Coder stops a cloud development environment after an hour without activity; its home volume is kept, so restart is a boot, not a rebuild.

## Use it
```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata: { name: report-api }
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/min-scale: "0"
        autoscaling.knative.dev/scale-to-zero-pod-retention-period: "5m"
    spec:
      containers: [{ image: harbor.example.com/app/report-api:1.4.2 }]
```

## Watch out
- The first request pays a **cold start** (image pull + boot). Keep images small and pre-pulled; use `min-scale: 1` for user-facing paths with tight SLOs.
- Anything that must run on a timer needs a scheduler (CronJob, KEDA cron trigger), not a request.
- Don't scale stateful services to zero — scale their consumers.
