# Registering a new component (for developers)

Adhar Console turns "create a new service" into a **self-service, GitOps** action:
pick a golden-path template, fill a short form, and the console scaffolds a real
Git repository, commits a catalog descriptor, and (optionally) wires GitOps so
the component deploys itself. The component then shows up in the **Catalog**
automatically — no manual YAML, no ticket.

> TL;DR: **Catalog → Create → pick a template → fill the form → Create.** You get
> a Git repo + a running GitOps app + a catalog entry.

---

## What happens when you click "Create"

```
You (form)  →  Console BFF  →  Gitea            →  a new repo from the template
                            →  Gitea contents    →  commit catalog-info.yaml (+ deploy/)
                            →  kube-apiserver     →  an Argo CD Application (GitOps)
                                                     └─ Argo CD syncs deploy/ → your namespace
Catalog (live)  ←────────────────────────────────── discovers the repo + workload
```

Every step is real and runs **as you** (your Keycloak identity), so repo
ownership and cluster RBAC are yours — nothing is faked or simulated.

---

## Step by step

1. **Open the catalog** — sidebar → **Catalog**, then the **Create** tab (or the
   "Create" button in the header).
2. **Pick a template.** Filter by family (service, website, library, api, data,
   infra) or language. Each card shows what it produces and its golden-path
   extras (CI, observability, GitOps).
3. **Fill the form.** Common fields:
   - **Name** — lowercase kebab-case (e.g. `orders-api`). Becomes the repo slug
     **and** the catalog component name, so it must be unique and DNS-safe.
   - **Owner** — the team/group that owns it (a `Group` in the catalog).
   - **System / Domain** — optional grouping for the catalog graph.
   - **Description**, plus any template-specific parameters.
4. **Create.** The wizard shows real progress per step (create repo → commit
   descriptor → create GitOps app). On success you get direct links to the
   **repo**, the **Argo CD app**, and the new **catalog entry**.
5. **Clone and go.** `git clone` the new repo — it already has the starter code,
   CI config, a `catalog-info.yaml`, and (for GitOps templates) a `deploy/`
   folder Argo CD watches.

---

## The `catalog-info.yaml` the scaffolder writes

The console commits a Backstage-compatible descriptor to your repo root. It is
the source of truth for how your component appears in the catalog — edit it in
Git and the catalog updates on the next refresh.

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: orders-api
  description: Orders REST API
  annotations:
    adhar.io/git-repo: https://gitea.adhar.localtest.me:8443/platform/orders-api
    argocd/app-name: orders-api
  tags: [go, api]
spec:
  type: service
  lifecycle: production
  owner: group:team-orders
  system: commerce
```

To add relations later (dependencies, APIs), extend `spec` (`dependsOn`,
`providesApis`, `consumesApis`, `partOf`) — the catalog renders them as a graph.

---

## GitOps: how your component deploys

For GitOps-enabled templates the scaffolder also:

- commits a `deploy/` folder (Kustomize/Helm manifests) to your repo, and
- creates an **Argo CD `Application`** pointing at `deploy/` on `main`.

From then on it's pure GitOps: **push to `main` → Argo CD syncs → your workload
updates.** Watch and control the rollout from **Deliver → Argo CD apps** (sync,
diff, rollback, resource tree) or from the Catalog entry's GitOps panel.

---

## After registration

- **Find it**: Catalog → search your name. The entry shows owner, system, links
  (repo, CI, dashboards), a health **scorecard**, and its relations.
- **Observe it**: once deployed, Discover (logs/metrics/traces) and the Overview
  golden-signals pick it up by workload labels.
- **Change its metadata**: edit `catalog-info.yaml` in the repo — no console edit
  needed.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "Create" fails at **create-repo** | Gitea not reachable or the name is taken | Check the name is unique; confirm `GITEA_URL` + a service token are set (ask an admin) |
| Repo created, no **Argo CD app** | GitOps disabled on the template, or you lack `applications/create` RBAC in the Argo CD namespace | Use a GitOps template; ask an admin for the `oidc:<group>` binding |
| Component not in Catalog | Catalog refresh interval, or missing `catalog-info.yaml` | Wait for refresh; confirm the descriptor is on `main` |
| 401 / redirected to login | Session expired | Re-authenticate; the scaffolder runs as you |

Admins: see **[authoring-templates.md](./authoring-templates.md)** to add or
maintain templates and configure the scaffolder.
