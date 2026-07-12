# Architecture — overview

The console is one TanStack Start app that hosts a shell, SSR's the chrome,
and loads every 6D phase as a federated remote. Backing OSS tools are
reached only through the host's server functions (BFF pattern).

## The 6D model

```
 Define ──▶ Design ──▶ Develop ──▶ Deliver ──▶ Discover ──▶ Decide
   │          │          │           │            │           │
   └──────────┴──────────┴───────────┴────────────┴───────────┘
                          │
                 Platform (cross-cutting, always reachable)
                 Workspace (cross-cutting SaaS admin)
```

Each phase has a primary OSS backer:

| Phase    | Primary tool(s)                                                        |
| -------- | ---------------------------------------------------------------------- |
| Define   | Plane.so                                                               |
| Design   | adhar-ui builder (Yjs + Monaco + Mermaid + xyflow)                     |
| Develop  | Gitea, Argo Workflows                                                  |
| Deliver  | Argo CD, Kargo, Argo Rollouts, Harbor, Kyverno                         |
| Discover | Grafana + Loki + Mimir + Tempo + Prometheus + OpenTelemetry + Beyla    |
| Decide   | Aggregates across every phase                                          |
| Platform | Kubernetes API + Adhar CRDs (Crossplane, ArgoCD, Kargo, Kyverno, etc.) |
| Workspace| Adhar's own SaaS primitives (orgs, projects, envs, tokens, billing)    |

## Components

### 1. Host app (`apps/console`)

A TanStack Start project. Owns:

- **Route tree** — file-based routes under `app/routes/`.
- **Session & tenancy context** — injected via a server-fn loader on every
  page, so remotes can read user and active tenant without another fetch.
- **BFF** — `createServerFn(...)` endpoints in `app/server/bff.ts`. Every
  backing call flows through here; browsers never talk to OSS tools directly.
- **MF host** — `@module-federation/vite` with one remote per phase. Remote
  URLs default to `/mf/<remote>/remoteEntry.js` so a single container can
  serve host + every remote.

### 2. Modules (`modules/*`)

Each phase is a standalone Vite project that builds a federated remote. A
remote typically exposes:

- `./Home` — a top-level component, rendered when the user clicks the phase.
  It handles its own internal sub-nav.
- Optionally, finer-grained entries for routes the host wants to deep-link to.

### 3. Shared packages (`packages/*`)

Framework-neutral domain primitives. Both host and modules depend on:

- `shell-ui` — `AppShell`, `Sidebar`, `Topbar`, `DataTable`, `StatusBadge`,
  `EmptyState`, `PageHeader`, `ErrorBoundary`, `Breadcrumbs`.
- `api-clients` — typed clients for every backing tool, each with
  `.create(opts)` + `.stub()`.
- `auth`, `tenancy`, `utils`, `mf-utils`, `platform-info`.

## Data flow

```
       ┌───────── browser ─────────┐
       │  view calls useQuery(...) │
       │  → useServerFn(fn)(...)   │
       └──────────────┬────────────┘
                      │  POST /_server/<fn>
                      ▼
       ┌───── host (Deno/TanStack Start) ─────┐
       │  zod-validates input                 │
       │  reads session cookie → claims       │
       │  scopes to active tenant             │
       │  calls api-clients.<tool>.<method>()  │
       └──────────────┬───────────────────────┘
                      │  HTTPS bearer
                      ▼
              ┌──── OSS tool ────┐
              └──────────────────┘
```

- The browser never holds a Gitea, Harbor, or Kube-API token.
- Every server fn is tenant-scoped — tenant comes from the session, not the
  request body.
- Validation happens twice: input via zod, output via zod (so a misbehaving
  backing tool can't corrupt the UI).

## Deploy

One container, multiple replicas, behind an Ingress. The container image
bundles the host's SSR server, the host's static assets, and every remote's
static assets under `/mf/<remote>/`. See [deploy.md](./deploy.md).
