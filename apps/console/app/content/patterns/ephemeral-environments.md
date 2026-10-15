---
title: Ephemeral environments
category: Delivery
summary: Every pull request gets its own short-lived environment — reviewed live, destroyed on merge.
tools: [vCluster, Argo CD, Knative, Coder]
order: 50
---

## Why
A shared staging environment is a queue: one broken branch blocks everyone, and "works on staging" depends on who deployed last. Per-change environments remove the queue and make review concrete.

## How Adhar does it
- **vCluster** gives a pull request a full virtual Kubernetes cluster inside a host namespace — its own API server and CRDs, at the cost of a few pods.
- An Argo CD ApplicationSet (pull-request generator) deploys the branch into it and removes it when the PR closes.
- Knative's scale-to-zero keeps idle previews cheap; **Coder** gives the same repository a cloud IDE when someone needs to debug in place.

## Use it
1. Label the PR (or open it) — the generator creates `pr-<n>` with the branch image.
2. The preview URL is posted back to the PR.
3. Merge or close → environment and data are deleted.

## Watch out
- Seed previews with **synthetic or masked** data — never a copy of production.
- Put a TTL on every preview; abandoned PRs are the main cost.
- Shared dependencies (a real payment provider) need sandbox credentials per preview.
