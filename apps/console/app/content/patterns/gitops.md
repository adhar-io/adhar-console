---
title: GitOps
category: Delivery
summary: Git is the only way to change what runs; a controller makes the cluster match it, continuously.
tools: [Argo CD, Gitea, GitOps claim]
order: 10
---

## Why
`kubectl apply` from a laptop leaves no review, no history and no way back. When the desired state lives in Git, every change is a reviewed commit, every environment is reproducible, and rollback is `git revert`.

## How Adhar does it
Adhar is GitOps all the way down: the platform itself is installed by **Argo CD** from Gitea, and so is every application. Argo CD compares Git with the cluster, shows drift under [Deliver → Argo CD Apps](/deliver?section=apps), and with self-heal on, puts back anything changed by hand. The `GitOps` and `Application` claims wire a repository path to a cluster and namespace.

## Use it
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: { name: checkout-prod, namespace: argocd }
spec:
  project: shop
  source: { repoURL: https://gitea.example.com/shop/deploy, path: envs/prod/checkout, targetRevision: main }
  destination: { server: https://kubernetes.default.svc, namespace: shop-prod }
  syncPolicy: { automated: { prune: true, selfHeal: true } }
```

## Watch out
- Keep **app code and deploy config in separate repos** (or paths), so a config change doesn't rebuild the image.
- Secrets never go in Git in plain text — reference them through External Secrets.
- Turn on `prune` deliberately: it deletes whatever Git no longer mentions.
