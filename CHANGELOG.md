# Changelog

All notable changes to Adhar Console are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com) and versioned with
[Semantic Versioning](https://semver.org).

## [Unreleased]

## [0.1.24] - 2026-08-31

### Added

- **Workloads get an OpenShift-style detail.** Deployments, StatefulSets, and
  DaemonSets now open the same rich tabbed drawer Pods already had —
  **Overview · Scale/Rollout · Metrics · Logs · Shell · YAML · Events**. Metrics,
  Logs, and Shell run behind a pod picker (scoped to the workload's selector,
  defaulting to the first Ready pod) reusing the existing metrics / log-stream /
  xterm-terminal panels; the Shell streams to the container over the per-user
  exec proxy, exactly like the Pod terminal. YAML is the Monaco editor pointed at
  the workload itself (RBAC-gated apply). The **Scale/Rollout** tab is the
  centerpiece: a replica gauge (ready/desired/updated/available), inline scale
  and scale-to-0/restore, rollout **restart** and **pause/resume**, a
  **revision-history** timeline with rollback from owned ReplicaSets, the
  associated **HPA** (min→max position + per-metric utilization), and — when an
  **Argo Rollout** backs the workload — its canary/blue-green **step ladder**
  with live weight and step status. DaemonSets show node coverage instead of a
  replica count. Every panel has a real / loading / empty / not-authorized path.

- **Tekton pipeline management (CI/CD).** The platform **CI / CD** section is now
  a full Tekton surface: a live **PipelineRuns** list (status, trigger, task
  progress, ticking duration), plus **Pipelines**, **Tasks**, and **Triggers**
  (EventListener → binding → template service map) tabs. Each run opens a
  **task-DAG** (topologically laid out, health-coloured, `runAfter` + result/when
  edges) with per-step **log streaming**, params, results, workspaces, timeline,
  and conditions. Management actions — **cancel**, **re-run**, **delete**, and
  **run a pipeline** — are RBAC-gated and routed through the per-user gateway.

- **Delivery Flow — end-to-end value stream.** A new Deliver page visualizes one
  service's change from commit to production as a horizontal flow:
  **Code → Pull Request → Build → Dev loop → Preview env → Promotion → GitOps
  sync → Rollout**. Each stage pulls real status from its backing tool (Gitea
  commits/PRs, Tekton/kpack builds, Coder workspaces, preview ArgoCD apps, Kargo
  stages/freight, ArgoCD sync/health, Argo Rollouts), with SVG edges coloured by
  whether the change cleared each stage, click-to-drill-in panels, deep links to
  the full views, and honest "not configured / no data" nodes.

- **JupyterHub in the app launcher.** JupyterHub joins the Apps drawer with its
  official logo, discovered via `JUPYTERHUB_URL` (honest "not set up" until
  configured).

## [0.1.23] - 2026-08-31

### Added

- **Adhar Resources — live composition topology.** Each Crossplane composite's
  detail drawer now has a **Graph ⇄ List** view of its composed resources: the
  composite on the left, every managed resource it created fanning out on the
  right, edges and nodes coloured by real, live health (healthy / degraded /
  unknown / deleting), with a health rollup legend. Nodes (and list rows) are
  **click-to-inspect**: selecting one opens a live inspector for that managed
  resource — its real conditions, status, and age, fetched on demand through the
  per-user gateway (auto-refreshing), with honest "not authorized / not found /
  not discoverable" states. Reuses the existing health discovery, so the graph
  adds no extra API load.

### Changed

- **Apps drawer curated.** Removed **Loki** and **Tempo** tiles — they have no
  standalone UI (you reach them through Grafana Explore). Added **Hubble**
  (Cilium network flows) and **Kafka UI**, with their official logos. Hubble
  shows enabled where deployed; Kafka UI shows honestly "not set up" until it's
  installed.

## [0.1.22] - 2026-08-30

### Changed

- **Scaffold builds pin the Java toolchain (JDK 25 + Maven 3.9.x).** The kpack
  `Image` now sets Paketo build env `BP_JVM_VERSION=25` and
  `BP_MAVEN_VERSION=3.9.9`, so Java services build on JDK 25 with Maven 3.9.x.
  These only affect Java/Maven builds — every other language ignores them and
  uses the buildpack's latest default. Overridable via `BP_JVM_VERSION` /
  `BP_MAVEN_VERSION`.

## [0.1.21] - 2026-08-30

### Changed

- **Scaffolder builds new services with Cloud Native Buildpacks (kpack).** The
  build step now creates a kpack `Image` (no Dockerfile) that builds the new
  repo with the platform's `adhar-builder` ClusterBuilder, pushes the OCI image
  to Harbor via the `adhar-pipeline` service account, and auto-rebuilds on every
  commit — matching the platform supply chain (`supply-chain/50-service-template`).
  Reported as `build-buildpacks` in the run log. Replaces the previous Tekton
  push-webhook step (kpack polls git, so no webhook is needed for builds).
  Registry/builder/namespace are overridable via `KPACK_REGISTRY`,
  `KPACK_BUILDER`, `KPACK_SERVICE_ACCOUNT`, `KPACK_NAMESPACE`.

## [0.1.20] - 2026-08-30

### Changed

- **Scaffolder wires new repos to Tekton CI (not Gitea Actions).** Adhar's CI is
  Tekton: a Gitea push webhook posts to the `adhar-ci` EventListener, which starts
  a PipelineRun. The Create-New scaffold step now registers a per-repo push
  webhook → the Tekton EventListener (`TEKTON_EVENTLISTENER_URL`, default the
  in-cluster `el-adhar-ci` service) instead of checking for `.gitea/workflows` +
  a Gitea Actions runner. Idempotent, and reported truthfully in the run log
  (`ci-tekton`). Pairs with the platform's generic `scaffold-ci` Tekton pipeline
  (clone → test → build image → push to Harbor → GitOps) so a scaffolded repo
  builds and deploys on push.

## [0.1.19] - 2026-08-30

### Fixed

- **Create-from-template "Owner" picker is no longer empty.** It sourced teams
  from live-catalog `Group` entities, of which a real cluster has none — so the
  required Owner field had nothing to pick and the wizard stalled. A new BFF
  endpoint `GET /api/teams` discovers `kind: Group` teams from the
  `adhar/adhar-templates` Gitea repo and **always** includes the two defaults
  `default-platform` and `default-application` in every org (also seeding a
  `teams.yaml` into that repo so they genuinely originate there). The owner
  picker merges these with any catalog Groups, so it's never empty.

### Changed

- **Create New runs the full journey automatically.** Gitea-discovered templates
  now default to `gitops: true` (with `deploy/` as the manifest path), so
  submitting the wizard generates a real repo **from the template's code**
  (`git_content`), commits the catalog descriptor, and creates an Argo CD
  Application that deploys it. The scaffold run log now reports each real step —
  repo created → template code copied → catalog-info → CI workflow/runner →
  Argo CD app — with honest status (e.g. it reports truthfully when a repo's
  `.gitea/workflows` CI can't run because no Gitea Actions runner is registered,
  rather than faking success).
- **Loki now shows its real logo** in the app launcher (Tempo, Mimir, Kargo,
  Plane and OpenCost keep the Kubernetes fallback until official SVGs are added).

## [0.1.18] - 2026-08-30

### Changed

- **Top-bar layout + selectors polished.** The search box moves to the **left**
  and is enhanced into a proper search field (wider, clearer placeholder, ⌘K
  hint; collapses to an icon on mobile). Cluster + Namespace move to the
  **right**, and both are now consistent, styled dropdowns: the cluster is a
  dropdown even with a single cluster (a one-item menu, no more static chip),
  and the namespace picker is a custom dropdown (replacing the native select)
  with a filter box once there are more than a few namespaces, health/version
  detail, and the org-scoped "no namespaces in this org" hint inline.

## [0.1.17] - 2026-08-30

### Changed

- **Cluster + Namespace selection moved to the top bar.** The active cluster
  chip (name + reachability dot) and the Namespace dropdown are now a single
  common control in the top bar on Platform pages, instead of being repeated in
  each view's header. Selection is a shared store backed by localStorage + a
  window event, so it stays in sync across the Module-Federation boundary (host
  top bar ↔ platform remote); every platform data hook folds the active
  cluster + namespace into its query key, so changing either re-scopes all
  views. The per-page pickers were removed (drill-down log/shell/explore views
  keep their own inline namespace control).

### Added

- **Organization isolation.** Console-owned data (document store, workspace
  data) is tenant-scoped by the active organization server-side, and switching
  org re-signs the session and reloads so no in-memory cache leaks across orgs.
  Platform/Kubernetes views can now be scoped to an organization's namespaces
  via the label convention `adhar.io/org=<slug>`: when a non-default org is
  active, the namespace picker + platform listings are restricted to namespaces
  carrying that label (honest empty state with a hint when none are assigned);
  the default/single-org case keeps showing all namespaces. Kubernetes RBAC is
  unchanged — every call still goes through the per-user impersonation gateway.

## [0.1.16] - 2026-08-30

### Added

- **Marketplace is driven by the Adhar ApplicationSet, with GitOps enable/disable.**
  The Platform → Marketplace now lists the real apps/tools from the cluster's
  `helm-charts-*` ApplicationSet (every `list.elements[]` entry — name, category,
  enabled state, namespace, manifest path) and cross-references live Argo CD
  Application health/sync. Enabling or disabling an app is a **GitOps** action: a
  new BFF endpoint `POST /api/platform/appset/toggle` flips that element's
  `enabled` flag in the ApplicationSet's Git source and commits it (a scoped,
  formatting-preserving YAML edit with the Gitea service token), so ArgoCD
  reconciles — identical to editing the file in Gitea by hand. The appset's
  repo/path is auto-discovered from the managing Argo CD Application, with
  `ADHAR_APPSET_REPO`/`ADHAR_APPSET_FILE` env overrides. Replaces the previous
  hardcoded chart catalogue + localStorage install state.

