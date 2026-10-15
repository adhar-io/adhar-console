---
title: Golden paths
category: Delivery
summary: Make the right way the fastest way — a new service starts production-ready from a template.
tools: [Software Templates, Gitea, Tekton, Argo CD, Service Catalog]
order: 30
---

## Why
Every team that starts from a blank repo reinvents CI, Dockerfiles, probes, dashboards and alerts — each slightly differently, each with its own gaps. A golden path encodes the platform's standards once, so following them takes less effort than ignoring them.

## How Adhar does it
[Catalog → Templates](/catalog) scaffolds a service in one step: a Gitea repository with code and a Dockerfile, a Tekton pipeline, Harbor project, Argo CD application per environment, probes, ServiceMonitor and catalog entry. The service appears in the Service Catalog with owner, docs and deployments, already scored on production readiness.

## Use it
1. Pick a template (API, worker, frontend, data pipeline).
2. Fill name, owner team and environments.
3. Push code — the pipeline builds, scans and deploys to `dev` on the first commit.

## Watch out
- Golden paths are **paved, not walled**: teams may leave them, but then own what they replace.
- Treat templates as products — version them, and give existing services a way to adopt updates.
- Measure adoption with [Scorecards](/scorecards) rather than mandating it.
