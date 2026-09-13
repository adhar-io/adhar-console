<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./apps/console/public/branding/adhar-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./apps/console/public/branding/adhar-logo.svg">
  <img alt="Adhar — Open Cloud-Native Foundation" src="./apps/console/public/branding/adhar-logo.svg" width="300">
</picture>

<h1>Adhar Console — one window onto the whole platform</h1>

<p><em>Every tool the platform runs, behind one sign-in and one design system.</em></p>

[![CI](https://github.com/adhar-io/adhar-console/actions/workflows/ci.yml/badge.svg)](./.github/workflows/ci.yml)
[![Release](https://github.com/adhar-io/adhar-console/actions/workflows/release.yml/badge.svg)](./.github/workflows/release.yml)
[![Image](https://img.shields.io/badge/docker-adhario%2Fadhar--console-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/r/adhario/adhar-console)
[![Deno](https://img.shields.io/badge/deno-2.x-000000?logo=deno&logoColor=white)](https://deno.com)
[![React](https://img.shields.io/badge/react-19.2-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![Module Federation](https://img.shields.io/badge/module_federation-8_remotes-7C3AED)](./docs/architecture/module-federation.md)
[![Auth](https://img.shields.io/badge/auth-OIDC_confidential_client-success?logo=keycloak&logoColor=white)](./docs/architecture/auth.md)
[![License](https://img.shields.io/badge/license-Apache%202.0-green?logo=apache)](./LICENSE)
[![Slack](https://img.shields.io/badge/slack-join_community-4A154B?logo=slack)](https://join.slack.com/t/adharworkspace/shared_invite/zt-26586j9sx-QGrIejNigvzGJrnyH~IXww)

<h3>Adhar • Built with ❤️ for developers!</h3>

</div>

---

## 🧭 What is Adhar Console?

**Sanskrit: अधार (Adhāra) – Foundation**

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

## 📸 What it looks like

<div align="center">

<img src="./docs/assets/screenshots/login.png" alt="Adhar Console — sign in with Keycloak single sign-on" width="920" />

<em>Sign in. One confidential OIDC client — your password never touches the console.</em>

<br /><br />

<img src="./docs/assets/screenshots/overview.png" alt="Adhar Console — Overview: cluster health, delivery state, capacity and policy in one view" width="920" />

<em>Overview. Cluster health, delivery state, capacity and policy on one screen — every number read live from Kubernetes and Argo CD.</em>

<br /><br />

<img src="./docs/assets/screenshots/idp-theme.png" alt="The Adhar Keycloak sign-in theme in light and dark" width="920" />

<em>Light and dark. The Keycloak sign-in page uses the console's own design tokens, and follows the theme you picked.</em>

</div>

> **On these images.** Sign-in is a live capture. Overview is a design render
> built from the console's own palette, navigation tree and real figures from a
> running cluster — the console has no demo mode, so its interior cannot be
> photographed without a signed-in session against someone's private platform.

---

## 🤔 Why another console?

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

## 🧩 Architecture in one breath

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

## 🧱 Stack at a glance

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

## ⚡ Getting started

> **Read this first.** The console is a *window onto a cluster*, not a standalone
> app. It has **no demo mode and no stub fallback** — every screen reads a real
> Kubernetes API and real backing tools. **You need an Adhar platform to point it
> at before anything else works.** That single fact is the most common reason a
> first run fails.

### Step 1 · Get a platform to point at

The console is one of the packages the Adhar platform ships, so the platform comes
first. If you don't have one, install it with
[`adhar up`](https://github.com/adhar-io/adhar), then confirm it is reachable:

```bash
kubectl get nodes                                 # a cluster you can reach
kubectl -n adhar-system get svc keycloak          # …that is an Adhar platform
```

✅ **You should see** a list of ready nodes, and a `keycloak` Service. If either
command fails, stop here — nothing below will work.

### Step 2 · Pick your path

| I want to… | Go to | Needs |
| --- | --- | --- |
| 🐳 See it running, least setup | [Step 3A — run the container](#step-3a--run-the-container) | Docker |
| 🛠️ Change the console's code | [Step 3B — develop](#step-3b--develop-the-console) | Deno, pnpm, Node |
| 🚀 Install it for a team | [Step 3C — deploy](#step-3c--deploy-on-the-adhar-platform) | platform admin |

For the **develop** path you additionally need:

| Tool | Version | Check |
| --- | --- | --- |
| Deno | ≥ 2.0 | `deno --version` |
| pnpm | ≥ 10 | `pnpm --version` |
| Node | ≥ 20 | `node --version` |
| [`adhar-ui`](https://github.com/adhar-io/adhar-ui) | sibling checkout | `ls ../adhar-ui` (or set `ADHAR_UI_PATH`) |

### Step 3A · Run the container

The fastest way to see it. Images publish to `ghcr.io/adhar-io/adhar-console`
and are mirrored to Docker Hub as `adhario/adhar-console`; GHCR packages start
private, so either make the package public or `docker login ghcr.io` first.

```bash
cp .env.example .env       # fill it in — see the env table below
docker compose -f deploy/compose/docker-compose.yml up
#   → http://localhost:3000   ·   /healthz  /readyz  /api/config
```

Every variable is listed in [the `.env` table](#the-env-you-actually-need); for
the container set `AUTH_PUBLIC_URL=http://localhost:3000`.

`docker compose` brings its own Postgres. To run the image alone against an
existing database:

```bash
docker run --rm -p 3000:3000 --env-file .env ghcr.io/adhar-io/adhar-console:latest
```

✅ **You should see** `curl -s localhost:3000/readyz` report ready, and
`http://localhost:3000` redirect you to the Adhar-themed Keycloak sign-in above.

> The server **fails closed**: without `KEYCLOAK_URL`, `AUTH_CLIENT_SECRET` and
> `AUTH_COOKIE_SECRET` it refuses to boot rather than silently starting in an
> unauthenticated mode. That is deliberate — see
> [docs/architecture/auth.md](./docs/architecture/auth.md).

### Step 3B · Develop the console

```bash
pnpm install
cp .env.example .env       # then fill in the table below
pnpm dev                   # → http://localhost:5100
```

`pnpm dev` starts **10 processes**: the BFF (Deno `server.ts`, `:5099`), the Vite
host (`:5100`), and every federated remote (`:5101–5108`). The host proxies all
`/api/*` calls to the BFF, which does the real work against your cluster. Sign in
at `http://localhost:5100` through the real Keycloak.

✅ **You should see** all 10 processes report listening, and signing in at
`http://localhost:5100` land you on Overview with live cluster numbers. Empty
cluster pages mean your Keycloak user has no RBAC — see the table below.

Working on one phase? Start only what you need — the BFF and host always come
along:

```bash
deno task dev develop platform
```

#### The `.env` you actually need

Each of these has a comment in `.env.example` explaining where to get it.

| Variable | Dev value | How to get it |
| --- | --- | --- |
| `KEYCLOAK_URL` | `https://keycloak.adhar.localtest.me:8443` | your platform's Keycloak |
| `KEYCLOAK_CLIENT_ID` | `adhar-console` | pre-provisioned by the platform |
| `AUTH_CLIENT_SECRET` | — | `kubectl -n adhar-system get secret keycloak-clients -o jsonpath='{.data.ADHAR_CONSOLE_CLIENT_SECRET}' \| base64 -d` |
| `AUTH_COOKIE_SECRET` | any random ≥32 chars | `openssl rand -base64 48` |
| `AUTH_PUBLIC_URL` | `http://localhost:5100` | the origin your browser uses |
| `AUTH_COOKIE_SECURE` | `false` | plain-HTTP localhost |
| `K8S_API_URL` | `https://127.0.0.1:6443` | `kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'` |
| `DENO_CERT` | path to a PEM bundle | must trust the apiserver **and** Keycloak CAs |
| `DATABASE_URL` | `postgres://…` | port-forward `console-db`, or use the compose Postgres |
| tool `*_URL` | `https://<tool>.adhar.localtest.me:8443` | one per backing tool you want live |

> The platform's `adhar-console` Keycloak client already allows the dev redirect
> `http://localhost:5100/api/auth/callback`, so no Keycloak change is needed.

#### When it doesn't work

| Symptom | Cause | Fix |
| --- | --- | --- |
| Server exits immediately on boot | Keycloak env missing | Set `KEYCLOAK_URL`, `AUTH_CLIENT_SECRET`, `AUTH_COOKIE_SECRET` — it fails closed by design |
| Login loops back to the sign-in page | `AUTH_PUBLIC_URL` doesn't match the origin in your address bar | Make them identical, including port |
| `certificate` / TLS errors in the BFF log | `DENO_CERT` missing or incomplete | Point it at a bundle trusting **both** the apiserver and Keycloak CAs |
| A tool's page says it can't be reached | That tool's `*_URL` is unset, so it resolves to a public hostname behind an OAuth proxy | Set the in-cluster Service URL for that tool |
| `/readyz` reports `db: unconfigured` | No `DATABASE_URL` | Preferences, notifications and the document store return `503` without it |
| Cluster pages are empty but tools work | Your Keycloak user has no RBAC in the cluster | The console impersonates *you*; bind your group in the cluster |

> **Offline / tests only:** pass `mode:'stub'` to a client factory for in-memory
> fixtures. There is no automatic stub fallback — a running system always talks
> to real backends.

### Step 3C · Deploy on the Adhar platform

`adhar up` already deploys the console as a platform package — see
[Deploy on the Adhar platform](#-deploy-on-the-adhar-platform) below for the
manifests, and [Enable SSO](#-enable-sso-keycloak) for the client it needs.

👉 The long form of all three paths — every variable, every prerequisite, and
what to expect at each step — is **[docs/getting-started.md](./docs/getting-started.md)**.

---

## 🏗️ Building from source

A production build is a Vite SPA served by the standalone Deno server. `adhar-ui`
is passed as a BuildKit build context rather than vendored, so the image build
needs it checked out alongside this repo.

```bash
docker build \
  --build-context adhar-ui=../adhar-ui \
  -f deploy/Dockerfile \
  -t ghcr.io/adhar-io/adhar-console:dev .
```

Without Docker:

```bash
pnpm build                                    # → apps/console/dist/
cd apps/console
deno run -A --env-file=../../.env server.ts   # → http://localhost:3000
```

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

## 🔐 Enable SSO (Keycloak)

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

## 🚀 Deploy on the Adhar platform

`adhar up` deploys the console from
`platform/stack/packages/core/adhar-console/manifests/install.yaml`, which
points at `adhario/adhar-console` and wires the Keycloak + database env. The
console's own reference manifests live in [`deploy/k8s/`](./deploy/k8s/)
(Deployment with `startupProbe`, Service, Ingress, RBAC, ConfigMap, Secret,
Crossplane `Database` claim / Postgres StatefulSet). See
[deploy/README.md](./deploy/README.md).

---

## 📁 Repository layout

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

## 🔄 CI / Release

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

## 📖 Documentation

| Guide | What it covers |
|---|---|
| 🚀 **[Getting Started](./docs/getting-started.md)** | The long form of the three paths above, with every variable explained |
| 🏛️ **[Architecture](./docs/architecture/overview.md)** | How the SPA, the federated remotes and the BFF fit together |
| 🧩 **[Module Federation](./docs/architecture/module-federation.md)** | How a phase is built, loaded and owned independently |
| 🔌 **[BFF](./docs/architecture/bff.md)** | Every `/api/*` surface and the token-injecting proxy |
| 🔐 **[Auth](./docs/architecture/auth.md)** | The confidential OIDC client, sessions, and per-user cluster impersonation |
| 🏢 **[Tenancy](./docs/architecture/tenancy.md)** | Tenant scoping and what is shared across an organisation |
| 🚢 **[Deploy](./docs/architecture/deploy.md)** · **[Observability](./docs/architecture/observability.md)** | Shipping it, and watching it once shipped |
| ☸️ **[Kubernetes setup](./docs/guides/kubernetes-setup.md)** | Wiring the apiserver, OIDC audience and RBAC the console expects |
| 🤝 **[Contributing](./CONTRIBUTING.md)** · **[Security](./SECURITY.md)** · **[Changelog](./CHANGELOG.md)** | Working on it, reporting issues, what changed |

**Per phase:** [Define](./docs/phases/define.md) · [Design](./docs/phases/design.md) ·
[Develop](./docs/phases/develop.md) · [Deliver](./docs/phases/deliver.md) ·
[Discover](./docs/phases/discover.md) · [Decide](./docs/phases/decide.md) ·
[Platform](./docs/phases/platform.md) · [Workspace](./docs/phases/workspace.md)

**Related repos:** [adhar](https://github.com/adhar-io/adhar) (the platform) ·
[adhar-ai](https://github.com/adhar-io/adhar-ai) (the agentic layer) ·
[adhar-ui](https://github.com/adhar-io/adhar-ui) (the design system)

---

## 📄 License

Apache-2.0. See [LICENSE](./LICENSE). The backing open-source tools retain their
own licenses — [the status page](./docs/phases/platform.md#platform-status-page)
lists each one.