### Changed

- **Adhar Resources load real Crossplane composites.** The platform composites
  are Crossplane v2 namespaced XRs under `platform.adhar.io/v1alpha1` with
  `composite<Domain>` plurals; the views queried bare plurals that don't exist.
  Corrected the GVR + kind for each sub-view (applications → `compositeapplications`,
  databases → `compositedatabases`, buckets → `compositestorages`, topics →
  `compositemessagings`, pipelines → `compositepipelines`, environments →
  `compositeenvironments`), so Catalog and each resource view list real
  instances with real status; kinds with no XRD (functions/workflows/caches)
  honestly show the "not installed" empty state.

## [0.1.15] - 2026-08-29

### Added

- **Create New loads software templates from Gitea.** A new BFF endpoint
  `GET /api/templates` discovers templates hosted in Gitea — every repo flagged
  as a Gitea *template repository*, plus the curated templates org
  (`GITEA_TEMPLATES_ORG`, else `GITEA_ORG`) — using the platform Gitea service
  token. Each repo becomes a Create-New card whose `scaffold.sourceRepo` feeds
  the existing `/api/scaffold` engine (generate-from-template → GitOps). An
  optional `.adhar/template.json` in a repo enriches the card (title, family,
  wizard steps, glyph…); otherwise it's built from repo metadata. The page shows
  a provenance row ("N templates from Gitea") and falls back to the built-in
  seed templates when Gitea isn't connected.

