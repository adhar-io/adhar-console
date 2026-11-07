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

## Batch

**Develop → Batch** (`?section=batch`, `modules/develop/src/views/batch.tsx`) is
where Spring Batch jobs are operated: every `BatchJob`
(`batchjobs.platform.adhar.io`) the signed-in user can list, and every run of
them. The design is `docs/design/0025-batch-platform.md` in the platform repository,
section 7.

| Page | What it shows |
| ---- | ------------- |
| Jobs | One row per `BatchJob`, grouped by application then environment: schedule with its time zone, next run, last run (status, duration, when), last success, SLA state, held badge. Filters: status, environment, project, team. |
| Job drawer | Definition from the XR and the run template, parameter schema, recent runs as duration bars against `maxDuration`, firing alerts, Kargo delivery, configuration, and links to the Grafana dashboard, Loki and Tempo. Actions: **Run now**, **Hold**, **Release**. |
| Runs | Jobs and Volcano Jobs labelled `adhar.io/batch-job`: trigger, actor, business date, status, attempts, duration, exit code. |
| Run drawer | Phase and conditions, the termination summary (step counts, exit description), pods with role and index, live logs, Kubernetes events, CPU and memory. Actions: **Stop**, **Resume**, **Restart**. |

Everything is read as the signed-in user through the Kubernetes gateway and kept
live by apiserver watches. **There is no BFF endpoint and no `console.adhar.io`
permission:** each action is one Kubernetes call on a namespaced object, under the
caller's own RBAC, and is hidden when `useAccessReview` says it would be refused.

| Action | Call | Needs |
| ------ | ---- | ----- |
| Run now | Read `ConfigMap <name>-run`, then `POST` the run named `<name>-<hash8>` | `create jobs` (`jobs.batch.volcano.sh` on Volcano), `get configmaps` |
| Stop / Resume | `PATCH spec.suspend`, or a `bus.volcano.sh` Command on Volcano | `patch jobs`, or `create commands.bus.volcano.sh` |
| Restart | `POST <name>-<hash8>-r<n>` with `ADHAR_BATCH_TRIGGER=restart`, `ADHAR_BATCH_RESTART_OF` | as Run now |
| Hold / Release | `PATCH` the annotation `adhar.io/batch-hold` on the `BatchJob` | `patch batchjobs` |

Things worth knowing when reading the page:

- **A run's name is its identity.** It is derived from its identifying parameters
  (run naming v1, shared byte for byte with the CLI and the kit, vectors in
  `modules/develop/src/data/testdata/batch/`). The same parameters mean the same
  run, so the Run now dialog offers the existing run instead of a second one.
- **A run equals its template.** A client may change only the name, the
  `adhar.io/batch-trigger` label and the `ADHAR_BATCH_*` client variables. Kyverno
  refuses anything else, so a restart uses the image deployed *now* and the dialog
  says so when that differs from the failed run's.
- **The four empty pages are different.** The API not being installed, the caller
  not being allowed, there being nothing yet, and the request failing each have
  their own words (`pageStateOf`). None of them is an empty table.
- **Changing a schedule or definition is a pull request** against
  `deploy/envs/<env>`: Argo CD would put back a live edit. Hold is the one live
  change, and it is an annotation Argo CD does not compare. Deleting a job goes
  through its application (`/api/apps/delete`).
- **Next run** prefers `kube_cronjob_next_schedule_time` and falls back to stepping
  the cron here (`perf-cron.ts`), so a cluster without kube-state-metrics still
  answers. A held or suspended job shows no time at all.
- **New jobs come from templates:** Create New has a **Batch jobs** family
  (`/catalog?section=create&family=batch`). A template belongs to it when it is
  labelled `adhar.io/workload: batch`, named `springboot-batch-*` or tagged `batch`.

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
