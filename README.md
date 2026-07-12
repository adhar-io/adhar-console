# Adhar Console

> **A transparent, open-core control plane for the full software lifecycle.**

Adhar Console is a unified operator UI over the Adhar platform. It does not replace
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

**Status**: early — every backing client ships a stub implementation; real wiring
lands in the `0.2.x` series.

---

## Why another console?

- **Transparency.** Every screen links back to its upstream open-source project.
  The [Platform status page](./docs/phases/platform.md) shows real versions and
  source URLs for Gitea, ArgoCD, Kargo, Keycloak, Kyverno, Harbor, Plane, and the
  full LGTM stack. No vendored black boxes.
- **Open-core.** The console is source-available under Apache 2.0. The managed
  offering covers operations, SLAs, and enterprise features — never capability.
- **Composable.** Each phase is a [Module Federation](./docs/architecture/module-federation.md)
  remote. Teams can own a phase end-to-end, deploy independently, or vendor a
  phase out.
- **Deno-first BFF.** A single [TanStack Start](./docs/architecture/bff.md) app
  hosts SSR + BFF on Deno — no Node runtime, no second service.

---

## Stack at a glance

| Concern        | Choice                                                                  |
| -------------- | ----------------------------------------------------------------------- |
| Runtime        | Deno 2 (`deno run -A npm:...`)                                          |
| Package mgr    | pnpm workspaces                                                         |
| Build graph    | Turborepo                                                               |
| App framework  | TanStack Start (SSR + BFF via server functions)                         |
| Microfrontend  | `@module-federation/vite` — client-side load                            |
| UI             | `@adhar-ui/*` — React 19.2, Tailwind v4, CVA, Mitosis primitives        |
| Data           | TanStack Query + zod                                                    |
| Auth           | Keycloak (OIDC) → in-app session → per-request user-impersonated tokens |
| Deploy         | Container on the Adhar Kubernetes platform                              |

---

## Quickstart

Prerequisites: **Deno ≥ 2.0**, **pnpm ≥ 10**, **Node ≥ 20**, a checkout of
[`adhar-ui`](https://github.com/adhar-io/adhar-ui) as a sibling directory
(default: `../../Adhar/AdharWS/adhar-ui`; override with `ADHAR_UI_PATH`).

```bash
# 1. Install JS deps.
pnpm install

# 2. Run the host app + every federated remote in parallel.
pnpm dev              # same as: deno task dev
# Host: http://localhost:5100
# Remotes: 5101–5108
# Ctrl+C shuts every child process down cleanly.

# Only a subset?
deno task dev console develop platform

# Just the host (no remotes; phase pages show a loading state):
pnpm run console:dev

# Production build (host + every remote, staged for single-origin serving):
pnpm build            # same as: deno task build
pnpm preview          # serves .output/server/index.mjs locally
```

`pnpm dev` and `pnpm build` both run small Deno scripts
(`scripts/dev.ts` and `scripts/build.ts`) — no Turborepo, no `concurrently`,
no extra npm deps. If you prefer Turbo for dev or build,
`pnpm run dev:turbo` and `pnpm run build:turbo` are available.

**Stubbed by default.** No real Keycloak, Gitea, or Kubernetes is required —
every client exposes a `.stub()` with realistic fixture data. Swap in a real
backend via the BFF one tool at a time; see
[docs/getting-started.md](./docs/getting-started.md).

---

## Repository layout

```
adhar-console/
├── apps/
│   └── console/              # TanStack Start host + BFF + MF host
├── packages/
│   ├── tsconfig/             # Shared tsconfig presets
│   ├── eslint-config/        # Shared ESLint config
│   ├── utils/                # cn + small helpers
│   ├── auth/                 # Keycloak OIDC + session types
│   ├── tenancy/              # Tenant context + scoping
│   ├── shell-ui/             # AppShell, nav, topbar, data components
│   ├── mf-utils/             # Federated remote loader (Suspense + ErrorBoundary)
│   ├── platform-info/        # Platform version, backing tool registry, changelog, roadmap
│   └── api-clients/          # Typed clients for every backing tool (subpath exports)
├── modules/                  # Federated remotes — one per phase
│   ├── define/               # Plane.so (projects, issues, roadmap, OKRs)
│   ├── design/               # Visual builder, ADRs, design tokens, diagrams, Storybook
│   ├── develop/              # Gitea repos/PRs, Argo Workflows
│   ├── deliver/              # ArgoCD / Kargo / Rollouts / Harbor / Kyverno (multi-tab)
│   ├── discover/             # LGTM (dashboards, logs, metrics, traces)
│   ├── decide/               # DORA, health, spend, posture
│   ├── platform/             # K8s dashboard + Adhar-stack CRD browser
│   └── workspace/            # SaaS admin: org, members, projects, envs, tokens, audit, billing
├── deploy/
│   ├── Dockerfile            # Deno distroless runtime
│   └── k8s/                  # Deployment, Service, Ingress, ServiceAccount, RBAC, ConfigMap
└── docs/                     # Architecture & guides (links below)
```

---

## Documentation

- [**Getting started**](./docs/getting-started.md) — install, run, first steps
- [**Architecture overview**](./docs/architecture/overview.md) — 6D, shell + remotes, data flow
- [**Module Federation**](./docs/architecture/module-federation.md) — how remotes are built and loaded
- [**BFF**](./docs/architecture/bff.md) — TanStack Start server functions as the aggregation layer
- [**Auth**](./docs/architecture/auth.md) — Keycloak OIDC, sessions, user-impersonated access
- [**Tenancy**](./docs/architecture/tenancy.md) — tenants, orgs, projects, namespaces
- [**Deploy**](./docs/architecture/deploy.md) — container + K8s manifests, release model
- [**Observability**](./docs/architecture/observability.md) — LGTM, OTel, Beyla, Prometheus
- Per-phase guides: [Define](./docs/phases/define.md) · [Design](./docs/phases/design.md) · [Develop](./docs/phases/develop.md) · [Deliver](./docs/phases/deliver.md) · [Discover](./docs/phases/discover.md) · [Decide](./docs/phases/decide.md) · [Platform](./docs/phases/platform.md) · [Workspace](./docs/phases/workspace.md)
- [**ARCHITECTURE.md**](./ARCHITECTURE.md) — one-page map of the whole system
- [**CONTRIBUTING.md**](./CONTRIBUTING.md) · [**SECURITY.md**](./SECURITY.md) · [**CHANGELOG.md**](./CHANGELOG.md)

---

## License

Apache-2.0. See [LICENSE](./LICENSE).

The backing open-source tools retain their own licenses — [the status page](./docs/phases/platform.md#platform-status-page)
lists each one.