### Changed

- **Service Catalog hides platform/system workloads.** The live catalog view
  now filters out system namespaces (`adhar-system`, `kube-system`,
  `cert-manager`, any `*-system` or `kube-*`, and other platform namespaces), so
  it shows apps in user namespaces (and `default`) rather than the platform's
  own pods.
- **Overview page shows only real cluster data — no fabricated widgets.** Audited
  all 56 dashboard panels + the home widgets. Newly wired to real sources: the
  DORA hero and cost-trend (Argo CD deploy history / OpenCost), the deploy
  heatmap (Argo CD), pod restarts (live `restartCount`), certificate expiry
  (cert-manager), Gitea repo metrics, and GitOps recent-syncs. Panels whose
  backing tool isn't deployed now render an honest "connect &lt;tool&gt;" empty
  state instead of hardcoded rows/series, and `PlatformHealthPanel` shows "—"
  for any sub-score with no data rather than a fabricated 95/92/96 (and its
  performance score now reads the real error-rate signal). Added
  `useCertificates()` and `useCostTrend()` signals.

### Fixed

- **App launcher marks all deployed tools as enabled.** Harbor, MinIO, Argo
  Rollouts, Kyverno, Crossplane (and Trivy, via Harbor) were shown as "not set
  up" only because their `<TOOL>_URL` env vars were never wired into the console
  deployment. Their in-cluster Service URLs are now set, so the launcher reports
  them enabled (Kyverno/Crossplane have no web UI — their data flows via k8s
  CRDs; the URLs just mark the tiles enabled). Tools genuinely not deployed
  (Falco, Kargo, OpenCost, …) still show honestly as "not set up".

