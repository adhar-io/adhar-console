---
title: Docs and decisions as code
category: Platform engineering
summary: Keep docs and architecture decisions in the repo, reviewed like code, and read them where the service lives.
tools: [TechDocs, Gitea, ADRs, Service Catalog]
order: 60
---

## Why
Docs in a wiki drift away from the code they describe, and nobody reviews them. Docs in the repo change in the same pull request as the behaviour, have an owner, and show up where people look for the service. The same goes for decisions: the *why* behind a design is lost if it only lived in a meeting.

## How Adhar does it
- **TechDocs tab** on every catalog entity. It looks for docs in order: the `backstage.io/techdocs-ref` annotation (`dir:` or `url:`), the `adhar.io/docs` annotation or a docs link, then the repo's `docs/` folder or README. Markdown is rendered straight from Gitea; there is no MkDocs build step.
- **Templates** scaffold `docs/` and `mkdocs.yml`, so a new service starts with a place to write.
- **[Design → ADRs](/design?section=adrs)** keeps architecture decision records (MADR) with status, a supersession chain and backlinks. Import existing MADR or Nygard files, and commit records to `docs/adr` in Gitea with an index.

## Use it
1. Keep `docs/index.md` and a `docs/runbook.md` next to the code.
2. Annotate the component with `backstage.io/techdocs-ref: dir:.`.
3. Record an ADR for any decision that is expensive to reverse — a datastore, a protocol, a tenancy model.

## Watch out
- Review docs in the same PR as the change, or they rot just as fast as a wiki.
- Supersede ADRs; don't delete or rewrite them — the history is the point.
- A runbook link is a scorecard check; an empty runbook passes it and helps no one.
