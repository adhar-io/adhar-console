---
title: Self-hosted model serving
category: AI & MCP
summary: Run open-weight models in the cluster for data that must not leave it, or for cheap high-volume tasks — behind the same gateway.
tools: [llm-d, vLLM, agentgateway, NVIDIA GPU Operator]
order: 100
---

## Why
Some prompts can't go to a hosted provider, and some tasks are too frequent to pay per token for. Serving an open-weight model in-cluster keeps data at home and makes cost a capacity question — at the price of running GPUs and inference software yourself.

## How Adhar does it
Optional packages, **off by default** in every profile:
- **llm-d** — vLLM workers behind an endpoint-picker router. `llm-d-cpu` serves Qwen2.5-0.5B-Instruct for laptops and tests; `llm-d-gpu` serves Qwen3.6-27B-FP8 on one GPU (scheduled onto `nvidia.com/gpu.present=true` nodes). Both answer as `local/default`.
- **vllm** (`vllm-cpu` / `vllm-gpu`) — a standalone vLLM server with Keycloak SSO in front, as its own endpoint.

agentgateway sends any `local/*` model name to the llm-d router, so apps switch between hosted and local models by name. Adhar doesn't ship KServe or Ollama; the `ml` template includes a KServe `InferenceService` example only.

## Use it
1. Enable `llm-d` and `llm-d-cpu` (or `llm-d-gpu` plus the GPU Operator) from [Marketplace](/platform?section=marketplace).
2. Call the gateway with `"model": "local/default"`.
3. Use it as the fallback model — the Adhar AI runtime already does.

## Watch out
- Without llm-d installed, `local/*` calls return 503.
- Small models are fine for classification and summaries, weak at multi-step tool use; evaluate before switching.
- Model weights are large; plan for node disk and cold-start time.