## [0.1.14] - 2026-08-29

### Added

- **Profile is fully editable — avatar, details, links, and custom sections.**
  Upload a profile photo (resized client-side to 256px and stored as a bounded
  image in your per-user preferences, with change/remove; falls back to the
  generated initials avatar). New editable fields — pronouns, department,
  company, location, phone — alongside the existing name/title/bio/timezone/
  locale. A dynamic **Links** list (label + URL, add/remove) and user-defined
  **Custom fields** let you add your own sections. Everything persists through
  the Postgres-backed `/api/prefs/profile` document behind a single sticky Save
  bar; inputs are size/count-capped and non-image avatars are rejected.

## [0.1.13] - 2026-08-29

### Fixed

- **Login goes straight to the dashboard; only sign-up goes to onboarding.**
  Both the "Continue with Single Sign-On" and "Create a new account" buttons
  landed on `/onboarding`, because the OIDC callback chose the destination from
  `tenants.length === 0` — always true for Keycloak users (their token carries
  `groups`, not `tenants`). The destination is now driven by the sign-in
  **intent** carried through the auth transaction: `register` → `/onboarding`,
  `login` → the app (or an explicit same-origin `returnTo`). The client-side
  first-run gate that could still bounce a fresh browser to onboarding was
  removed, so a normal login always lands in the console. Onboarding stays
  reachable via "Create a new account" and the in-app entry point.

## [0.1.12] - 2026-08-29

### Fixed

- **Admin users no longer resolve as "Viewer".** Keycloak assigns Adhar RBAC via
  **group membership**, surfaced in a `groups` claim (e.g. a user in the
  `/platform-admin` group). The console only read a `tenants` claim and filtered
  realm roles to a fixed list, so a group-only admin — which is every seeded
  user — collapsed to the least-privilege `viewer`. The ID/access-token
  `groups` claim is now read end-to-end (Claims → User → session), and role
  resolution aliases realm roles, client roles AND group names to the console
  persona. Verified against the live realm: `user1` (`groups:[platform-admin]`)
  now resolves to **Platform admin**.

### Changed

- **RBAC model — read-everything, write-by-role.** Every persona now sees *all*
  details across the console (navigation is no longer hidden by role); what
  differs is write access, gated by a capability layer (`can` / `useCan` /
  `isReadOnly`, capabilities `platform.manage`, `workspace.manage`, `app.manage`,
  `develop`, `create`). The persona set is stated clearly:
  **Super admin** (Keycloak `admin`), **Platform admin**, **Platform engineer**,
  **Application admin**, **Developer**, **Viewer** — resolved high→low privilege,
  least-privilege default. The `super-admin` persona + its RoleChip tone are new;
  the auth `Role` union was widened to match. Platform Keycloak config gains the
  `platform-engineer` and `application-admin` groups so the full taxonomy is
  assignable.
- **`npm run release`** — one command to bump the version, promote the CHANGELOG,
  commit, tag `vX.Y.Z` and push (triggers the Release pipeline). Supports
  `patch|minor|major`, an explicit version, and `--dry`.

## [0.1.11] - 2026-08-29

### Added

- **Role-based experience** — the console now adapts to the signed-in persona
  (Platform admin, Application admin, Developer, Platform engineer, Viewer),
  resolved from Keycloak realm roles + groups (`platform-admin`,
  `platform-developer`, `platform-viewer`, …; least-privilege `viewer` default).
  The sidebar nav is filtered to a role-appropriate menu, a role chip shows in
  the topbar, and `landingPathForRole` steers each persona to its most relevant
  home.
