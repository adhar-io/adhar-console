---
title: One MCP gateway, per-tool authorization
category: AI & MCP
summary: Route every model and tool call through one gateway that knows who is calling and decides, per tool, whether they may.
tools: [agentgateway, Keycloak, Model Context Protocol, Cilium Gateway API]
order: 20
---

## Why
If every agent connects straight to every MCP server, each server must do its own authentication, authorization, rate limiting and logging — and one of them will get it wrong. A gateway gives one place to enforce identity and policy for all of them, and one place to see what happened.

## How Adhar does it
**agentgateway** (ADR-0025, in `adhar-system`, on in the production profile) fronts both LLM routes and the federated MCP servers:
- **Identity.** JWT validation is `Strict`: Keycloak tokens from the `adhar` realm, or Kubernetes ServiceAccount tokens with audience `agentgateway`. No token, no call.
- **Gateway rules.** Members of `platform-developer` or `platform-admin` may use the gateway; write routes are admin-only.
- **Per-tool rules.** Developers may call every MCP target *except* the PR-writing ones (`gitops`, `provision`, `security`, `catalog`); `platform-admin` gets all of them.
- **Agents are default-deny.** A ServiceAccount can call only the models and tool domains its `AgentWorkload` allows — see [Agents as isolated workloads](/help?pattern=agent-workloads).

## Use it
1. Put users in the right Keycloak group; that is the whole grant for people.
2. For an agent, list its tool domains in the `AgentWorkload`; anything else is a 403 from the gateway.
3. Watch `AgentDenied` alerts — they show an agent trying something it wasn't granted.

## Watch out
- Authorization is by MCP *target* (domain), not by individual tool; split a domain if you need finer control.
- `failureMode: FailOpen` on the federation means one down server hides its tools rather than failing the call — check `/tools` when a tool "disappears".
- Never forward a user's token to an upstream MCP server you don't run.
