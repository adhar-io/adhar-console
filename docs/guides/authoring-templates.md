# Authoring & maintaining templates (for admins)

This guide is for platform admins who own the **golden-path templates** behind
Catalog → Create. The goal is that templates are **easy to maintain**: each one
is a small, declarative record that points at a real **Gitea template repo** and
declares how the component is scaffolded and wired into **GitOps**. The console's
scaffolder does the rest at runtime — you don't hand-write orchestration code.

- **Developers'** view of the flow: [component-registration.md](./component-registration.md).

---

## Mental model

A template = **metadata for the picker** + **a pointer to a real Git template
repo** + **a small `scaffold` block** describing what to create.

```
CatalogTemplate (data)          Gitea template repo            Runtime (BFF scaffolder)
──────────────────────          ───────────────────           ────────────────────────
title, family, language,   ──▶  platform/tmpl-go-service  ──▶  generate repo from template
tags, form fields,              (starter code, CI,              commit catalog-info.yaml
scaffold: { sourceRepo,          Dockerfile, deploy/)           create Argo CD Application
          gitops, ... }                                         → component appears in Catalog
```

Keeping the **code** in a Git template repo (not in the console) is what makes
templates low-maintenance: update the starter repo and every future scaffold
picks it up — no console release required.

---

## The template record

Templates live in `apps/console/app/data/catalog-templates.ts` as an array of
`CatalogTemplate`. The maintenance-critical part is the declarative `scaffold`
block:

```ts
{
  id: 'go-service',
  title: 'Go microservice',
  description: 'gRPC/HTTP service with CI, Dockerfile, and GitOps deploy.',
  produces: { kind: 'Component', type: 'service' },
  family: 'service',
  language: 'go',
  tags: ['go', 'grpc', 'gitops'],
  owner: 'group:platform',
  glyph: '🐹',
  tone: 'sky',
  // Wizard form — keep this SHORT; everything else has sane defaults.
  steps: [
    { key: 'basics', title: 'Basics', description: 'Name and owner', fields: [
      { name: 'name', label: 'Name', type: 'text', required: true,
        help: 'kebab-case; becomes the repo slug + catalog name' },
      { name: 'owner', label: 'Owner', type: 'text', required: true },
      { name: 'description', label: 'Description', type: 'text' },
    ]},
  ],
  // ── The declarative scaffold contract (this is what makes it real) ──
  scaffold: {
    sourceRepo: 'platform/tmpl-go-service', // Gitea template repo to generate from
    gitops: true,                            // also create an Argo CD Application
    manifestPath: 'deploy',                  // path Argo CD syncs (default: deploy)
    catalogInfoPath: 'catalog-info.yaml',    // descriptor path (default)
  },
}
```

If `scaffold.sourceRepo` is omitted the scaffolder creates an **empty
auto-initialised repo** (still commits `catalog-info.yaml`). If `scaffold.gitops`
is false, no Argo CD Application is created (good for libraries/docs).

### Adding a new template — the whole process

1. **Create the template repo in Gitea** under the templates org, marked as a
   *template repository* (Gitea: repo settings → "Template"). Put the starter
   code, `Dockerfile`/CI, a `deploy/` folder (Kustomize/Helm), and a
   `catalog-info.yaml` skeleton in it. Use `${{values.name}}`-style placeholders
   if you enable Gitea's template variable expansion.
2. **Add one `CatalogTemplate` record** pointing `scaffold.sourceRepo` at it.
   Keep the form (`steps`) minimal — name/owner/description plus only the
   parameters that truly vary.
3. Ship the console (the record is the only console change) and it appears in
   Catalog → Create.

Maintenance later is usually just editing the **template repo** — no console
change.

---

## How the runtime scaffolder works

The BFF endpoint **`POST /api/scaffold`** (auth-gated, runs as the signed-in
user) executes the `scaffold` block against real backends:

1. **Create repo** — Gitea `POST /repos/{sourceRepo}/generate` (or
   `POST /orgs/{org}/repos` when there's no `sourceRepo`).
2. **Commit descriptor** — writes `catalog-info.yaml` (a Backstage `Component`)
   via the Gitea contents API, filled from the form values.
3. **GitOps** — when `gitops: true`, commits a `deploy/` starter and creates an
   Argo CD `Application` (via the per-user Kubernetes gateway, so it respects the
   user's RBAC) pointing at `manifestPath` on `main`.

It returns per-step results so the wizard can show real progress and link to the
repo, the Argo CD app, and the catalog entry. On any step failure it reports the
error — nothing is faked.

---

## Configuration (env)

Set these on the console deployment (see `.env.example` and the platform
`configmap`/secret):

| Var | Purpose | Example |
| --- | --- | --- |
| `GITEA_URL` | Gitea base URL (already used by the proxy) | `https://gitea.adhar.localtest.me:8443` |
| `GITEA_TOKEN` | Service token used to create repos/commit (scaffolder) | *(secret)* |
| `GITEA_ORG` | Org that owns scaffolded repos + holds template repos | `platform` |
| `ARGOCD_NAMESPACE` | Namespace where Argo CD `Application`s are created | `argocd` |
| `ARGOCD_PROJECT` | Argo CD project for scaffolded apps | `default` |
| `SCAFFOLD_DEST_NAMESPACE` | Default target namespace for GitOps deploys | `default` |

RBAC: because the Argo CD `Application` is created **as the user** through the
gateway, the user's Keycloak group must be bound to `applications` create in the
Argo CD namespace (see the platform `k8s-rbac.yaml` group→role bindings). The
Gitea repo is created with the platform service token.

---

## Maintenance checklist

- **Keep forms short.** Every field is future support burden — prefer defaults in
  the template repo over form inputs.
- **One source of truth for code.** Starter code lives in the Gitea template
  repo, never inline in the console.
- **Version the template repos.** Tag/brancharter them; the scaffolder generates
  from the default branch.
- **Test a template** by scaffolding a throwaway component and deleting the repo
  + Argo CD app afterward.
- **Deprecate cleanly.** Remove the `CatalogTemplate` record to hide it from the
  picker; existing scaffolded components are unaffected (they're independent
  repos + apps).

---

## Extending the descriptor

The committed `catalog-info.yaml` is intentionally minimal. To pre-populate
relations for a family of components (e.g. every `service` `dependsOn` a shared
`Resource`), extend the descriptor builder for that template — the catalog reads
`spec.dependsOn` / `providesApis` / `consumesApis` / `partOf` and renders the
relation graph in the entity drawer.