- **Backing platform tools are now connected.** The console proxies these
  server-side, so each `<TOOL>_URL` is the tool's IN-CLUSTER Service URL (the
  public `*.localtest.me` hosts resolve to loopback inside the cluster). Wired
  the tools actually deployed in the platform — Argo CD, Gitea, Grafana,
  Prometheus, Loki, Mimir, Tempo, Vault, Tekton (plus Argo Workflows / Keycloak
  already). `publicToolInfo()` hides in-cluster URLs from the browser and marks
  the tool configured; the app launcher derives the public browser link from the
  cluster base domain. Tools not deployed stay honestly "not set up."

### Fixed

- **Login no longer forces onboarding every time.** The Keycloak token has no
  `tenants` claim (it carries `groups`), so the old `tenants.length === 0` guard
  bounced EVERY sign-in through onboarding. The console auto-provisions a default
  organization, so a signed-in user lands straight in the app; onboarding is now
  a one-time first-run helper (skips/completes are remembered) rather than a
  blocking gate.

## [0.1.10] - 2026-08-29

### Fixed

- **THE Keycloak login loop — real root cause.** Diagnosed against the live
  cluster: the generated Postgres password contains URL-reserved characters
  (`/`, from the platform's `symbolCharacters: /-+`), so `DATABASE_URL`
  (`postgres://console:…/…@…`) was an **invalid URL**, `postgres(url)` threw
  "Invalid URL", and the database silently reported **down**. With no database
  the server-side session store couldn't engage, so the session cookie inlined
  all three Keycloak JWTs (~5.7 KB) — over the browser's ~4 KB limit — and the
  browser **silently dropped it**, making every request anonymous and bouncing
  the user back to `/login`. The DB connection now prefers the discrete
  `POSTGRES_HOST/PORT/DB/USER/PASSWORD` components (immune to URL encoding) and
  percent-encodes the password in the `DATABASE_URL` fallback — verified
  connecting to the live database with the real password.
- **Defense in depth**: even if the database is ever unreachable, the inline
  session cookie now drops the large refresh/id tokens (keeps only the access
  token) so it stays under the browser limit and login still completes. Session
  tokens are stored server-side (Postgres) when the DB is up so the cookie is a
  tiny session id; logout deletes the store row (real revocation). `/api/diagnostics`
  now reports the session-store mode.

## [0.1.9] - 2026-08-29

### Fixed

- **Keycloak login now completes — session cookie no longer dropped.** The
  session cookie inlined all three upstream Keycloak JWTs (access + refresh + id
  tokens); with Keycloak 26's larger tokens that exceeded the browser's ~4 KB
  per-cookie limit, so the browser silently discarded it — every request looked
  anonymous and the app bounced straight back to `/login`. Tokens now live in a
  **server-side session store** (Postgres `documents` table, reserved
  `auth`/`auth.session` scope — no schema migration) and the cookie carries only
  a small opaque session id. Both the new `{sid}` cookie and legacy inline
  cookies are accepted, the session id is preserved across token refreshes, and
  logout now deletes the store row (real revocation). Falls back to the legacy
  inline cookie when no database is configured (local dev). This is the actual
  fix behind the repeated "redirects back to login" reports.

## [0.1.8] - 2026-08-27

### Fixed

- **Keycloak login redirect loop**. An already-authenticated user landing on
  `/login` with a `?returnTo=/login` (a stale tab / bookmark after the OIDC
  round-trip) was redirected straight back to `/login`, which re-triggered the
  guard and looked like the page endlessly reloading. The root auth gate now
  never sends an authenticated user back to `/login` — it falls through to the
  app (`/`) — completing the post-login round-trip cleanly.

## [0.1.7] - 2026-08-16

### Added

- **Organizations** — a real, working org (workspace) switcher in the sidebar.
  Switch between organizations and create new ones; the list is persisted
  per-user server-side (`/api/organizations`), and switching re-signs the
  session's `activeTenant` (which scopes the console's own data) then reloads
  for a clean slate. Kubernetes RBAC is unaffected (driven by Keycloak groups).
  Fixes the previously inert `onTenantChange` no-op and the dead "New
  organization" button.
- **Quick Apps launcher — reworked**: dynamic app discovery driven by the BFF
  (`/api/config` is authoritative for availability + URL; 10 more backing tools
  registered), correct per-app routes (right subdomains / Grafana-Explore
  deep-links / registry-scanner fallthrough), a clean function-based category
  taxonomy (Code · Build & CI · Deploy · Registry · Observe · Data · Security ·
  Platform), fuzzy search, full keyboard navigation, pinned + recent apps, and
  honest configured / "not set up" states.
