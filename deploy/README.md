# deploy/

Container image + Kubernetes manifests for running the console on the Adhar
platform.

## Files

| File                                      | Role                                                 |
| ----------------------------------------- | ---------------------------------------------------- |
| [`Dockerfile`](./Dockerfile)              | Multi-stage Deno build → distroless runtime image    |
| [`k8s/namespace.yaml`](./k8s/namespace.yaml) | Creates `adhar-console` namespace                  |
| [`k8s/serviceaccount.yaml`](./k8s/serviceaccount.yaml) | Pod SA                                    |
| [`k8s/rbac.yaml`](./k8s/rbac.yaml)        | `ClusterRole` (read-mostly over the Adhar stack) + binding |
| [`k8s/configmap.yaml`](./k8s/configmap.yaml) | Non-secret env (tool URLs, feature flags)         |
| [`k8s/secret.example.yaml`](./k8s/secret.example.yaml) | Template for Keycloak / service tokens   |
| [`k8s/deployment.yaml`](./k8s/deployment.yaml) | 2 replicas, read-only rootfs, probes            |
| [`k8s/service.yaml`](./k8s/service.yaml)  | ClusterIP                                            |
| [`k8s/ingress.yaml`](./k8s/ingress.yaml)  | TLS + host routing (default `console.adhar.local`)   |
| [`k8s/database-claim.yaml`](./k8s/database-claim.yaml) | Crossplane `Database` claim (preferred DB) |
| [`k8s/postgres.statefulset.yaml`](./k8s/postgres.statefulset.yaml) | Self-contained Postgres (fallback) |
| [`compose/docker-compose.yml`](./compose/docker-compose.yml) | Local console + Postgres for dev/demo |
| [`k8s/kustomization.yaml`](./k8s/kustomization.yaml) | Base kustomize, image tag pin             |

## Build + push + apply

```bash
# Run from the adhar-console root. adhar-ui is passed via BuildKit's
# additional-context feature — no need to stage it into the build dir.
TAG=$(git rev-parse --short HEAD)

docker build \
  --build-context adhar-ui=../../Adhar/AdharWS/adhar-ui \
  -f deploy/Dockerfile \
  -t harbor.adhar.local/adhar/console:$TAG \
  .

docker push harbor.adhar.local/adhar/console:$TAG

# Update the image tag in deploy/k8s/kustomization.yaml, then:
kubectl apply -k deploy/k8s
```

Under the hood the Dockerfile runs `deno task build` (→ `scripts/build.ts`),
which builds every remote in parallel, builds the host, and copies each
remote's `dist/` into `apps/console/.output/public/mf/<name>/` so one
container serves host + every remote from a single origin.

In practice you won't run `kubectl apply` by hand — ArgoCD watches the
GitOps repo where these manifests are referenced, and Kargo promotes the
image tag between stages.

## Overlays

Create `deploy/k8s/overlays/<env>/` with patches for replicas, the image
tag, ingress host, and env-specific ConfigMap / Secret values. Example
layout (not yet in repo):

```
deploy/k8s/
├── base/ (these files)
└── overlays/
    ├── dev/
    ├── staging/
    └── prod/
```

## SSO / Keycloak setup

The console is a **confidential OIDC client** — it does the code exchange
server-side and stores the session in a signed HttpOnly cookie. To enable real
SSO:

1. In Keycloak, create a client in the `adhar` realm:
   - Client ID `adhar-console`, **Client authentication ON** (confidential),
     Standard flow ON.
   - Valid redirect URI: `https://console.adhar.local/api/auth/callback`
   - Valid post-logout redirect URI: `https://console.adhar.local/login`
   - (Optional) a `tenants` protocol mapper → token claim `tenants`, and realm
     roles `platform-admin` / `tenant-admin` / `developer` / `viewer`.
2. Copy the client secret into the `AUTH_CLIENT_SECRET` Secret key.
3. Generate `AUTH_COOKIE_SECRET` (`openssl rand -base64 48`) — same value on
   every replica.
4. Set `AUTH_PUBLIC_URL` / `KEYCLOAK_URL` in the ConfigMap to match your hosts.

Endpoints exposed by the container:

| Path                  | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| `/api/auth/login`     | Start OIDC login (302 → Keycloak)                  |
| `/api/auth/callback`  | Code exchange → set session cookie                 |
| `/api/auth/logout`    | Clear cookie + Keycloak end-session                |
| `/api/auth/session`   | Current session JSON (cookie-auth)                 |
| `/api/svc/<tool>/…`   | Authenticated BFF proxy to a backing tool          |
| `/api/config`         | Non-secret runtime config for the browser          |
| `/healthz` `/readyz`  | Liveness / readiness probes                        |

If `AUTH_CLIENT_SECRET` / `AUTH_COOKIE_SECRET` / `KEYCLOAK_URL` are absent, the
container still boots but auth runs in "stub" mode (handy for a quick smoke
test); `/readyz` reports `auth: stub`.

## Database (Postgres + Drizzle)

Live infrastructure state comes from the Kubernetes API and backing tools. The
console keeps its **own** state — user preferences, notification read/dismiss
state, the user directory — in Postgres via Drizzle (`packages/db`). The app
self-bootstraps an empty database with idempotent DDL on first query, so no
migration Job is required.

Provisioning options (pick one):

1. **Crossplane `Database` claim** (preferred) — `kubectl apply -f
   k8s/database-claim.yaml`. Map the composition's connection Secret into the
   console's `DATABASE_URL` (see the note at the bottom of that file).
2. **Self-contained StatefulSet** (fallback) — `kubectl apply -f
   k8s/postgres.statefulset.yaml`, then set `DATABASE_URL` in the console
   Secret to `postgres://adhar:<pw>@adhar-console-db:5432/adhar_console`.
3. **External managed Postgres** — just set `DATABASE_URL`.

If `DATABASE_URL` is unset the console still runs; persistence is disabled and
`/readyz` reports `db: unconfigured`. For ordered schema changes, generate
versioned migrations with drizzle-kit (`cd packages/db && deno task generate`).

Local dev/demo: `docker compose -f deploy/compose/docker-compose.yml up` brings
up Postgres + the console image together.

## Production notes

- Swap `image:` to your Harbor registry path.
- Replace `secret.example.yaml` with externally-managed secrets (External
  Secrets Operator or SOPS — don't commit plaintext).
- Tighten the `ClusterRole` once per-user impersonation ships (roadmap).
- Add a `NetworkPolicy` scoping egress to the backing-tool namespaces only.

See [../docs/architecture/deploy.md](../docs/architecture/deploy.md) for the
full picture.
