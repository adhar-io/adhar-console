---
title: Organisation → Team → Project
category: Tenancy
summary: One hierarchy for people, money and resources, so ownership is never a guess.
tools: [Organisation, Team, Project claims, Keycloak, OpenCost]
order: 30
---

## Why
"Who owns this namespace?" and "who pays for this database?" are hard questions on most platforms. When every resource hangs off one hierarchy, ownership, access and cost roll up automatically.

## How Adhar does it
**Organisation** (the tenant) → **Teams** → **Projects** → applications and their environments. Each level is a claim ([Platform → Teams](/platform?section=teams), [Projects](/platform?section=projects)): a team brings members, namespaces and quotas; a project brings repositories, environments and a budget. Keycloak groups mirror teams, so access follows membership, and OpenCost allocates spend along the same labels.

## Use it
- Create teams around ownership (who is paged), not org charts.
- Give each project its environments (`dev`, `staging`, `prod`) and its budget.
- Switch the active team in the console to see exactly that team's world.

## Watch out
- Every resource needs owner labels; Kyverno can require them.
- Moving a project between teams should be a label change, not a migration — keep names independent of the team.
- Shared services (the Kafka cluster) need an owning platform team too.
