---
title: Hub-and-spoke management
category: Operations
summary: One management cluster provisions, configures and observes every environment cluster.
tools: [Crossplane, Argo CD, Open Cluster Management, Sveltos, Adhar Console]
order: 30
---

## Why
Managing ten clusters by hand is ten slightly different clusters. Centralising the control plane makes the fleet consistent, gives one place to look, and keeps workload clusters lean.

## How Adhar does it
Adhar is **management-cluster first**. The hub runs Crossplane (provisioning), Argo CD (desired state), Open Cluster Management and Sveltos (fleet placement and add-ons), Keycloak, and the console. Spokes run workloads plus agents. A new environment is a `Cluster` claim on the hub; everything it needs follows from Git. The console's cluster picker switches every Platform page between spokes.

## Use it
1. `adhar up -f config.yaml` creates the hub.
2. Declare environment clusters as claims; label them by environment and region.
3. Let placement put the right apps and policies on each.

## Watch out
- The hub is critical infrastructure: run it HA and back it up first.
- Spokes must keep **serving** when the hub is down — the hub manages, it is not in the request path.
- Limit what has credentials to every cluster; the hub is the highest-value target.
