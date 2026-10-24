---
title: Environments as a service
category: Platform engineering
summary: A project gets dev, test and prod — namespaces, quotas, access and a promotion chain — from one claim.
tools: [Crossplane v2, Kargo, Argo CD, Kyverno]
order: 80
---

## Why
When creating an environment means a ticket, a week and a slightly different setup each time, teams share one staging until it breaks. Environments should be cheap, identical in shape, and created the same way every time.

## How Adhar does it
Environments belong to the **Project**, and every app in the project shares them. A `Project` claim composes one `Environment` per tier (`dev`, `test`, `prod` by default), an Argo CD AppProject, and a Kargo project with shared stages `dev → test → prod`; dev and test auto-promote, prod never does. Each `Environment` brings a namespace, a ResourceQuota and LimitRange from `cpuQuota`, `memoryQuota` and `podQuota`, an optional network policy, and access — `admin` in dev and test, `view` in prod.

Short-lived pull-request previews are a separate, optional package — see [Ephemeral environments](/help?pattern=ephemeral-environments).

## Use it
1. Create the project from [Platform → Projects](/platform?section=projects) or commit the claim to Git.
2. Check its tiers under [Platform → Environments](/platform?section=environments).
3. Watch apps move through them in [Deliver → Environments](/deliver?section=environments).

## Watch out
- Keep environments identical in shape; differences belong in small overlays (replicas, hostnames).
- Size quotas from real usage — a quota hit in prod is an outage.
- Prod is `view` for a reason: change it through promotion, not `kubectl edit`.
