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

**Status — `0.2.x`:** real backends wired (each tool client runs live in a
production build, stub fixtures in dev), **real Keycloak SSO** (server-side
confidential-client flow), and Postgres persistence for console-owned state.
Published as a container image and deployable on the Adhar platform via
`adhar up`.

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
         └─▶  BFF API  ── /api/auth/*   OIDC login (Keycloak, server-side)
                        ── /api/svc/<tool>/…   token-injecting reverse proxy
                        ── /api/prefs, /api/notifications   (Postgres via Drizzle)
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
  tokens never reach the browser. Backing tools are reached through
  `/api/svc/<tool>` which injects the upstream credential server-side.
- **State**: live infra comes from the Kubernetes API / backing tools; Postgres
  (Drizzle) holds only console-owned state — preferences, notification state.

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
| Database      | Postgres + Drizzle ORM (`postgres.js`)                                    |
| Deploy        | OCI image (`adhario/adhar-console`) on the Adhar Kubernetes platform     |

---

## Quickstart (dev)

Prerequisites: **Deno ≥ 2.0**, **pnpm ≥ 10**, **Node ≥ 20**, and a checkout of
[`adhar-ui`](https://github.com/adhar-io/adhar-ui) as a sibling directory
(override the location with `ADHAR_UI_PATH`).

```bash
pnpm install

# Host app + every federated remote in parallel (SPA mode).
pnpm dev                       # → http://localhost:5100  (remotes 5101–5108)

# A subset only:
deno task dev console develop platform
```

Dev runs as a **pure SPA with no server**, so `/api/*` isn't available and the
login page offers a stub "Continue as demo user"; every backing-tool client
serves realistic fixtures via `.auto({ tool })`. Real SSO + real backends run in
the built/container image (below).

## Build & run the container

The production build is a Vite SPA served by the standalone Deno server. The
easiest path is the container:

```bash
# Build (adhar-ui is passed as a BuildKit build context).
docker build \
  --build-context adhar-ui=../adhar-ui \
  -f deploy/Dockerfile \
  -t adhario/adhar-console:0.2.0 .

# Run — stub/demo mode (no Keycloak/DB needed).
docker run --rm -p 3000:3000 adhario/adhar-console:0.2.0
#   → http://localhost:3000   ·   /healthz  /readyz  /api/config

# Local full stack (console + Postgres):
docker compose -f deploy/compose/docker-compose.yml up
```

Building without Docker: `pnpm build` (→ `apps/console/dist/`) then
`cd apps/console && deno run -A server.ts`.

### Runtime endpoints

| Path                | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `/`                 | SPA (host + remotes, SPA-routing fallback)           |
| `/api/auth/*`       | OIDC login / callback / logout / session             |
| `/api/svc/<tool>/…` | Authenticated reverse proxy to a backing tool        |
| `/api/prefs/<s>`, `/api/notifications` | Postgres-backed user state        |
| `/api/config`       | Non-secret runtime config for the browser            |
| `/healthz` `/readyz`| Liveness / readiness probes                          |

## Enable SSO (Keycloak)

The console is a **confidential OIDC client** — set these at runtime and it
switches from "Keycloak not configured" to real SSO (see
[docs/architecture/auth.md](./docs/architecture/auth.md)):

```bash
KEYCLOAK_URL=https://keycloak.example.com   KEYCLOAK_REALM=adhar
KEYCLOAK_CLIENT_ID=adhar-console
AUTH_CLIENT_SECRET=<confidential client secret>
AUTH_COOKIE_SECRET=<random ≥32 chars>       # openssl rand -base64 48
AUTH_PUBLIC_URL=https://console.example.com # external origin (redirect_uri base)
DATABASE_URL=postgres://user:pass@host:5432/db   # optional; enables persistence
```

Register a confidential client with redirect URI `…/api/auth/callback`. Without
`DATABASE_URL` the console still runs; persistence is disabled and `/readyz`
reports `db: unconfigured`.

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

- **CI** ([`ci.yml`](./.github/workflows/ci.yml)) runs on push/PR: fmt · lint ·
  type-check · test (reported, non-blocking) and a validation container build.
- **Release** ([`release.yml`](./.github/workflows/release.yml)) builds a
  multi-arch image and pushes to Docker Hub on a `v*` tag.

Both check out `adhar-io/adhar-ui` as a sibling for the build context — set the
`ADHAR_UI_TOKEN` secret if that repo is private, and `DOCKERHUB_USERNAME` +
`DOCKERHUB_TOKEN` for releases.

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
