---
title: Versioned platform contracts
category: Platform engineering
summary: Treat every platform kind as a public API — additive changes, explicit deprecation, and migrations in the platform, not in every repo.
tools: [Crossplane v2, XRDs, Compositions, Argo CD]
order: 70
---

## Why
Once a hundred repos declare a `Database`, its schema is a contract. A renamed field or a removed enum value breaks those repos the next time Argo CD syncs them, usually far from the person who made the change.

## How Adhar does it
Each platform kind is a Crossplane v2 XRD in `platform.adhar.io`. Today every kind serves a single version, `v1alpha1`, with no conversion webhooks, so changes are kept **additive**: new optional fields with defaults. When a field is retired the schema keeps it and the platform reports it instead of failing — `Application.spec.parameters.environments` is deprecated and ignored, and setting it raises the `OverrideIgnored` condition. Behaviour changes ship in Compositions, which every claim picks up without editing.

Service-to-service contracts are API entities in the [Catalog](/catalog) (`openapi`, `asyncapi`, `graphql`, `grpc`), linked by `providesApis` and `consumesApis`.

## Use it
1. Add fields as optional with a safe default; never change what an existing field means.
2. Deprecate in three steps: document it, surface a status condition, remove it in the next version.
3. For a breaking change, serve a new version beside the old one and move claims in the Composition first.

## Watch out
- `v1alpha1` signals instability; teams will still depend on it — act as if it were `v1`.
- Removing an enum value is breaking even when no test notices.
- Every field you add is support you owe; keep schemas small.
