---
title: Platform API with guardrails
category: Tenancy
summary: Developers ask for what they need in a short spec; the platform turns it into compliant infrastructure.
tools: [Crossplane v2, Compositions, Platform Catalog, Argo CD]
order: 20
---

## Why
Ticket-driven infrastructure is slow, and raw cloud APIs expose hundreds of settings most teams shouldn't touch. A platform API offers a small, opinionated interface — "a Postgres database, medium, with backups" — and hides the rest behind defaults that are already secure.

## How Adhar does it
**Crossplane v2** defines Adhar's API under `platform.adhar.io` — databases, caches, topics, queues, environments, clusters, backup policies and more. Each kind is an XRD with a short schema; a Composition decides how it's built per provider (CloudNativePG locally, RDS on AWS). Developers create them from the [Platform Catalog](/platform?section=catalog) or commit YAML to Git; status, connection secrets and readiness flow back to the claim.

## Use it
```yaml
apiVersion: platform.adhar.io/v1alpha1
kind: Database
metadata: { name: orders-db, namespace: shop-prod }
spec:
  parameters: { engine: postgresql, engineVersion: "16" }
```
The same spec works on a laptop (`adhar up` on kind) and in the cloud.

## Watch out
- Keep the schema small; every field you expose is a support commitment.
- Version the API (`v1alpha1` → `v1`) and migrate compositions, not claims.
- Defaults are policy — encryption, backups and private networking should be on unless turned off.
