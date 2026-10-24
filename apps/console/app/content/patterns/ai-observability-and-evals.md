---
title: AI observability and evaluation
category: AI & MCP
summary: Trace every model and tool call with tokens, cost and caller — then check answer quality with real feedback, not vibes.
tools: [agentgateway, OpenTelemetry, Tempo, Prometheus, Grafana]
order: 80
---

## Why
An agent that "got worse" is impossible to debug without knowing which model it called, what tools it used, how many tokens it spent and on whose behalf. And a prompt change that fixes one answer can quietly break ten others.

## How Adhar does it
- **Traces.** agentgateway sends OpenTelemetry spans to Tempo with GenAI attributes: `gen_ai.request.model`, `gen_ai.usage.input_tokens` / `output_tokens`, `gen_ai.usage.cost_usd`, plus `mcp.method`, `mcp.tool.name`, `mcp.tool.target` and `enduser.id`. Agents from the `agent-service` template propagate W3C trace context, so their own spans and the gateway's sit in one trace — open them in [Discover → Traces](/discover?section=traces).
- **Metrics.** Gateway request and token metrics are labelled `adhar_agent` and `adhar_environment`; the Grafana **Adhar Agents** dashboard breaks them down per agent.
- **Feedback.** In Adhar AI, people vote on the sources behind an answer; the knowledge store re-ranks on it.
- **Audit.** The Adhar AI runtime returns an audit id and its tool calls with each decision.

Adhar doesn't ship an LLM evaluation framework (no Langfuse or eval runner) — bring your own.

## Use it
1. Find a slow or costly answer by model and agent in Grafana, then open its trace.
2. Keep a small set of real questions with known good answers, and run them before each prompt or model change.
3. Alert on error rate and 429s per agent, not just latency.

## Watch out
- Tracing is configured at 100% sampling; lower it if span volume grows.
- Prompts and responses can contain personal data — decide what you log.
- Model upgrades change behaviour; re-run your evaluation set every time.