- **Profile** — a real, tabbed settings area (Profile, Appearance, Notifications,
  API tokens, Security & sessions). Editable fields persist to `/api/prefs`;
  theme/mode/density/reduced-motion apply live and survive reload; personal
  tokens use the real `/api/workspace/tokens` flow; identity, MFA, password and
  the cross-device session list are honestly "managed in Keycloak". Replaces the
  previous stubbed sessions/tokens.
- **Workspace configuration** — four new persisted pages: Branding & locale,
  Defaults (namespace prefix, env/cloud/region, container requests/limits,
  labels), Notification routing (per-category → in-app/email/Slack-webhook with
  a real webhook test), and Feature flags (opt-in preview capabilities).
- Navigation **progress bar** on every route change and a **seamless redirect
  overlay** during the Keycloak hand-off on the login screen.

### Changed / Fixed

- **Loading skeletons** now use the themed shimmer + semantic tokens — fixes the
  white/bordered-box flash that appeared on every module load (it was the
  fallback skeleton's hardcoded `bg-white`/`border-slate-200`, not SSR).
- **Kubernetes connection UX** — removed the "run `kubectl proxy`" instructions
  entirely; the cluster connects transparently through the authenticated
  `/api/k8s` gateway, and failures now show a calm, illustrated error screen with
  a Retry action and a link to `/api/diagnostics` (RBAC vs unreachable
  distinguished). Cleaned the remaining stale kube-proxy references.
- **Post-login redirect** — an authenticated user landing on `/login` is now
  sent into the app honoring `?returnTo`.

### Notes

- Companion platform-repo change (separate `adhar` repo, needs an ArgoCD sync):
  the `adhar-console` Keycloak client's service account is granted realm-
  management roles so the workspace team→group RBAC reflection goes live via the
  existing `AUTH_CLIENT_SECRET`.

## [0.1.6] - 2026-08-16

### Added

- **Workspace & Organization management** — a real, tenant-scoped SaaS surface
  persisted in Postgres (no schema migration; generic document store):
  - Org, members (invite → token, role change, remove), teams + membership,
    projects, API tokens (hash-only, shown once), an approval queue + persisted
    approval policies, and an audit log written on every mutation.
  - **Keycloak group reflection**: team / org-role changes sync into realm
    groups (`ws-team-*` / `ws-role-*`) for real cluster RBAC, using the console
    client's own service account (see the platform Keycloak change). Degrades to
    `keycloakSynced:false` (console-only) when the admin credential is absent.
  - **Billing** — plans, subscription + seats, budgets, cost centers, payment-
    method metadata (rejects raw PAN/CVC); usage metered from REAL sources
    (member seats + live k8s counts + OpenCost `$`, `null` when unavailable —
    never fabricated); invoice generation; a `BillingProvider` seam (Local
    default, Stripe stub gated on `STRIPE_SECRET_KEY`).
  - Enterprise-security views (SSO, MFA/session, security policies, IP allowlist,
    compliance, integrations) now persist real config via the document store.
- **Platform Kubernetes — enterprise operations**:
  - New views: **Namespaces** (ResourceQuota / LimitRange, create/delete),
    **Autoscaling (HPA)** (current-vs-target metrics, edit bounds, create),
    **Helm Releases** (revisions, values, uninstall).
  - New actions: node **drain** (PDB-honoring eviction) + taint/label editors,
    workload **rollback** (`rollout undo` semantics), CronJob suspend / trigger-
    now, Job rerun/delete, Secret reveal/edit + ConfigMap edit.
  - **Multi-cluster** switcher — active-cluster context threaded through the data
    layer (`K8S_CLUSTERS` + `?cluster=`), byte-identical single-cluster behavior.
  - Cluster-health dashboard (node pressure, not-ready nodes, pending/failed
    pods, recent warnings) — honest "metrics unavailable" states.
- **Adhar Resources — self-service developer platform**: in-console
  **provisioning wizard** (generated per-kind forms → build + server-side-apply a
  real Crossplane claim), **edit**, and **deprovision**; richer detail
  (connection-secret reveal, events, composed-resource health). Real form schemas
  for all 13 kinds + 4 new kinds (Queue, Certificate, SecretStore, LoadBalancer).
- Login screen: a seamless redirect overlay during the Keycloak hand-off, plus a
  refined card treatment.

### Changed / Fixed

- **Kubernetes connection — removed the dummy `kubectl proxy` path.** Deleted
  `K8sClient.create()` / `/kube-api` and the dead `isDevK8s` stub-fixture
  scaffolding. The console now has exactly one real path: the authenticated BFF
  gateway at `/api/k8s` (per-user token impersonation). The k8s client gained
  typed errors + bounded retries (429/Retry-After), watch/stream cleanup, and
  clearer TLS/connection errors pointing at `/api/diagnostics`.
- Removed fabricated nav badges (member counts, cluster counts, event counts) now
  that the underlying data is real.

### Notes

- Companion platform-repo change (separate `adhar` repo, needs an ArgoCD sync):
  the `adhar-console` Keycloak client now has `serviceAccountsEnabled: true` and
  its service account is granted realm-management roles, so the workspace
  team→group RBAC reflection goes live using the console's existing
  `AUTH_CLIENT_SECRET` — no separate admin credential required.

## [0.1.5] - 2026-08-15

### Added

- **Platform feature set** (Golden Paths, Score Cards, Package provenance, Policy
  Packs, AI-assisted operations):
  - **Golden paths** — production-quality scaffolding templates (microservice,
    frontend, data pipeline, ML) whose new repos ship pre-wired with a CI
    workflow, Dockerfile, Kustomize deploy manifests (resource limits + probes),
    and observability (Prometheus ServiceMonitor + OTEL env). The scaffolder
    commits the full generated file set to the new Gitea repo.
  - **Score cards** — a weighted production-readiness engine (ownership,
    delivery, reliability, security, observability) scoring every catalog entity
    0–100 → A–F, with a dashboard at `/scorecards` and a per-service check
    breakdown. Signals are derived from real entity metadata (no fabricated
    passes). New "Score Cards" sidebar entry.
  - **Package marketplace** — charts now carry **provenance** (cosign/notation
    signature + signer, Trivy scan grade + CVE counts + SBOM) and a
    **compatibility contract** (kube-version range, required CRDs/capabilities,
    dependsOn, tested-on). Trust filters + a caution-gated install for
    unsigned/unscanned packages.
  - **Policy packs** — opt-in compliance profiles (CIS Kubernetes Benchmark,
    SOC 2 baseline) shipped as audit-mode Kyverno `ClusterPolicy` bundles, with a
    "Compliance packs" tab whose coverage ring is computed from live findings.
  - **AI-assisted operations** — five read-only diagnostic tools (`k8s_describe`,
    `k8s_pod_diagnostics`, `k8s_workload_health`, `k8s_events_scan`,
    `argocd_app_status`) and a platform-aware, evidence-first debugging prompt.
    Strictly read + propose-only — the assistant never mutates the cluster.
- **`/api/diagnostics`** — a live connectivity endpoint reporting the actual
  resolved Keycloak issuer/endpoints, DB status, and a real apiserver call with
  the user's token, so login / cluster failures (issuer scheme, aud, RBAC, TLS,
  unreachable API) are diagnosable at a glance. The `/api/k8s` gateway also
  surfaces the upstream error detail in dev.
