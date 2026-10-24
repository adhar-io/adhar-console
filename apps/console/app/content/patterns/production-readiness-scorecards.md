---
title: Production-readiness scorecards
category: Platform engineering
summary: Grade every service against the platform's standards from live signals, and turn each gap into a pull request.
tools: [Scorecards, Argo CD, Kyverno, Trivy, Velero, k6]
order: 40
---

## Why
"Production ready" means different things to different people until it is written down and measured. A scorecard makes the standard explicit, shows each team where it stands, and replaces a launch checklist meeting with a page anyone can read.

## How Adhar does it
[Scorecards](/scorecards) grade each catalog entity A–F.

- **Platform scorer** (`adhar-scorecards` package, on in the production profile): the CronJob `adhar-scorecard-scorer` runs every 30 minutes and reads live state — Argo CD health and sync, probes, resource requests, pinned images from the trusted registry, critical vulnerabilities (Trivy), Kyverno pass rate, backups, `preStop` hooks, PDBs, replicas and spread, autoscaling, progressive delivery, CPU and memory right-sizing, k6 load tests, chaos experiments and SLOs. Category weights live in the ConfigMap `adhar-scorecard-config`.
- **Fallback:** without the scorer, the console grades 14 metadata checks — owner, docs, repo, CI, alerts, runbook, dashboard and similar.
- A failing check offers a fix that lands as a pull request. Only the owning team or a platform admin can apply it.

## Use it
1. Open [Scorecards](/scorecards) and sort by grade.
2. Open a service, read the failing signals, apply the suggested fix and merge the PR.
3. Agree a minimum grade for production (for example B) and review it with each team.

## Watch out
- A score starts a conversation; it isn't a release gate unless you decide it is.
- Checks can be satisfied without the intent — a probe that always returns 200 passes but protects nothing.
- Tune the weights to your priorities, and say why in Git.
