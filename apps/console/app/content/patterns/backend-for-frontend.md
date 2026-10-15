---
title: Backend for frontend
category: Operations
summary: The browser talks to one backend that owns sessions, tokens and fan-out — never to fifteen tools directly.
tools: [Adhar Console BFF, Keycloak, Kubernetes API]
order: 50
---

## Why
A browser that calls Gitea, Argo CD, Grafana and the Kubernetes API directly needs tokens for all of them, CORS on all of them, and network access to all of them. Every one of those is a security and reliability problem.

## How Adhar does it
The Adhar Console is a **BFF**: the browser only calls `/api/*` on the console's own origin. The server keeps the session (tokens stay server-side), injects the right credential per tool, scopes every call to the active tenant, caches rate-limited APIs, and turns fan-out into one response. Cluster calls go out as the user, so permissions stay the user's own.

## Use it
When you add an integration, add a server route that calls the tool and returns exactly what the page needs — not a raw proxy of the tool's whole API.

## Watch out
- The BFF is in every request path; keep it stateless and horizontally scaled.
- Time out and degrade per backend — one slow tool must not slow every page.
- Never accept a tenant or user identity from the browser; derive it from the session.
