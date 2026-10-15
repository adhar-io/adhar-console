---
title: Secrets management and rotation
category: Security
summary: Secrets live in a vault, reach pods just-in-time, and rotate on a schedule — never in Git, never in images.
tools: [Vault / OpenBao, External Secrets Operator, SecretRotation claim, Sealed Secrets]
order: 30
---

## Why
A password in a Git repo, a CI variable or a container image is a password every past and future reader has. Long-lived credentials turn one leak into permanent access.

## How Adhar does it
- **Vault (or OpenBao)** is the source of truth.
- **External Secrets Operator** syncs a Vault path into a Kubernetes Secret in the service's namespace and keeps it in sync — create it from [Platform → Secrets](/platform?section=secret-stores).
- The `SecretRotation` claim rotates a credential on a schedule and writes it back to the connection secret.
- Platform claims such as databases and caches write their credentials straight to a Secret in your namespace — no human needs to see them.

## Use it
```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata: { name: payments-api-key, namespace: shop-prod }
spec:
  refreshInterval: 1h
  secretStoreRef: { kind: ClusterSecretStore, name: vault }
  target: { name: payments-api-key }
  data: [{ secretKey: token, remoteRef: { key: shop/payments, property: token } }]
```

## Watch out
- Apps must **re-read** rotated secrets (mounted files update; env vars don't) — or restart on change.
- Restrict who can read Secrets in a namespace; RBAC on `secrets` is the real boundary.
- Sealed Secrets are for the bootstrap problem only; prefer External Secrets for apps.