- **Login screen** gains a light/dark/system toggle and friendly, retryable
  error messages.

### Fixed

- **Dark mode "wrong font colors"**. The `.dark` theme globally overrode
  `--color-white` / `--color-black` to flip `bg-white` cards — but that also
  turned genuine white utilities (`text-white` labels on colored buttons/badges,
  `ring-white` frost, `to-white` gradient stops) **dark**. White surfaces across
  the host, shell-ui, and all six lifecycle modules were moved onto semantic
  `surface-*` tokens (pixel-identical in light mode), tinted `*-50` gradient
  tiles got `dark:` stops, cutout rings became `ring-surface-raised`, and the
  leaky `--color-white` / `--color-black` overrides were removed. `status-badge`
  gained proper `dark:` variants.
- **Score Cards page margins** — it rendered at the default `standard`
  (max-w-7xl, centered) content width while the other dashboards use `full`; now
  full-width to match, plus a fleet "readiness by category" strip.

### Notes

- The companion in-cluster login / kube-apiserver auth fix lives in the platform
  repo: Keycloak's `hostname-strict-backchannel` is set to `true` so it emits a
  stable **https** issuer over the in-cluster http backchannel (the http issuer
  was being rejected by both the console's id-token check and the apiserver's
  strict `--oidc-issuer-url`). Requires a Keycloak pod restart to take effect.

