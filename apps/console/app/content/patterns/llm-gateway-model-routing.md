---
title: LLM gateway and model routing
category: AI & MCP
summary: Apps name a model; one gateway picks the provider, holds the keys, applies limits — and lets you switch providers without code changes.
tools: [agentgateway, OpenBao, External Secrets, llm-d]
order: 50
---

## Why
When every service holds its own provider key and SDK, keys leak, costs are invisible, and changing provider is a migration. A gateway gives one OpenAI-compatible endpoint, keeps keys server-side and makes the provider a routing decision.

## How Adhar does it
agentgateway reads the `model` field from the request body into an `x-model` header and routes on it:

| Model name | Goes to |
| --- | --- |
| `claude-*`, `anthropic/*` | Anthropic |
| `gpt-*`, `o1-*`…, `openai/*` | OpenAI-compatible backend (configured for OpenRouter) |
| `local/*` | in-cluster llm-d (vLLM), if installed |
| anything else | the OpenAI-compatible backend |

Keys live in OpenBao at `secret/adhar-ai/llm` and reach the gateway through the External Secret `adhar-ai-llm` — apps never see them. In-cluster callers use `http://adhar-ai-gateway.adhar-system.svc.cluster.local:8080/v1`.

There is **no gateway-level failover**. The Adhar AI runtime falls back itself, to `ADHAR_AI_LLM_SECONDARY_MODEL` (`local/default`).

## Use it
1. Seed the provider and key with `hack/seed-adhar-ai-llm.sh` (writes OpenBao; no key in Git).
2. Point any OpenAI SDK at the gateway's `/v1` and send `"model": "claude-…"`.
3. Change provider by changing the model name, not the code.

## Watch out
- A `local/*` model with no llm-d installed returns 503.
- Pin exact model versions in production; aliases change behaviour under you.
- If you need fallback, build it in the client — and test it.
