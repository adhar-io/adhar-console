<div align="center">

<img src="./apps/console/public/branding/symbol-color.svg" alt="Adhar" width="88" height="88" />

# Adhar Console

**A transparent, open-core control plane for the full software lifecycle.**

[![CI](https://github.com/adhar-io/adhar-console/actions/workflows/ci.yml/badge.svg)](./.github/workflows/ci.yml)
[![Release](https://github.com/adhar-io/adhar-console/actions/workflows/release.yml/badge.svg)](./.github/workflows/release.yml)
[![Image](https://img.shields.io/badge/docker-adhario%2Fadhar--console-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/r/adhario/adhar-console)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

</div>

Adhar Console is a unified operator UI over the Adhar platform. It doesn't replace
any of the open-source tools underneath — it aggregates them into one coherent,
tenant-aware experience that follows the **6D** lifecycle model:

| Phase        | What happens here                              | Backed by                                                                  |
| ------------ | ---------------------------------------------- | -------------------------------------------------------------------------- |
| **Define**   | Requirements, epics, agile issues, OKRs        | Plane.so                                                                   |
| **Design**   | ADRs, design tokens, diagrams, visual builder  | adhar-ui builder, Mermaid, Storybook                                       |
| **Develop**  | Source control, PRs, CI                        | Gitea, Argo Workflows                                                      |
| **Deliver**  | GitOps, promotion, rollouts, registry, policy  | Argo CD, Kargo, Argo Rollouts, Harbor, Kyverno                             |
| **Discover** | Observability (logs, metrics, traces)          | Grafana, Loki, Mimir, Tempo, Prometheus, OpenTelemetry, Beyla              |
| **Decide**   | Cross-cutting analytics — DORA, health, spend  | Derived from every phase                                                   |
| **Platform** | Cross-cutting Kubernetes dashboard             | Kubernetes API + Adhar-stack CRDs (Crossplane, ArgoCD, Kargo, Kyverno, …)  |

Plus a dedicated **Workspace** area for SaaS primitives: onboarding, org & project
management, members & teams, environments, API tokens, audit log, plans, quotas,
and webhooks.

---

## Why another console?

- **Transparency.** Every screen links back to its upstream open-source project.
  The [Platform status page](./docs/phases/platform.md) shows real versions and
  source URLs for Gitea, ArgoCD, Kargo, Keycloak, Kyverno, Harbor, Plane, and the
  full LGTM stack. No vendored black boxes.
- **Open-core.** Source-available under Apache 2.0. The managed offering covers
  operations, SLAs, and enterprise features — never capability.
- **Composable.** Each phase is a [Module Federation](./docs/architecture/module-federation.md)
  remote. Teams can own a phase end-to-end, deploy independently, or vendor one out.
- **Single origin, single process.** The whole console — SPA, every federated
  remote, and the BFF API — is served by one small Deno server from one origin.

---

## Architecture in one breath

```
browser ─┬─▶  SPA (host + federated remotes, one origin)
         └─▶  BFF API  ── /api/auth/*    OIDC login (Keycloak, server-side)
                        ── /api/k8s/*     per-user Kubernetes gateway (impersonation, watch, exec)
                        ── /api/svc/<tool>/…   token-injecting reverse proxy
                        ── /api/store/<kind>[/<id>]   console-owned entities (Postgres)
                        ── /api/prefs, /api/notifications   (Postgres via Drizzle)
                        ── /api/ai/*      AI assistant (read + propose)
                        ── /healthz, /readyz, /api/config
                              │
                    apps/console/server.ts  (standalone Deno server)
```

- **Client** is a Vite **SPA** (React 19 + TanStack Router/Query) with each 6D
  phase loaded as a `@module-federation/vite` remote.
- **Server** (`apps/console/server.ts`) is a dependency-light `Deno.serve` that
  statically serves the built SPA + remotes and hosts the BFF via
  framework-agnostic `Request → Response` handlers. No SSR framework.
- **Auth** is a **confidential OIDC client**: the server does the code exchange,
  verifies the ID token against Keycloak's JWKS (`jose`), refreshes
  transparently, and keeps a stateless signed session in an HttpOnly cookie —
  tokens never reach the browser.
- **Kubernetes** is reached through `/api/k8s/*` as the **signed-in user**
  (per-user OIDC impersonation): the user's Keycloak access token — minted with
  the apiserver's `kubernetes` audience + `groups` claim — is forwarded to the
  kube-apiserver, so the apiserver enforces that user's RBAC + native audit. The
  console holds no cluster privilege of its own for user-facing calls.
- **Backing tools** are reached through `/api/svc/<tool>` which injects the
  upstream credential server-side.
- **State**: live infra comes from the Kubernetes API / backing tools; Postgres
  (Drizzle) holds the console's **own** state — preferences, notifications, and
  the **document store** (`/api/store/*`): OKRs, saved views, custom roles,
  webhooks, design docs, API specs — tenant-scoped, shared across a tenant's members.
- **No stubs in a running system.** Everything above talks to real backends. The
  in-memory `.stub()` clients exist only for tests/offline (opt-in via
  `mode:'stub'`); `pnpm dev` connects to a **locally-running adhar cluster** (below).

See [ARCHITECTURE.md](./ARCHITECTURE.md) and [docs/architecture/](./docs/architecture/).

---

## Stack at a glance

| Concern       | Choice                                                                   |
| ------------- | ------------------------------------------------------------------------ |
| Runtime       | Deno 2 (`deno run`, `npm:`/`jsr:` imports)                                |
| Package mgr   | pnpm workspaces (for Vite build-time resolution)                         |
| Client        | Vite SPA · React 19.2 · TanStack Router + Query · zod                     |
| Microfrontend | `@module-federation/vite` — client-side load, one origin in prod         |
| Server        | Standalone Deno server (`Deno.serve`) — SPA host + BFF API               |
| UI            | `@adhar-ui/*` — React 19.2, Tailwind v4, CVA, Mitosis primitives         |
| Auth          | Keycloak OIDC (confidential client) → signed HttpOnly session cookie     |
| Database      | Postgres + Drizzle ORM (`postgres.js`) — prefs, notifications, doc store  |
| Deploy        | OCI image (`ghcr.io/adhar-io/adhar-console`) on the Adhar Kubernetes platform |

---

## Quickstart (dev)

`pnpm dev` connects to a **locally-running adhar cluster** — real Keycloak login,
the real kube-apiserver, real backing tools, and real Postgres. There is no stub
mode in dev.

Prerequisites: **Deno ≥ 2.0**, **pnpm ≥ 10**, **Node ≥ 20**, a sibling checkout
of [`adhar-ui`](https://github.com/adhar-io/adhar-ui) (or set `ADHAR_UI_PATH`),
and the **adhar platform running locally** (kind cluster reachable at
`*.adhar.localtest.me:8443`).

```bash
pnpm install
cp .env.example .env      # then fill in the values noted in the file
pnpm dev                  # → http://localhost:5100
```

`pnpm dev` starts **10 processes**: the **BFF** (Deno `server.ts`, `:5099`) plus
the Vite host (`:5100`) and every federated remote (`:5101–5108`). The Vite host
proxies all `/api/*` calls to the BFF, which does the real work against the
cluster. Log in at `http://localhost:5100` via the real Keycloak.

Minimum `.env` to wire (see comments in `.env.example` for how to obtain each):

| Var | Dev value |
| --- | --- |
| `KEYCLOAK_URL` | `https://keycloak.adhar.localtest.me:8443` |
| `KEYCLOAK_CLIENT_ID` | `adhar-console` |
| `AUTH_CLIENT_SECRET` | from the cluster's `keycloak-clients` secret |
| `AUTH_COOKIE_SECRET` | any random ≥32 chars |
| `AUTH_PUBLIC_URL` | `http://localhost:5100` |
| `AUTH_COOKIE_SECURE` | `false` (plain-HTTP localhost) |
| `K8S_API_URL` | your kube context server (e.g. `https://127.0.0.1:6443`) |
| `DENO_CERT` | PEM bundle trusting the apiserver + Keycloak CAs |
| `DATABASE_URL` | port-forward `console-db`, or the compose Postgres |
| tool `*_URL` | `https://<tool>.adhar.localtest.me:8443` |

> The Keycloak `adhar-console` client already allows the dev redirect
> `http://localhost:5100/api/auth/callback` (see the platform's
> `keycloak-config.yaml`).

Run a subset of remotes (the `bff` + `console` come along automatically):

```bash
deno task dev develop platform
```

**Offline / tests only:** pass `mode:'stub'` to a client factory to use the
in-memory fixtures; there is no automatic stub fallback.

## Build & run the container

The production build is a Vite SPA served by the standalone Deno server. The
easiest path is the container:

```bash
# Build (adhar-ui is passed as a BuildKit build context).
docker build \
  --build-context adhar-ui=../adhar-ui \
  -f deploy/Dockerfile \
  -t ghcr.io/adhar-io/adhar-console:dev .

# Run — needs real config. In production the server FAILS CLOSED without
# Keycloak (KEYCLOAK_URL + AUTH_CLIENT_SECRET + AUTH_COOKIE_SECRET) — it will
# not boot in demo mode. Pass the env (or use the compose stack below).
docker run --rm -p 3000:3000 --env-file .env ghcr.io/adhar-io/adhar-console:dev
#   → http://localhost:3000   ·   /healthz  /readyz  /api/config

# Local full stack (console + Postgres):
docker compose -f deploy/compose/docker-compose.yml up
```

Building without Docker: `pnpm build` (→ `apps/console/dist/`) then
`cd apps/console && deno run -A --env-file=../../.env server.ts`.

### Runtime endpoints

| Path                | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `/`                 | SPA (host + remotes, SPA-routing fallback)           |
| `/api/auth/*`       | OIDC login / callback / logout / session             |
| `/api/k8s/*`        | Per-user Kubernetes gateway (watch, log-follow, SSA); `/api/k8s/exec` (WebSocket) |
| `/api/svc/<tool>/…` | Authenticated reverse proxy to a backing tool        |
| `/api/store/<kind>[/<id>]` | Console-owned document store (Postgres, tenant-scoped) |
| `/api/prefs/<s>`, `/api/notifications` | Postgres-backed user state        |
| `/api/ai/*`         | AI assistant (read-only tools + human-approved proposals) |
| `/api/config`       | Non-secret runtime config for the browser            |
| `/healthz` `/readyz`| Liveness / readiness probes                          |

### Console-owned data (document store)

Entities that no cluster resource or backing tool owns — OKRs, saved views,
custom roles, webhooks, design docs (ADRs/diagrams/…), API specs — persist in
Postgres via a generic, tenant-scoped store at `/api/store/<kind>[/<id>]`
(`documents` table: `(tenant, kind, id) → jsonb`). It's real and multi-user:
everyone in a tenant sees the same objectives. There is **no** localStorage or
in-memory fallback — a missing DB returns `503`.

Modules use the `docStore` browser client (from `@adhar-console/shell-ui`):

```ts
import { docStore } from '@adhar-console/shell-ui'

await docStore.list('okr.objective')          // → StoredDoc[]
await docStore.create('okr.objective', {...})  // server-assigned id
await docStore.put('design.adr', id, {...})    // upsert
await docStore.remove('workspace.webhook', id)
```

## Enable SSO (Keycloak)

The console is a **confidential OIDC client**. In production these are
**required** — the server **fails closed** (refuses to boot) if Keycloak isn't
configured, so it can never silently run in demo mode (see
[docs/architecture/auth.md](./docs/architecture/auth.md)):

```bash
KEYCLOAK_URL=https://keycloak.example.com   KEYCLOAK_REALM=adhar
KEYCLOAK_CLIENT_ID=adhar-console            # dedicated confidential client
AUTH_CLIENT_SECRET=<confidential client secret>
AUTH_COOKIE_SECRET=<random ≥32 chars>       # openssl rand -base64 48
AUTH_PUBLIC_URL=https://console.example.com # external origin (redirect_uri base); required in prod
DATABASE_URL=postgres://user:pass@host:5432/db   # required for prefs + the document store
```

On the Adhar platform this client is provisioned automatically as `adhar-console`
(redirect `…/api/auth/callback`, access-token audience `kubernetes` + `groups`
claim for per-user cluster impersonation) — see the platform's
`keycloak-config.yaml`. `DATABASE_URL` is required for `/api/prefs`,
`/api/notifications`, and `/api/store/*`; without it those endpoints return
`503` and `/readyz` reports `db: unconfigured`.

## Deploy on the Adhar platform

`adhar up` deploys the console from
`platform/stack/packages/core/adhar-console/manifests/install.yaml`, which
points at `adhario/adhar-console` and wires the Keycloak + database env. The
console's own reference manifests live in [`deploy/k8s/`](./deploy/k8s/)
(Deployment with `startupProbe`, Service, Ingress, RBAC, ConfigMap, Secret,
Crossplane `Database` claim / Postgres StatefulSet). See
[deploy/README.md](./deploy/README.md).

---

## Repository layout

```
adhar-console/
├── apps/console/            # Vite SPA (MF host) + server.ts (standalone Deno server + BFF)
├── packages/
│   ├── auth/                # OIDC: client hooks + server-only code exchange/JWKS/cookies
│   ├── db/                  # Drizzle ORM schema + Postgres client (server-only)
│   ├── api-clients/         # Typed clients for every backing tool (.stub() / .auto())
│   ├── shell-ui/            # AppShell, sidebar, topbar, brand marks, data components
│   ├── tenancy/             # Tenant context + scoping
│   ├── mf-utils/            # Federated remote loader (Suspense + ErrorBoundary)
│   ├── platform-info/       # Platform version, backing-tool registry, changelog, roadmap
│   ├── build-config/        # Shared Vite host/remote config + aliases
│   └── utils/ · tsconfig/ · eslint-config/
├── modules/                 # Federated remotes — one per 6D phase + platform + workspace
├── deploy/
│   ├── Dockerfile           # Deno builder → Deno runtime (SPA + standalone server)
│   ├── compose/             # Local console + Postgres
│   └── k8s/                 # Deployment, Service, Ingress, RBAC, ConfigMap, DB
├── .github/workflows/       # ci.yml (validate) · release.yml (multi-arch → Docker Hub)
└── docs/                    # Architecture & guides (links below)
```

---

## CI / Release

Three workflows form a full release pipeline:

- **CI** ([`ci.yml`](./.github/workflows/ci.yml)) — on push/PR: fmt · lint ·
  type-check · test (reported, non-blocking) and a validation container build.
- **Version bump** ([`version-bump.yml`](./.github/workflows/version-bump.yml)) —
  manual dispatch. Pick `patch`/`minor`/`major` (or an explicit version) and it
  bumps `package.json`, promotes the `CHANGELOG` `[Unreleased]` section, commits,
  and pushes the annotated tag `vX.Y.Z`.
- **Release** ([`release.yml`](./.github/workflows/release.yml)) — fired by the
  `v*` tag: builds the **multi-arch** (amd64 + arm64) image and pushes it with
  `:X.Y.Z`, `:X.Y`, `:latest`, `:sha-<short>` tags plus **SBOM + provenance** to
  **GHCR** (`ghcr.io/<owner>/adhar-console`, always) and **Docker Hub** (only if
  its secrets are set), then cuts a **GitHub Release** with auto-generated notes
  and the image digest. Refuses to overwrite an already-published version.

### Cut a release

1. **Actions → Version bump → Run workflow** → choose the bump. That tags `vX.Y.Z`.
2. The **Release** workflow builds, pushes to Docker Hub, and publishes the GitHub Release.

> Re-publish an existing version without moving the tag via **Actions → Release →
> Run workflow** (enter the version).

### Registries & secrets

The image publishes to **GHCR by default with no setup** — it authenticates with
the built-in `GITHUB_TOKEN`, so `ghcr.io/<owner>/adhar-console` just works. Docker
Hub is an optional mirror, enabled only when its secrets are present.

| Secret | Required? | Purpose |
|---|---|---|
| *(none)* | — | GHCR push uses the built-in `GITHUB_TOKEN` |
| `DOCKERHUB_USERNAME` | optional | Docker Hub org/namespace (`adhario`) — also mirrors the image there |
| `DOCKERHUB_TOKEN` | optional | Docker Hub access token (Read/Write) |
| `ADHAR_UI_TOKEN` | optional | PAT to check out `adhar-io/adhar-ui` if private |
| `RELEASE_PAT` | optional | PAT so the bump's tag auto-triggers Release (GitHub blocks `GITHUB_TOKEN` tag pushes from starting workflows) — without it, dispatch Release manually |

> GHCR images start **private**. Make the package public (or grant pull access)
> under the org's **Packages** settings, or configure an `imagePullSecret`.

Both build jobs check out `adhar-io/adhar-ui` as a sibling for the Docker build context.

---

## Documentation

- [**Getting started**](./docs/getting-started.md) · [**Architecture overview**](./docs/architecture/overview.md) · [**Module Federation**](./docs/architecture/module-federation.md) · [**BFF**](./docs/architecture/bff.md)
- [**Auth**](./docs/architecture/auth.md) · [**Tenancy**](./docs/architecture/tenancy.md) · [**Deploy**](./docs/architecture/deploy.md) · [**Observability**](./docs/architecture/observability.md)
- Per-phase: [Define](./docs/phases/define.md) · [Design](./docs/phases/design.md) · [Develop](./docs/phases/develop.md) · [Deliver](./docs/phases/deliver.md) · [Discover](./docs/phases/discover.md) · [Decide](./docs/phases/decide.md) · [Platform](./docs/phases/platform.md) · [Workspace](./docs/phases/workspace.md)
- [**ARCHITECTURE.md**](./ARCHITECTURE.md) · [**CONTRIBUTING.md**](./CONTRIBUTING.md) · [**SECURITY.md**](./SECURITY.md) · [**CHANGELOG.md**](./CHANGELOG.md)

---

## License

Apache-2.0. See [LICENSE](./LICENSE). The backing open-source tools retain their
own licenses — [the status page](./docs/phases/platform.md#platform-status-page)
lists each one.
