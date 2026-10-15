---
title: Single identity, least privilege
category: Security
summary: One login for every tool, and permissions that follow the person's team — not shared admin accounts.
tools: [Keycloak, Kubernetes RBAC, Gitea, Argo CD, Coder]
order: 40
---

## Why
Every tool with its own user list is another place to forget to remove a leaver. Shared admin accounts make audit logs meaningless. Least privilege is only practical when it's automatic.

## How Adhar does it
**Keycloak** is the identity provider for the console and the tools behind it (Gitea, Argo CD, Grafana, Harbor, Coder) via OIDC. Group membership maps to roles: Kubernetes RBAC bindings per team namespace, Argo CD projects, Gitea organisations. The console calls cluster APIs **as the user** (OIDC, or service-account impersonation of the user's groups on clusters without OIDC), so the API server enforces their real permissions and its audit log names them.

## Use it
1. Model teams as Keycloak groups (or sync them from your corporate IdP).
2. Grant roles to groups, never to individuals.
3. Review access in [Settings → Members & roles](/settings?section=organization) and the audit log.

## Watch out
- Break-glass admin access should exist, be alarmed, and be used rarely.
- Short token lifetimes plus refresh beat long-lived tokens.
- Machine identities (CI, bots) get their own service accounts with narrow scopes.
