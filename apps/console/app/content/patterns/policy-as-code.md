---
title: Policy as code
category: Security
summary: Turn the security review into rules the cluster checks on every change, in milliseconds.
tools: [Kyverno, CompliancePolicy claim, Kubescape]
order: 20
---

## Why
Manual reviews are slow, inconsistent and skipped under pressure. Policies expressed as code are versioned, tested, applied to every resource the same way, and give developers an answer at admission time instead of a ticket.

## How Adhar does it
**Kyverno** runs as an admission controller with the platform's baseline policies: no privileged pods, required requests/limits, approved registries, required labels (`adhar.io/tenant`), signed images. The `CompliancePolicy` claim applies a named policy set to a group of namespaces. Violations of existing resources show as PolicyReports under [Deliver → Policy](/deliver?section=policy); Kubescape scores the cluster against frameworks such as NSA-CISA and CIS.

## Use it
Kyverno can **validate** (reject), **mutate** (add defaults — the friendliest policy fixes the resource for you), and **generate** (create a NetworkPolicy and quota for every new namespace).

```yaml
validationFailureAction: Audit   # report first, then Enforce
```

## Watch out
- Roll out in `Audit`, burn down the reports, then `Enforce` — enforcing on day one blocks deploys.
- Every rule needs a message that tells the developer **how to fix it**.
- Keep exceptions explicit (PolicyException resources with an owner and expiry).
