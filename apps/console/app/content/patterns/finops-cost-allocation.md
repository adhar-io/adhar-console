---
title: Cost allocation and FinOps
category: Operations
summary: Show every team what it spends, in the tools they already use, while it can still change.
tools: [OpenCost, CostTracker claim, KEDA, Knative]
order: 40
---

## Why
A shared cluster bill is nobody's bill. When cost is visible per team and per service — next to latency and errors — engineers make cheaper choices on their own: right-sized requests, scale-to-zero for idle services, fewer always-on previews.

## How Adhar does it
**OpenCost** allocates node, storage and network cost to namespaces and labels. The `CostTracker` claim sets up allocation and budgets for a team or namespace ([Platform → Cost Trackers](/platform?section=cost-trackers)), and [Decide → Spend](/decide?section=spend) shows trends per team, project and environment, following the tenancy labels.

## Use it
- Label everything with team and project (Kyverno can require it).
- Review the biggest **idle** cost first: requests far above usage, non-prod running at night.
- Set budgets per project and alert at 80%.

## Watch out
- Requests, not usage, decide what you pay for on a busy cluster — right-size them.
- Shared platform cost needs a fair split rule (by usage or flat), agreed up front.
- Cost is one input; don't trade away reliability for a cheaper line.
