---
title: Teams and cognitive load
category: Platform engineering
summary: Organise around stream-aligned teams that own a product end to end, and let the platform carry everything else.
tools: [Keycloak, Gitea, Crossplane v2, Service Catalog]
order: 20
---

## Why
A team that must master Helm, IAM, Terraform, dashboards and on-call tooling before shipping a feature has less room for the product. *Team Topologies* calls this cognitive load. Stream-aligned teams own a product end to end; a platform team removes the undifferentiated work; enabling teams coach and then step back.

## How Adhar does it
- **Teams are real objects.** A `Team` creates a Gitea team and refers to the Keycloak group `ws-team-<organisation>.<team>` (for example `ws-team-adhar.payments`); Projects and Applications belong to a team. Manage members in [Settings → Teams](/settings?section=teams).
- **Ownership flows everywhere.** `spec.owner` in a catalog entity routes scorecards, alerts and cost to the owning team.
- **The platform team owns the hard parts.** XRDs and Compositions hide providers behind a short spec — see [Platform API with guardrails](/help?pattern=platform-api-self-service).

## Use it
1. Create one Team per stream-aligned team — not per discipline (no "the DBA team" for app databases).
2. Set `owner` in every `catalog-info.yaml`; filter the [Catalog](/catalog) for entities without one.
3. Agree how each team uses the platform: *X-as-a-Service* for stable capabilities, a short *collaboration* for new ones.

## Watch out
- A platform team that works from tickets becomes the bottleneck it was meant to remove.
- Don't split teams by tool; a "Kafka team" between a service and its topic adds hand-offs.
- Load moves, it doesn't vanish — budget platform-team time for support and docs.
