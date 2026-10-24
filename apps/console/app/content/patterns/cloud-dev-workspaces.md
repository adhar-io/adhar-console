---
title: Cloud development workspaces
category: Platform engineering
summary: A ready-to-code environment in minutes, from a template, close to the cluster — and stopped when nobody uses it.
tools: [Coder, Keycloak, Gitea]
order: 90
---

## Why
"Works on my machine" starts with every laptop being different. Setting up toolchains, credentials and access for a new joiner or a new repo can take days. A workspace from a template gives everyone the same tools, on demand, with access already wired.

## How Adhar does it
**Coder** (on in the production profile) runs development workspaces on the platform. [Develop → Cloud Envs](/develop?section=environments) lists them with owner, status and template, creates a new one from a template in one click, and starts, stops or restarts them. Open a workspace in the browser IDE, in VS Code desktop or with JetBrains Gateway, or open a terminal. Developers sign in to Coder with Keycloak, so a "New env" is created under their own account.

These are coding environments. Deploy environments (dev, test, prod) are a different thing — see [Environments as a service](/help?pattern=environments-as-a-service).

## Use it
1. Write one Coder template per stack (Go, Node, JVM) with the toolchain and extensions your team uses.
2. Set an auto-stop time so idle workspaces shut down.
3. Point new joiners at Cloud Envs on day one.

## Watch out
- A template is a product too — version it, and tell people when it changes.
- Workspaces hold source and tokens; treat them like laptops (no shared accounts).
- Running workspaces cost money; stop them by default, start them on demand.
