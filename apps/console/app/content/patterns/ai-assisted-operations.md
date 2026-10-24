---
title: AI-assisted operations
category: AI & MCP
summary: Let narrow, event-driven agents do the first ten minutes of triage — and hand a person evidence, not a guess.
tools: [Adhar AI, K8sGPT, Alertmanager, Argo CD, Tekton]
order: 85
---

## Why
Most incidents start the same way: someone opens five tabs to collect logs, events, recent deploys and metrics. A narrow agent triggered by the alert can gather that evidence before a human looks, and point at the likely cause. Narrow beats general here — fewer tools, fewer ways to go wrong.

## How Adhar does it
The Adhar AI runtime runs **event-driven operators**, each with its own trigger, autonomy and tool list:

| Operator | Trigger | Autonomy |
| --- | --- | --- |
| `alert-triage` | Alertmanager | suggest |
| `drift-explain` | Argo CD notifications | read-only |
| `cost-advisor` | schedule | suggest |
| `upgrade-preflight` | manual | suggest |
| `build-failure` | Tekton | suggest |

Results appear as findings in [Adhar AI](/ai). **K8sGPT** (on in the production profile) scans the cluster through the same gateway, with `anonymized: true` so resource names are masked before they reach a model.

## Use it
1. Wire Tekton's CloudEvents to `POST /operators/build-failure/event` so a failed build explains itself.
2. Ask in Adhar AI with context — "why is checkout erroring since 14:00?" — rather than "what's wrong?".
3. Feed confirmed root causes back as knowledge notes.

## Watch out
- An operator's `allowedTools` is its blast radius; keep each list short.
- Triage output is a hypothesis; check the evidence it cites before acting.
- `build-failure` usually can't fix the code — a service's own repo isn't in the write policy, by design.