## [0.1.4] - 2026-08-10

### Fixed

- **In-cluster login redirect** (follow-up to 0.1.3). With `KEYCLOAK_INTERNAL_URL`
  set, discovery is fetched over the internal http backchannel, and Keycloak
  reflected that scheme into the URLs it returned — so the browser-facing
  `authorization_endpoint` came back as `http://…:8443/…/auth` (http on the HTTPS
  gateway port), breaking the redirect to the login page. `discovery.ts` now pins
  each endpoint to the correct origin: browser-facing (issuer / authorization /
  end-session) → the public HTTPS issuer; server-to-server (token / JWKS /
  userinfo) → the internal Service. Completes the in-cluster sign-in round-trip.

## [0.1.3] - 2026-08-09

### Fixed

- **In-cluster login** ("Sign-in is temporarily unavailable"). Server-side OIDC
  discovery was calling Keycloak at the public `KEYCLOAK_URL`, which isn't
  routable from inside the cluster (split-horizon DNS behind the gateway). Added
  an optional **`KEYCLOAK_INTERNAL_URL`** backchannel — discovery / token / JWKS
  use the in-cluster Keycloak Service, while the token issuer + browser redirects
  stay the public URL. Wired into `.env.example`, the configmap, and the platform
  deployment.
- **Dark mode.** Components using raw light-only colors (the non-inverted `gray`
  ramp + colored accent soft-tints) stayed light-on-dark. Swept `apps/console`,
  `shell-ui`, and the `platform` module: neutral colors → semantic surface/
  content/edge tokens, accent tints → added `dark:` variants — preserving light
  mode and leaving intentionally-dark surfaces (terminals, log/YAML/Monaco
  viewers, the login brand panel) unchanged.

## [0.1.2] - 2026-08-09

### Fixed

- **Console pod stuck `0/1` (readiness).** `/readyz` returned `503` whenever the
  server-side Keycloak OIDC discovery call didn't succeed at probe time, which
  kept the pod out of its Service (no endpoints → the gateway couldn't route, so
  the URL never loaded). Discovery is now a **reported, non-fatal, time-boxed**
  readiness signal — `/readyz` reports `keycloak: ok|unreachable` but stays
  `ready` once the process is up (discovery is still fetched lazily + cached on
  first login). Matches the handler's documented "report, don't gate" contract.

## [0.1.1] - 2026-08-08

Real backends across every module (no stubs in a running system), a
Postgres-backed document store for console-owned data, `pnpm dev` wired to a
locally-running adhar cluster, and a dedicated `adhar-console` Keycloak client.

### Changed — real backends everywhere; dev connects to the local cluster

- **No stubs in a running system.** `K8sClient.auto()` and the backing-tool
  client factory are now **real by default**; the in-memory `.stub()` fixtures
  are opt-in (`mode:'stub'`) for tests/offline only. The platform module always
  uses the per-user Kubernetes gateway (`isDevK8s` removed).
- **`pnpm dev` connects to a locally-running adhar cluster.** Dev now starts the
  BFF (Deno `server.ts`, `:5099`) alongside Vite; the host proxies `/api/*` to
  it, so login (real Keycloak), the k8s gateway, tool proxies, and Postgres all
  hit the real local cluster. `.env.example` retargeted at `*.adhar.localtest.me`;
  the Keycloak `adhar-console` client now also allows the `localhost:5100` dev
  redirect.

### Added — Postgres-backed document store (console-owned data)

- New tenant-scoped **document store**: `documents` table (`(tenant, kind, id) →
  jsonb`), Drizzle CRUD, idempotent bootstrap DDL, an auth-gated
  `/api/store/<kind>[/<id>]` API, and a `docStore` browser client
  (`@adhar-console/shell-ui`). Backs OKRs, saved views, custom roles, webhooks,
  design docs, and API specs with **real, multi-user persistence** (no
  localStorage/in-memory fallback — a missing DB returns `503`).

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
