# Phase · Develop

Source control, code review, CI.

- **Primary backers:** [Gitea](https://about.gitea.com) (MIT) for Git hosting,
  [Argo Workflows](https://argoproj.github.io/argo-workflows) (Apache-2.0)
  for CI pipelines.
- **Module:** `modules/develop` → exposes `./Home`, `./RepoList`, `./PullRequestList`,
  `./WorkflowList`.
- **Port in dev:** 5103.

## Views

| Tab          | Backing call                                        |
| ------------ | --------------------------------------------------- |
| Repositories | `gitea.listRepos(tenant.giteaOrg)`                  |
| Pull Requests| `gitea.listPullRequests(org, repo, 'open')`         |
| Workflows    | `argoWorkflows.listWorkflows(namespace)`            |

## Scoping

The BFF passes the active tenant's `giteaOrg` into every call; a user never
sees repos outside their tenant. Workflows use the tenant's Argo Workflows
namespace (typically `<tenantPrefix>-argo`).

## Common follow-ups

- Per-repo detail with branches, commits, releases.
- PR detail with inline diff + review workflow — delegated to Gitea deep
  links in v1, inlined later.
- Workflow DAG visualization (the Argo Workflows UI component can be
  embedded as a federated remote once it ships as a library).

## Permissions

- `viewer` sees all repos their Gitea user can.
- `developer` can see PR actions (merge, close) delegated to Gitea via token.
- `tenant-admin` additionally sees org settings link to Gitea's admin.
