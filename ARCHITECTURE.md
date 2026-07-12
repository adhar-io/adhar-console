# Architecture — one page

```
                       ┌───────────────────────────────────────────┐
     Browser ─────────▶│   TanStack Start host (SSR + BFF)         │
                       │   apps/console                            │
                       │   • Route tree (file-based)               │
                       │   • createServerFn(...) — BFF endpoints   │
                       │   • Keycloak OIDC (stub in v1)            │
                       │   • MF host for phase remotes             │
                       └───────────────┬───────────────────────────┘
                                       │ server fn
                                       ▼
                       ┌───────────────────────────────────────────┐
                       │   @adhar-console/api-clients              │
                       │   gitea / plane / argocd / kargo / harbor │
                       │   k8s / kyverno / crossplane / workflows  │
                       │   rollouts / lgtm / workspace             │
                       │   .create({ baseUrl, token })  |  .stub() │
                       └───────────────┬───────────────────────────┘
                                       │
                           ┌───────────┴───────────┐
                           ▼                       ▼
                  ┌──────────────────┐   ┌──────────────────┐
                  │ Backing OSS tool │   │  Kube-API (SA)   │
                  │ REST/gRPC/OCI    │   │  per-request     │
                  └──────────────────┘   └──────────────────┘

        Host app dynamically imports each phase remote at runtime:

   import('define/Home')  import('develop/Home')  import('platform/Home') ...

        Each remote is its own Vite build, served at /mf/<remote>/remoteEntry.js
```

## Principles

1. **Aggregate, don't replace.** Every capability is backed by an upstream
   open-source project. The console never shadows a tool's functionality — it
   surfaces it next to neighbouring tools so operators don't have to juggle 10
   tabs.

2. **One process, many remotes.** A single container runs the SSR host and
   serves every federated remote. Ops simplicity now; independent deploys if
   and when a team claims a phase.

3. **BFF at the edge.** No browser-to-OSS-tool network calls. All backing
   traffic flows through the console's server functions, which inject the
   user's short-lived access token (Keycloak) and apply tenant scoping.

4. **Tenant-first.** Every list, every CRD, every metric query is scoped by
   tenant. The tenant switcher in the topbar mutates all server-fn calls
   downstream.

5. **Transparent by default.** `/status` exposes real versions, source URLs,
   and live health of every backing tool. `/changelog` is public. Pricing and
   quotas are public. Audit log is visible to tenant admins.

## Runtime shape

```
 ┌────────────────────────── Kubernetes cluster ──────────────────────────┐
 │                                                                         │
 │  Ingress  ──▶  Service ──▶  Deployment: adhar-console (2 replicas)      │
 │                             │  Deno runtime (distroless)                │
 │                             │  serves SSR + static + BFF + /mf/*/       │
 │                             └── SA: adhar-console (ClusterRole reader)  │
 │                                                                         │
 │  Other namespaces: gitea, argocd, kargo, harbor, keycloak, kyverno,     │
 │   grafana, loki, mimir, tempo, prometheus, otel-collector, plane, ...   │
 │                                                                         │
 └─────────────────────────────────────────────────────────────────────────┘
```

Everything runs on the same Kubernetes platform the console is operating.
In-cluster service account tokens are used for the Platform view; user tokens
are used for all per-tenant calls.

## Code topology

- `apps/console` — the host. Only place that knows about SSR, the route tree,
  and MF host configuration.
- `modules/*` — each phase is a self-contained remote. Each has its own
  `vite.config.ts`, its own `deno.json`, and exposes one or more components
  via `federation({ exposes })`.
- `packages/*` — framework-neutral domain code shared between host and remotes.
  Importantly, `shell-ui` and `api-clients` are consumed across every remote
  and the host so UI and network shape stays consistent.

## Reading order

For new engineers joining a phase module, the recommended path is:

1. [`docs/architecture/overview.md`](./docs/architecture/overview.md) — the
   10-minute tour.
2. [`docs/architecture/module-federation.md`](./docs/architecture/module-federation.md)
   — why this shape, how remotes are wired.
3. [`docs/architecture/bff.md`](./docs/architecture/bff.md) — data fetch path.
4. The guide for the phase you'll work on (`docs/phases/<phase>.md`).
