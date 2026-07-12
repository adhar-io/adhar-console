# BFF — backend for frontend

The console is one Deno process. It hosts:

1. The SSR runtime for the shell.
2. The static bundles for every federated remote.
3. A **BFF** — a thin aggregation layer that fans out to backing OSS tools.

No browser-to-OSS traffic. Every data call from a view goes to the console's
server functions first.

## Why a BFF?

- **Auth.** The browser never needs a Gitea or Kube-API token. The BFF holds
  the short-lived access token and stamps it onto downstream calls.
- **Tenant scoping.** The BFF resolves the active tenant from the session and
  applies it to every call — regardless of what the client sends.
- **Network shape.** One same-origin HTTPS call per view interaction. No
  CORS, no preflight, no per-tool CORS fiddling.
- **Type safety.** zod validates input and response. A malformed Gitea
  payload never reaches the view — it becomes a typed error.
- **Multi-tool aggregation.** Some views need 3 tools at once (e.g. the
  Deliver "release view" will eventually pull ArgoCD + Kargo + Harbor in a
  single call). The BFF is the natural place for that join.

## Implementation — TanStack Start server functions

```ts
// apps/console/app/server/bff.ts
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { gitea } from '@adhar-console/api-clients'

const clients = {
  gitea: gitea.GiteaClient.stub(), // swap to .create(...) in prod
}

export const listRepos = createServerFn({ method: 'GET' })
  .validator(z.object({ org: z.string() }))
  .handler(({ data }) => clients.gitea.listRepos(data.org))
```

Calling it from a view:

```tsx
import { useQuery } from '@tanstack/react-query'
import { listRepos } from '~/server/bff.ts'

const q = useQuery({
  queryKey: ['gitea', 'repos', org],
  queryFn: () => listRepos({ data: { org } }),
})
```

Under the hood, `createServerFn` emits both the server handler and the
client-side fetch function. Import it from either side — TanStack Start
tree-shakes the server bits from the client bundle.

## Tenancy + auth inside a handler

```ts
import { requireSession } from '@adhar-console/auth/server'

export const listRepos = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await requireSession() // reads the signed session cookie
  return clients.gitea
    .listRepos(session.activeTenant) // tenant from session, never from request
})
```

Four rules:

1. **Tenant comes from the session, not the request body.**
2. **Every handler has a `zod` validator for input.**
3. **Every client call uses a tenant-scoped identifier** (Gitea org, ArgoCD
   project, Harbor project, etc.). Tenancy maps live in
   `@adhar-console/tenancy`.
4. **Never trust backing-tool responses as-is.** Schemas in
   `api-clients/<tool>/types.ts` validate what comes back.

## Error shape

`api-clients/base` defines a single `HttpError` with `{ status, statusText,
body, url }`. The BFF lets it propagate — TanStack Start serializes it to
the client where the view's `Suspense`/error boundary handles rendering.

For user-friendly messages, views read `error.status`:

- `401` → redirect to `/login`
- `403` → show "You don't have access to this" empty state
- `404` → generic not-found empty state
- `5xx` → `ErrorBoundary` falls through to its default fallback + retry

## Performance

- Server functions don't add a network hop when called during SSR — they're
  invoked in-process on the loader phase.
- TanStack Query caches responses in-memory on the client. Staleness is
  short (30s default) since most of the data is operational state.
- For long streams (pod logs, event tails), the BFF will graduate to
  server-sent events (`Response` with streaming body); that's on the 0.3.x
  roadmap.

## Extension points

| Need                                      | Where to change                               |
| ----------------------------------------- | --------------------------------------------- |
| Add a new endpoint                        | `apps/console/app/server/bff.ts`              |
| Add a new backing tool                    | `packages/api-clients/src/<tool>/`            |
| Route-tenant mapping change               | `@adhar-console/tenancy`                      |
| Common retry / timeout policy             | `@adhar-console/api-clients/base/http.ts`     |
| Turn on tracing for backing calls         | Wrap `HttpClient` (open an issue; planned)    |
