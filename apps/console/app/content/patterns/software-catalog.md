---
title: Software catalog and ownership
category: Platform engineering
summary: One place that answers "what runs here, who owns it, and what does it depend on" — built from live sources.
tools: [Service Catalog, Backstage descriptors, Gitea, Argo CD, Kubernetes]
order: 30
---

## Why
During an incident, "who owns this?" should take seconds. A spreadsheet of services is stale the day after it is written. A catalog that discovers what actually runs, and lets teams add the context only they know, stays true.

## How Adhar does it
The [Catalog](/catalog) is built from live sources, not a hand-kept list: Deployments and StatefulSets become Components, Services become Resources, Ingresses become APIs, and Gitea repositories become Components. A `catalog-info.yaml` in a repo (Backstage descriptor format) adds owner, system, lifecycle, APIs and dependencies on top. Kinds are Component, API, Resource, System, Domain, Group and User. An entity's drawer shows its deployments, composed resources, scorecard, relations, metrics, tech stack and TechDocs.

Adhar reads the Backstage format; it doesn't run a Backstage backend.

## Use it
```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: checkout
  annotations:
    backstage.io/techdocs-ref: dir:.
spec:
  type: service
  lifecycle: production
  owner: group:payments
  system: shop
  providesApis: [checkout-api]
  dependsOn: [resource:orders-db]
```
Templates scaffold this file for you.

## Watch out
- An entity without an owner belongs to nobody — fix it first.
- Keep the descriptor in the repo, next to the code it describes.
- Name systems after business capabilities, not after teams; teams change more often.
