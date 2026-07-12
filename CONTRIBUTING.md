# Contributing

Thanks for your interest in Adhar Console.

## Local setup

```bash
# Prereqs: Deno >= 2.0, pnpm >= 10, Node >= 20
# adhar-ui must be cloned as a sibling repo (or set ADHAR_UI_PATH).

pnpm install
turbo run dev      # or: pnpm run console:dev for just the host
```

See [docs/getting-started.md](./docs/getting-started.md) for more.

## Code layout rules

- The **host app** (`apps/console`) owns: routing, SSR, Keycloak/session,
  BFF server functions, MF host config, topbar/sidebar.
- A **module** (`modules/<phase>`) is a federated remote. It should never import
  `@tanstack/react-router` for route definitions — it receives context from
  the host and focuses on rendering its own view surface.
- **`packages/`** hold framework-neutral primitives that both host and modules
  consume. Anything reused twice belongs here.
- **`packages/api-clients`** is the only place that calls backing OSS tools.
  Every client exposes `.create({ baseUrl, token })` + `.stub()`.

## Conventions

- Files use `.ts` / `.tsx` extensions on every import (Deno).
- Dates in memory/files/comments are absolute ISO — never relative ("last week").
- Every client method returns typed data validated by `zod` at the boundary.
- `StatusBadge`, `DataTable`, `EmptyState`, `PageHeader`, and `ErrorBoundary`
  from `@adhar-console/shell-ui` cover 90% of list/detail views. Reach for them
  before introducing a bespoke component.
- UI labels lead with the noun, not the action. "Repositories" > "View
  repositories". Actions are buttons.

## Adding a phase sub-view

Inside a module (e.g. `modules/deliver`):

1. Add a view file under `src/views/`.
2. Render it from `src/home.tsx`'s tab switcher, or expose it as its own
   federated entry in `vite.config.ts` if the host needs deep-linking.
3. Source data through `packages/api-clients` — never a raw `fetch` inside a
   view.

## Adding a BFF endpoint

Endpoints live in `apps/console/app/server/bff.ts`:

```ts
export const listThings = createServerFn({ method: 'GET' })
  .validator(z.object({ project: z.string() }))
  .handler(({ data }) => clients.someTool.listThings(data.project))
```

- All input shapes are validated via `zod`.
- Inside `.handler`, call `@adhar-console/api-clients` — don't talk to backing
  tools directly.
- Tokens: the handler resolves the user's access token from the session cookie;
  tenant scoping is applied via `@adhar-console/tenancy`.

## Before opening a PR

- `turbo run typecheck` passes.
- `turbo run lint` passes.
- `turbo run test` passes (`deno test ...`).
- Every new client method has a stub entry.
- User-facing changes updated in [`CHANGELOG.md`](./CHANGELOG.md).
- If you added an env var, it appears in `.env.example` and `deploy/k8s/configmap.yaml`.

## Security-sensitive changes

If your change touches auth, session handling, token scoping, audit logging,
or RBAC, follow the checklist in [`SECURITY.md`](./SECURITY.md) and tag the
PR with `security`.

## Commit messages

Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`). Scope
to the package or module: `feat(deliver): kargo promote action`.
