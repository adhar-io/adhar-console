---
title: Twelve-factor apps
category: Delivery
summary: Build once, configure by environment, keep processes stateless and disposable — so the platform can do the rest.
tools: [Kubernetes, Harbor, Argo CD, External Secrets, Kargo]
order: 60
---

## Why
Autoscaling, rolling deploys, promotion and self-healing all assume the app cooperates: it starts fast, keeps no state on local disk, reads config from the environment and logs to stdout. Break those assumptions and every platform feature becomes a special case.

## How Adhar does it
- **One build, many environments.** Tekton builds the image once and pushes it to Harbor; Kargo promotes the same digest through `dev → test → prod`. See [Environment promotion](/help?pattern=environment-promotion).
- **Config in the environment.** Kustomize overlays per environment set replicas, hostnames and config; credentials come from Secrets that platform claims or External Secrets write into your namespace.
- **Backing services are attached resources.** A `Database`, `Cache` or `Topic` claim writes its connection details to a Secret — swap the implementation without changing code.
- **Logs are streams.** Write to stdout; Alloy ships them to Loki.

## Use it
1. Read every setting from environment variables; fail fast on start if one is missing.
2. Keep sessions and uploads in a cache or bucket, never on the pod's disk.
3. Handle `SIGTERM` and start in seconds, so pods can be replaced at any time.

## Watch out
- Never bake environment names, URLs or secrets into the image.
- One process type per Deployment; run migrations as a Job or a pre-sync hook, not at every pod start.
- "Stateless" includes in-memory caches that the app can't rebuild quickly.
