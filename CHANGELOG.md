# Changelog

All notable changes to Adhar Console are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com) and versioned with
[Semantic Versioning](https://semver.org).

## [Unreleased]

## [0.1.0] - 2026-08-07

First tagged release — published to `ghcr.io/adhar-io/adhar-console`.

### Security — enterprise hardening (k8s gateway + Keycloak)

- **k8s gateway** — strict request-header **allow-list** (never forwards
  `Impersonate-*`), client-disconnect propagated upstream, 30s timeout on
  non-streaming calls, request-body size cap, `Origin` (CSRF) check on all
  mutating verbs, structured **audit log** for every mutation + pod exec, SSA
  namespace validation/encoding, `force:false` apply default, and generic
  (non-leaking) upstream error messages.
- **Pod exec** — Origin-gated WebSocket upgrade, audited session start, stdin
  buffer cap + apiserver-open timeout, refreshed cookie carried on upgrade.
- **Keycloak/OIDC** — **fails closed in production** (refuses to boot in demo
  mode / without `AUTH_PUBLIC_URL`), **absolute session lifetime** cap on top of
  the sliding TTL, refresh **single-flight** (no rotation thundering-herd
  logout), **`__Host-`** session cookie, `Cache-Control: no-store` on session
  responses, 60s JWKS **clock-skew** tolerance, refresh-token **revocation** on
  logout, and generic auth error messages (no token-endpoint body leakage).

### Added — release management (GitHub Actions)

- **`version-bump.yml`** cuts a release from the Actions UI (bump → CHANGELOG →
  commit → `vX.Y.Z` tag); **`release.yml`** builds the multi-arch image, pushes
  it with a full tag matrix + **SBOM/provenance** to **GHCR** (always, via the
  built-in `GITHUB_TOKEN`) and **Docker Hub** (optional mirror when its secrets
  are set), and publishes a **GitHub Release** with generated notes + image
  digest (refuses to overwrite a published version).

### Fixed

- Dev K8s request flood eliminated — the host overview, workflow list, and pod
  metrics now use stub fixtures in dev instead of hitting `/kube-api`.

### Added — mature Kubernetes integration + AI assistance (0.3.0)

- **Per-user Kubernetes access.** The console authenticates to the kube-apiserver
  **as the signed-in user** (OIDC impersonation): their Keycloak token (now
  minted with the apiserver's `adhar-cli` audience + `groups` claim) is
  forwarded by a new gateway, so the apiserver enforces that user's RBAC and
  native audit — the console holds no cluster privilege of its own.
- **Kubernetes gateway** (`/api/k8s/*`) — a discovery-driven **streaming reverse
  proxy**: the full apiserver REST surface (every built-in resource *and* CRD,
  every verb), live **watch** + **log-follow** streaming, meta endpoints for API
  discovery, `SelfSubjectAccessReview`, and **server-side apply** with dry-run.
- **Live everything** — a `kube` client + `useLiveList` hook stream resource
  deltas (watch, auto-reconnect) instead of polling; a gateway-backed adapter
  gives all existing platform views per-user identity.
- **Interactive terminal** — pod exec over WebSocket (`v5.channel.k8s.io`) with
  an xterm terminal.
- **Universal resource browser** (discovery-driven, live, RBAC-gated actions),
  **manifest editor** (Monaco, dry-run + server-side apply, access-gated),
  **events timeline**, and **owner-reference topology** on every resource.
- **AI assistant** woven into every view — a self-hosted / OpenAI-compatible
  provider (no external calls), read-only Kubernetes tool-use (list/get/logs/
  events/discovery with the user's RBAC), diagnose / explain / generate, and
  **human-approved change proposals** (the AI proposes a manifest; the operator
  reviews and applies). Global streaming assistant + inline "Diagnose / Explain"
  on resources. Configure via `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY`.


## [0.2.0] — 2026-07-04

### Fixed — container build

- `deploy/Dockerfile`: corrected the runtime base image to the real Deno
  distroless tag (`denoland/deno:distroless-2.1.4`), and install pnpm from the
  statically-linked release binary (pinned to `pnpm@10.13.1`, amd64/arm64) —
  the get.pnpm.io installer left pnpm off PATH and needed libatomic on arm64.

### Added — full SSO + real backend integration

- **Server-side OIDC (confidential client).** Replaced the stubbed/browser-PKCE
  auth with a real Keycloak Authorization-Code + PKCE flow handled server-side:
  code exchange, ID-token verification against JWKS (`jose`), and transparent
  refresh near expiry. Sessions are **stateless signed JWTs** in an HttpOnly,
  SameSite=Lax, Secure cookie — multi-replica safe with no shared store. Tokens
  never reach the browser.
- **Server entrypoint split** `@adhar-console/auth/server` (config, discovery,
  cookies, session, handlers) keeps `jose` + the client secret out of the
  browser bundle; `@adhar-console/auth` stays client-safe.
- **Server routes** `/api/auth/{login,callback,logout,session}`, `/healthz`,
  `/readyz`, and `/api/config` (runtime browser config from env — one image,
  many environments).
- **Uniform BFF proxy** `/api/svc/<tool>/…` with a tool registry: resolves the
  session cookie and injects the upstream credential (user-token impersonation
  or service token) per tool. Backing-tool clients now use `.auto({ tool })` —
  real (proxy-backed) in production, stub fixtures in dev.
- **Container/K8s**: in-cluster SA-token auto-read + `DENO_CERT` CA trust for
  the kube-apiserver, hardened ConfigMap/Secret templates (`AUTH_CLIENT_SECRET`,
  `AUTH_COOKIE_SECRET`, per-tool service tokens), SSO setup guide in
  `deploy/README.md`.

### Added — Postgres + Drizzle persistence

- **`@adhar-console/db`** package: Drizzle ORM over Postgres (postgres.js) for
  the console's own state — `users`, `user_preferences`, `notification_state`.
  Lazy connection from `DATABASE_URL`, idempotent self-bootstrap DDL on first
  query (no migration Job), `drizzle-kit` config for versioned migrations, and
  graceful degradation when no DB is configured.
- **TanStack Start APIs** `/api/prefs/<scope>` (GET/PUT) and `/api/notifications`
  (GET/POST), session-authenticated and user-scoped. Server-only DB module is
  dynamically imported so postgres.js never enters the browser bundle.
- **Wired end-to-end**: overview layout preferences, catalog stars/recents, and
  notification read/dismiss state now persist to Postgres in production (per
  user, across devices/replicas) and fall back to localStorage in dev.
- **Deploy**: Crossplane `Database` claim (preferred), self-contained Postgres
  StatefulSet (fallback), and a dev `docker-compose` (console + Postgres);
  `/readyz` reports DB status; `DATABASE_URL` wired via Secret.

### Notes

- Live infrastructure state comes from the Kubernetes API / backing tools;
  Postgres holds only console-owned state.
- Dev still runs as a pure SPA (MF × Vite-7 SSR clash) with a stub "demo user";
  real SSO runs in the built/container image. See `docs/architecture/auth.md`.
- Roadmap: back-channel logout + shared session revocation (Redis), tenant
  provisioning (`/api/tenants` → Crossplane), per-tool user-impersonation
  rollout.

## [0.1.0] — 2026-04-19

Initial scaffold.

### Added

- Host app on TanStack Start (SSR + BFF via server functions) with Keycloak-
  stubbed session and tenant context.
- Module Federation host via `@module-federation/vite` with client-side remote
  loading.
- Federated remotes for each phase:
  - **Define** — Plane.so projects, issues, roadmap, OKRs.
  - **Design** — adhar-ui visual builder embed, ADR list, design tokens,
    Mermaid diagrams, Storybook catalog.
  - **Develop** — Gitea repositories & PRs, Argo Workflows pipelines.
  - **Deliver** — ArgoCD Applications, Kargo Stages + Freight, Argo Rollouts
    (promote/abort), Harbor registry with vulnerability summary, Kyverno
    PolicyReports.
  - **Discover** — Grafana dashboard embeds, Loki logs, Mimir metrics with
    inline sparklines, Tempo traces.
  - **Decide** — DORA KPIs, platform health, spend, compliance posture.
  - **Platform** — cross-cutting Kubernetes dashboard with Clusters,
    Workloads, Pods, Events, and a CRD browser for the Adhar stack (ArgoCD,
    Kargo, Crossplane, Kyverno, Argo Workflows, Argo Rollouts).
  - **Workspace** — SaaS admin: organization, members, teams, projects,
    environments, integrations, API tokens, audit log, plan, usage, webhooks,
    danger zone.
- First-run onboarding wizard: organization → invites → integrations → starter.
- Personal profile: tokens, sessions, notifications.
- Platform status page (`/status`) listing every backing OSS tool with real
  version and source-repo URL.
- Public changelog + roadmap at `/changelog`.
- Help hub at `/help`.
- `packages/api-clients` with subpath exports for Gitea, Plane, ArgoCD, Kargo,
  Harbor, K8s, Kyverno, Crossplane, Argo Workflows, Argo Rollouts, LGTM, and
  the internal Workspace SaaS client. Each client ships `.stub()` with
  realistic fixtures.
- Deno-native Dockerfile (distroless, read-only rootfs) and kustomize-ready
  Kubernetes manifests (Deployment, Service, Ingress, SA, broad-read
  ClusterRole + binding, ConfigMap, Secret template).

### Known limitations

- All backing tools are stubbed — swap for real clients via
  `docs/getting-started.md`.
- TanStack Start version pinned to `^1.87.0`; framework is evolving, minor
  adjustments may be required on first install.
- No real Keycloak wiring yet — `packages/auth/src/server.ts` has the scaffold.
- Platform view uses the console SA's broad ClusterRole; per-user impersonation
  lands in `0.3.x`.
