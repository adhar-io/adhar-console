# packages/

Framework-neutral domain code shared across the host app and every
federated remote. If it needs to be consumed by more than one place, it
lives here.

| Package                                             | What it does                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| [`tsconfig/`](./tsconfig)                           | Shared tsconfig presets (`base`, `react-lib`, `react-app`, `server`) |
| [`eslint-config/`](./eslint-config)                 | Shared ESLint flat config                                         |
| [`utils/`](./utils)                                 | `cn`, time helpers, `invariant`, `env`, `Result`                  |
| [`auth/`](./auth)                                   | Keycloak OIDC client + server + session types                     |
| [`tenancy/`](./tenancy)                             | Tenant context, namespace derivation, scoping helpers             |
| [`shell-ui/`](./shell-ui)                           | AppShell, Sidebar, Topbar, DataTable, StatusBadge, EmptyState, …  |
| [`mf-utils/`](./mf-utils)                           | `RemoteModule` loader + registry of remote entries                |
| [`platform-info/`](./platform-info)                 | Platform version, backing-tool registry, changelog, roadmap       |
| [`api-clients/`](./api-clients)                     | Typed clients for every backing tool (subpath exports)            |

## Conventions

- Public API is always `./src/index.ts`; sub-path exports are declared in
  both `package.json` and `deno.json` when a package is multi-entry (e.g.
  `api-clients`, `auth`).
- No package depends on TanStack Start or Vinxi directly — those live in
  `apps/console`.
- Every client method that crosses a process boundary returns zod-validated
  data; no `any` leaks.
- Stub implementations live next to the real ones so the UI can run without
  any backing service.

## Adding a new package

1. `mkdir packages/<name>/src` and add `package.json`, `deno.json`, `src/index.ts`.
2. Add the path to `deno.json` workspace + imports map at the repo root.
3. Depend on it from another package via the `@adhar-console/<name>`
   specifier — no further wiring needed.
