# Auth

Single source of truth for identity is **Keycloak**. The console is an OIDC
relying party; every backing tool is a separate client in the same realm.

## Flow (production)

```
          ┌────────┐     1. GET /deliver
browser ─▶│ host   │────────────────────────┐
          └────────┘                        │
                                            ▼
                             ┌─────────────────────────────┐
                             │ Session cookie present?     │
                             └──────────────┬──────────────┘
                                  no        │        yes
                                  ▼         │
                   302 /auth/login          └─▶ render page
                    ?redirect=/deliver
                                  │
                                  ▼
          ┌────────┐     2. OIDC authz
          │Keycloak│◀──────────────────────
          └────────┘
             │  3. code
             ▼
          ┌────────┐     4. code exchange (server-side)
          │ host   │──────▶ id_token + access_token + refresh_token
          │ BFF    │        sign + set session cookie (HttpOnly, SameSite=Lax)
          └────────┘
             │
             ▼
          back to /deliver with session
```

- The session cookie is HttpOnly, SameSite=Lax, Secure in prod; it contains a
  signed JWS of the session id, not the access token itself.
- Server-side we hold `{ accessToken, refreshToken, expiresAt, user, activeTenant }`
  — mapped out of the id_token's claims.
- Token refresh happens transparently in the BFF on any call that runs within
  60s of `expiresAt`.

## Code shape

Auth is split into a **client-safe** entry (`@adhar-console/auth`) and a
**server-only** entry (`@adhar-console/auth/server`) so the confidential client
secret and `jose` never reach the browser bundle.

`packages/auth/src`:

- `config.ts` — `getServerAuthConfig()` reads `KEYCLOAK_URL`,
  `AUTH_CLIENT_SECRET`, `AUTH_COOKIE_SECRET`, … from the runtime env. Returns
  `null` (→ stub mode) when the minimum isn't configured.
- `discovery.ts` — OIDC discovery doc + JWKS (`jose` remote key set), cached.
- `server.ts` — PKCE, `buildAuthorizeUrl()`, `exchangeCode()`,
  `refreshTokens()`, `verifyIdToken()` (signature + issuer + audience + nonce),
  `buildEndSessionUrl()`, `sessionFromTokens()`.
- `session-store.ts` — **stateless** signed-JWT session (HS256) encoded into
  the cookie, so any replica validates any request with no shared store.
  `toClientSession()` strips tokens for the browser.
- `cookies.ts` — `Set-Cookie` (de)serialization + HMAC sign/unsign (Web Crypto)
  for the short-lived OIDC transaction cookie.
- `handlers.ts` — framework-agnostic `handleLogin/Callback/Logout/Session` +
  `getValidSession()` (transparent refresh near expiry). Wired into TanStack
  Start server routes under `apps/console/app/routes/api/auth/*`.
- `claims.ts` — pure `claimsToUser()` (realm + client roles → `Role[]`).
- `client.ts` — React `AuthProvider` + hooks. Bootstraps from
  `/api/auth/session`; sign-in/out are full-page navigations to the server
  routes. No tokens in the browser.
- `types.ts` — `Session`, `User`, `Role`, `Claims` (zod-validated).
- `stub.ts` — fixture session for dev (`getStubSession()`).

The browser never holds an access/refresh token: it calls same-origin
`/api/svc/<tool>/…` proxy routes (cookie-authenticated) and the BFF injects the
upstream credential server-side (`apps/console/app/server/proxy.ts` +
`tool-registry.ts`).

## Roles

Currently four roles, mapped from Keycloak realm roles on login:

- `platform-admin` — full access across every tenant.
- `tenant-admin` — admin within the active tenant.
- `developer` — can read/write within projects they belong to.
- `viewer` — read-only.

Views guard with `useHasRole(...)`. BFF handlers re-check — never trust the
client.

## Backing tool access

Two modes, both supported:

### Mode A — user impersonation (preferred)

The console forwards the user's Keycloak access token to backing tools that
are OIDC clients in the same realm. Each tool validates the token and applies
its own RBAC.

- Gitea: OAuth2 proxy / Keycloak OIDC integration.
- ArgoCD / Kargo: native OIDC trust with Keycloak.
- Kube-API: `oidc-issuer-url` pointed at Keycloak; the BFF exchanges its
  service-account token for a user-scoped one via TokenRequest.

### Mode B — service tokens (v1 default for some tools)

The console holds a service-level token per tool and calls on behalf of the
user. Audit log records the user as the "actor" even though the upstream call
used the service token. Simpler but gives the console more trust than the
user; used only for tools where OIDC isn't configured yet.

Current state per tool:

| Tool          | Mode in v1             | Target mode       |
| ------------- | ---------------------- | ----------------- |
| Gitea         | Service token          | User impersonation|
| ArgoCD        | Service token          | User impersonation|
| Kargo         | Service token          | User impersonation|
| Harbor        | Service robot account  | User impersonation|
| Kube-API      | Console SA ClusterRole | User impersonation|
| Kyverno       | via Kube-API           | — (inherits)      |
| Crossplane    | via Kube-API           | — (inherits)      |
| Argo Workflows| Service token          | User impersonation|
| Argo Rollouts | via Kube-API           | — (inherits)      |
| Plane.so      | API key                | Org-scoped token  |
| LGTM (Grafana)| Embed + signed iframe  | Datasource proxy  |

## Sessions

Listed in `/profile` → Sessions. Revoking a session invalidates the server-
side session record immediately; the cookie becomes useless on next request.
Keycloak-initiated back-channel logout is on the 0.3.x roadmap.

## Personal access tokens (PATs)

- Created from `/profile` → Access tokens.
- Scoped (`projects:read`, `deployments:write`, etc.).
- Prefixed (`adhar_pat_usr_`) and shown once.
- Verified by the BFF at auth middleware time — replace the session cookie
  flow with a bearer check when the `Authorization: Bearer adhar_pat_...`
  header is present.

Org-level tokens (for CI) work identically but live under the org.

## Stubbed auth in dev

Dev runs as a pure SPA with **no server** (the Module-Federation × Vite-7 SSR
clash, see `build-config/host.ts`), so `/api/auth/*` doesn't exist there. The
`AuthProvider` detects this (it's not a production build) and the login page
offers a "Continue as demo user" button backed by
`packages/auth/src/stub.ts` — a fixture session with `platform-admin` +
`developer` on the `acme` tenant. Likewise every backing-tool client uses
`.auto({ tool })`, which returns stub fixtures in dev and the real
proxy-backed client in a production build.

Real SSO therefore runs in the **built/container image** (`deno task build`
then run `.output/server/index.mjs`, or `docker build`), pointed at a real
Keycloak. See [deploy/README.md](../../deploy/README.md#sso--keycloak-setup).

Token refresh happens server-side in `getValidSession()`. Back-channel logout
and a shared session-revocation store (Redis) remain on the roadmap; today
logout clears the cookie and drives Keycloak's end-session endpoint.
