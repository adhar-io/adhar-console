---
title: Measure delivery with DORA
category: Platform engineering
summary: Four numbers — deploy frequency, lead time, change failure rate, time to restore — computed from the tools you already run.
tools: [Argo CD, Gitea, Prometheus, Kargo]
order: 50
---

## Why
A platform claims to make delivery faster and safer; DORA's four key metrics check that claim. Throughput (frequency, lead time) and stability (failure rate, restore time) move together in high-performing teams — tracking only one invites trading the other away.

## How Adhar does it
[Decide → DORA](/decide?section=dora) computes the metrics from systems already in the delivery path, with no extra agent:

| Metric | How it is measured |
| --- | --- |
| Deployment frequency | Successful production deploys per day (Argo CD). |
| Lead time for changes | Commit authored in Gitea → that commit running in production (Argo CD sync history). |
| Change failure rate | Failed or rolled-back production deploys ÷ production deploys. |
| Time to restore | Failed deploy → next good deploy, and critical alert firing → resolved (Prometheus `ALERTS`). |

Results are banded elite / high / medium / low, as in the DORA 2023 report. Adhar doesn't ship SPACE or developer-experience surveys.

## Use it
1. Deploy production through Argo CD from Gitea — a manual `kubectl apply` is invisible to the metrics.
2. Review the trend per team each month, alongside [Scorecards](/scorecards).
3. Pick one constraint at a time (review wait, flaky tests, manual approvals) and watch lead time move.

## Watch out
- Compare a team with its own past, never team against team.
- DORA measures systems, not people — don't use it for performance reviews.
- A target turns into a game: splitting one change into ten deploys raises frequency and nothing else.
