# apps/

Runnable, user-facing applications. Only one today:

- [`console/`](./console) — the TanStack Start host. Owns routing, SSR, the
  BFF (via `createServerFn`), Module Federation host config, Tailwind CSS,
  Keycloak session, tenant context, and the top-level layout chrome.

## When to add a new app

Rarely. Adhar's design keeps everything the user sees inside `console` and
delegates feature surfaces to [`modules/`](../modules). Adding a new app
is appropriate for:

- A marketing site or docs site that should be deployed separately.
- A CLI or API-only service that happens to live in the monorepo.
- A headless worker (e.g. a webhook receiver for Gitea events) that isn't
  part of the console UX.

Anything that should feel like "another page in the console" is a new module
in `modules/`, not a new app.

## Local dev

```bash
pnpm run console:dev    # just the host
turbo run dev           # host + every module in parallel
```

## Build

```bash
turbo run build         # builds every workspace
cd apps/console && deno task build   # or just this app
```

See [../docs/getting-started.md](../docs/getting-started.md) for first-run
details and [../docs/architecture/deploy.md](../docs/architecture/deploy.md)
for production.
