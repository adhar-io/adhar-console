---
title: Operators and reconciliation
category: Operations
summary: Declare the state you want; controllers keep comparing it with reality and fix the difference, forever.
tools: [Crossplane v2, Argo CD, CloudNativePG, Strimzi, External Secrets]
order: 60
---

## Why
A script runs once and is wrong the next day. A reconciliation loop watches desired state and actual state and closes the gap every time they drift — a deleted pod, a changed setting, a failed node. Operators package that loop with the operational knowledge of a specific system.

## How Adhar does it
Almost everything on the platform is a controller:
- **Argo CD** reconciles Git into the clusters; platform packages sync with `selfHeal`, so a manual edit is reverted.
- **Crossplane v2** reconciles platform claims (`Database`, `Project`, `AgentWorkload`…) into the resources their Compositions describe. Its Operations API adds day-2 jobs: a daily backup `CronOperation`, secret rotation, and a `WatchOperation` that records drift on managed ConfigMaps in `adhar-system`.
- **Engine operators** run stateful systems: CloudNativePG for Postgres, Strimzi for Kafka, External Secrets for credentials, and others behind the claims.

Inspect any claim's composed resources and conditions in [Platform → Adhar Resources](/platform?section=catalog).

## Use it
1. Change state by changing Git or a claim — never by hand on the cluster.
2. Read `status.conditions` (`Ready`, `Synced`) before logs; they say what the controller is waiting for.
3. Keep custom automation idempotent: running it twice must equal running it once.

## Watch out
- Two controllers owning one field fight forever — one owner per field.
- An operator is software you upgrade; pin and test its versions like any dependency.
- A paused or crash-looping controller fails silently; alert on reconcile errors, not only on apps.
