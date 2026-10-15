---
title: Environment promotion
category: Delivery
summary: Promote the exact artifact that passed in one environment to the next — never rebuild for production.
tools: [Kargo, Argo CD, Harbor]
order: 20
---

## Why
"It worked in staging" only means something if production runs **the same image digest and the same config** that staging ran. Rebuilding per environment, or hand-editing tags, breaks that guarantee.

## How Adhar does it
**Kargo** tracks *freight* — an image digest plus the Git commit of its manifests — and moves it through stages (`dev → staging → prod`). Each stage can verify the freight (an Argo Rollouts analysis, a k6 gate) before it becomes eligible for the next. Promotion commits the new digest to the environment's path in Git, so Argo CD deploys it. See [Deliver → Stages](/deliver?section=stages).

## Use it
1. CI builds once and pushes `harbor/…/checkout@sha256:…`.
2. Kargo's warehouse discovers the new freight; `dev` promotes automatically.
3. Verification passes → `staging` is eligible; promote with one click (or auto).
4. `prod` promotion requires approval and lands as a reviewed commit.

## Watch out
- Promote **digests**, not tags — tags move.
- Environment differences belong in small overlays (replicas, URLs), not in the image.
- Freight that skips a stage is a policy decision; make it visible, not easy.
