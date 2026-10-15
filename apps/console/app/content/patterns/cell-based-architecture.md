---
title: Cells and unbounded scale-out
category: Scale
summary: Grow by adding identical, independent copies of the stack — clusters, not bigger clusters.
tools: [Open Cluster Management, Sveltos, Kamaji, vCluster, Cluster claim]
order: 30
---

## Why
Every cluster has a ceiling: etcd size, API-server load, node count, blast radius. "Infinite" scale does not come from one huge cluster; it comes from many identical **cells**, each serving a slice of tenants or regions, so a failure or a bad rollout touches one cell at a time.

## How Adhar does it
- **Management cluster first** — one hub runs Crossplane, Argo CD and the console; environment clusters are spokes.
- **Provision** — the `Cluster` claim creates EKS, GKE, AKS, DOKS, Civo or kind clusters (or a vCluster) from the same spec, with node pools and add-ons.
- **Fleet** — Open Cluster Management places workloads on clusters by label; Sveltos rolls the same add-on set onto every matching cluster.
- **Dense control planes** — Kamaji runs tenant control planes as pods on the hub, so a new cell costs minutes, not a new etcd fleet.

## Use it
1. Define one cell as a `Cluster` claim plus its add-on profile.
2. Label it (`region=eu`, `cell=eu-2`).
3. Route tenants to cells (DNS or a global load balancer) and let placement rules deploy the same apps there.

## Watch out
- Cells must be **identical** — drift is what makes them unmanageable. Keep every difference in Git.
- Cross-cell calls defeat isolation; a cell should serve a request end to end.
- Plan a *cell router* and a way to move a tenant between cells before you need it.
