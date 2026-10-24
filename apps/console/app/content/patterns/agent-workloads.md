---
title: Agents as isolated workloads
category: AI & MCP
summary: Each agent gets its own namespace, identity, network boundary, model and tool allow-list, and token budget — declared in one claim.
tools: [Crossplane v2, agentgateway, Cilium, Software Templates]
order: 30
---

## Why
An agent is a program whose behaviour depends on what it reads. Treat it like an untrusted tenant: give it the least privilege it needs, a boundary it can't talk its way out of, and a budget. Prompt instructions are not a security control; the platform is.

## How Adhar does it
An `AgentWorkload` claim (`platform.adhar.io/v1alpha1`) composes:
- a namespace `<name>-<env>` with ResourceQuota and LimitRange;
- a ServiceAccount `agent` whose **projected** token (audience `agentgateway`) is its identity — automount is off;
- a default-deny NetworkPolicy, with egress only to DNS, the AI gateway and the telemetry collector;
- one agentgateway Allow rule for its models and MCP targets — the gateway denies everything else;
- PrometheusRules `AgentTokenBudgetExceeded`, `AgentRateLimited` and `AgentDenied`.

The **AI Agent Service** template (`agent-service`) scaffolds a Python agent with this claim, a canary Rollout and Kargo promotion. List agents in [Platform → Agent workloads](/platform?section=agent-workloads).

## Use it
```yaml
apiVersion: platform.adhar.io/v1alpha1
kind: AgentWorkload
metadata: { name: triage-bot }
spec:
  parameters:
    name: triage-bot
    environment: dev
    owner: sre
    models: { allow: ["claude-.*", "local/.*"] }
    tools:  { allow: [cluster, observability] }
    budget: { tokensPerHour: 100000 }
```

## Watch out
- Widening `tools.allow` is a privilege change — review it like an RBAC change.
- The agent never sees a provider key; don't add one "to test quickly".
- The budget raises an alert; the hard cap is the gateway's rate limit.
