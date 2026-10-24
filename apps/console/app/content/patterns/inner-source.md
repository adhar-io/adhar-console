---
title: Inner source for the platform
category: Platform engineering
summary: Everything the platform offers lives in Git, so any team can propose a better template, policy or package by pull request.
tools: [Gitea, Software Templates, Argo CD, Adhar Console]
order: 100
---

## Why
A platform team can't foresee every need. If a template or policy is only changeable by that team, every improvement waits in their queue. Inner source opens the platform to contributions from the teams that use it, with the same review and ownership as any other code.

## How Adhar does it
- **Templates** are Backstage `Template` files in the `adhar-templates` repository in Gitea — change one by pull request; there is no in-console template editor.
- **Packages, policies and compositions** are Git too; Argo CD applies them after merge.
- **Reviews in one place.** [Develop → Pull requests](/develop?section=prs) lists open PRs across repos, with diff, review and merge.
- **Machines contribute the same way.** Scorecard fixes arrive as pull requests, and the Adhar AI runtime writes only through PRs.

## Use it
1. Add a `CONTRIBUTING.md` to the templates and platform repos: how to propose, who reviews, how long review takes.
2. Label "good first contribution" issues for teams that want to help.
3. Credit contributors in the platform changelog.

## Watch out
- Contributions need maintainers — agree who owns a template after it merges.
- Review for the fleet, not the one team: a template change lands in every new service.
- Keep a short path from issue to fix; slow reviews stop contributions faster than any policy.
