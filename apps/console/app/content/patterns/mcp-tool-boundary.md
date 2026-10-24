---
title: MCP servers as the tool boundary
category: AI & MCP
summary: Give agents a small set of typed, domain-scoped tools over the Model Context Protocol — never raw cluster or cloud credentials.
tools: [Model Context Protocol, agentgateway, Adhar AI, Gitea]
order: 10
---

## Why
An agent with a kubeconfig can do anything its user can, at machine speed, steered by text it read a minute ago. The **Model Context Protocol** (MCP) puts a boundary in between: the model sees named tools with typed arguments, and the server behind each tool decides what actually happens. The tool list *is* the agent's power.

## How Adhar does it
The `adhar-ai` package runs eight first-party MCP servers, one per domain, federated by agentgateway at `https://mcp.<host>/mcp`:

| Read-only | Write by pull request |
| --- | --- |
| `cluster`, `observability`, `cost`, `delivery` | `gitops`, `provision`, `security`, `catalog` |

Tools are prefixed by domain (`cluster_list_pods`, `gitops_…`). The "write" servers never change the cluster: they open a Gitea pull request as `adhar-ai-bot`, and Argo CD applies it after a human merges. Adhar doesn't ship third-party MCP servers (Kubernetes, Grafana, Argo) in front of the gateway.

## Use it
1. In [Adhar AI](/ai) (or ⌘K), type `/tools` to see what the runtime can actually call.
2. In your own agent, call tools through the gateway's `/mcp` endpoint with the agent's token — the `agent-service` template wires this up.
3. Grant domains, not individual tools, and start with read-only ones.

## Watch out
- Design tools around tasks ("restart a rollout"), not around APIs ("PATCH any object").
- Return small, structured results; a tool that dumps 5 MB of YAML blows the context and the budget.
- Make write tools idempotent — agents retry.
