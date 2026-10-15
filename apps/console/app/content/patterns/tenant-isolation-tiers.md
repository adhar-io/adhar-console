---
title: Tenant isolation tiers
category: Tenancy
summary: Pick the cheapest isolation that is strong enough — namespace, virtual cluster or dedicated control plane.
tools: [Namespaces, vCluster, Kamaji, Cilium, Kyverno]
order: 10
---

## Why
Isolation costs money. Giving every team its own cluster wastes most of each one; putting everyone in one namespace means they can't install a CRD or trust each other's neighbours. Tenancy is a dial, and different tenants need different settings.

## How Adhar does it
| Tier | What the tenant gets | Use it for |
| --- | --- | --- |
| **Namespace** | Quota, RBAC, default-deny network policy, Kyverno guardrails | Teams inside one organisation |
| **vCluster** | Own API server, CRDs and admin rights, inside a host namespace | Teams needing operators, previews, workshops |
| **Kamaji** | A dedicated control plane (as pods on the hub) with its own worker nodes | Customers, regulated workloads |
| **Cluster** | A separate cloud cluster from a `Cluster` claim | Hard compliance or data-residency boundaries |

Every namespace carries `adhar.io/tenant`, enforced by Kyverno, and the console scopes every list by it.

## Use it
Start at the namespace tier; move a tenant up a tier when it needs cluster-scoped resources or a hard boundary — the claims are the same, only the target changes.

## Watch out
- Shared nodes share a kernel; a namespace is **not** a security boundary against a hostile tenant.
- Noisy neighbours are a quota problem before they're an isolation problem.
- Decide tier by threat model and blast radius, not by who asks loudest.
