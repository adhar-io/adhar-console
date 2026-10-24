---
title: Human-in-the-loop autonomy
category: AI & MCP
summary: Let agents investigate freely, but make every change a proposal a person approves — and raise autonomy only with evidence.
tools: [Adhar AI, Gitea, Argo CD, Kyverno]
order: 40
---

## Why
Models are confidently wrong some of the time. Reading is cheap to get wrong; changing production isn't. Separate the two: let the agent gather evidence and draft the fix, and keep a human — with a diff in front of them — on the decision to apply it.

## How Adhar does it
- **An autonomy ladder** in the Adhar AI runtime (ADR-0024). Authority only narrows: the config sets a ceiling and a request can ask for less.

| Level | What the agent may do |
| --- | --- |
| `read-only` | No write tools at all. |
| `suggest` (default) | May open **one** pull request; that ends the run. |
| `approve-to-apply` | Keeps going after a PR to verify it; a human still merges every one. |
| `scoped` | Runs unattended, limited to `writePolicy.scoped` — empty by default, so no writes until an operator lists them. |

- **Writes are pull requests** from `adhar-ai-bot`, only to the `packages` and `environments` repos. Nothing reaches a cluster until someone merges and Argo CD syncs.
- **Console agents read with your RBAC.** The built-in agents (SRE, Delivery, Security…) have read-only Kubernetes, Git and graph tools. Their `propose_change` tool only *shows* a manifest; it is applied when you press **Apply**, as you, through the audited server-side apply.

## Use it
1. Open [Adhar AI](/ai). `/readonly`, `/suggest` and `/propose` set the autonomy for the conversation.
2. Review agent PRs in [Develop → Pull requests](/develop?section=prs) like any other change.
3. Read every proposed manifest before **Apply** — it's your identity doing it.

## Watch out
- Approval fatigue is real: if people click Apply without reading, you have no human in the loop.
- `scoped` autonomy is for narrow, reversible actions you have evidence for.
- Kyverno's `adhar-ai-guardrails` run in Audit mode — they report, they don't block.
