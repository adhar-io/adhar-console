---
title: AI cost and quota controls
category: AI & MCP
summary: Rate-limit and budget tokens per caller at the gateway, attribute spend to the agent and team, and alert before the bill does.
tools: [agentgateway, Prometheus, Alertmanager, Crossplane v2]
order: 90
---

## Why
A looping agent can burn a month's budget in an afternoon, and a shared API key hides who spent it. Token spend needs the same controls as compute: limits per caller, attribution per team, and alerts on the trend.

## How Adhar does it
- **Gateway limits** (`agentgateway-budget`), per caller:

| Caller | Requests | Tokens |
| --- | --- | --- |
| `platform-admin`, `*-prod` agents | 120/min | 250k/hour |
| other ServiceAccounts | 60/min | 50k/hour |
| everyone else | 60/min | 100k/hour |

- **Per-agent budgets.** An `AgentWorkload` declares `tokensPerHour`; its PrometheusRules fire `AgentTokenBudgetExceeded` and `AgentRateLimited`.
- **Attribution.** Spans carry `gen_ai.usage.cost_usd` and metrics carry `adhar_agent`, so spend lands on an agent, and through its owner on a team.
- **Loop limits.** The runtime caps steps and tool calls per operation.
- **A free tier.** `local/*` models run on in-cluster llm-d when it is installed — no per-token bill, but GPU or CPU you pay for.

## Use it
1. Give each agent its own `AgentWorkload` and a budget based on a week of real usage.
2. Route cheap, frequent tasks to a smaller or local model by name.
3. Review spend per agent with [Decide → Spend](/decide?section=spend) for the cluster cost alongside.

## Watch out
- Gateway limits are counted **per proxy replica** — two replicas double the effective limit.
- The per-agent budget alerts; it doesn't block. The hard stop is the rate limit.
- Long contexts are the hidden cost: trim tool output before it reaches the model.
