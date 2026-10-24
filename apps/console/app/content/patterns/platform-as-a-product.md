---
title: Platform as a product
category: Platform engineering
summary: Treat developers as customers — start with the thinnest platform that removes real toil, and grow it from evidence.
tools: [Adhar Console, Marketplace, Plane, Scorecards]
order: 10
---

## Why
A platform built from a wish list becomes a second job for the teams it was meant to help. Platforms succeed when they solve problems developers actually have, are easier than the alternative, and are adopted by choice. That takes product habits: known users, a public roadmap and a measure of success.

## How Adhar does it
- **Thin by default.** A core — Argo CD, Crossplane, Gitea, Keycloak and the console — plus packages you switch on from [Marketplace](/platform?section=marketplace). Each package is one entry in the platform's ApplicationSet, so adding or removing a capability is a reviewed change, not a project.
- **Roadmap in the open.** [Define → Roadmap](/define?section=roadmap) (backed by Plane) holds the platform team's epics next to everyone else's work.
- **Evidence.** [Scorecards](/scorecards) show which standards teams meet; [DORA](/decide?section=dora) shows whether delivery is getting faster and safer.
- Adhar doesn't ship developer surveys or usage analytics for the console itself — collect that feedback outside the platform.

## Use it
1. List the three tasks that cost teams the most time today (a new service, a new database, a production deploy).
2. Make each one self-service — a [template](/catalog?section=create) or a platform claim — before adding anything new.
3. Review Scorecards and DORA monthly with the teams that use the platform.

## Watch out
- Every package you enable is one you patch, upgrade and support.
- A path that needs a mandate has a product problem; fix the path.
- Measure outcomes (time to first deploy, lead time), not the number of features.
