# modules/

Federated remotes — one per 6D phase plus two cross-cutting ones. Each is
a standalone Vite project that exposes components via
`@module-federation/vite`; the host app in [`apps/console`](../apps) loads
them on-demand.

| Module                                 | Port | Exposes                                           | Phase            |
| -------------------------------------- | ---- | ------------------------------------------------- | ---------------- |
| [`define/`](./define)                  | 5101 | `./Home`                                          | Define           |
| [`design/`](./design)                  | 5102 | `./Home`                                          | Design           |
| [`develop/`](./develop)                | 5103 | `./Home`, `./RepoList`, `./PullRequestList`, `./WorkflowList` | Develop |
| [`deliver/`](./deliver)                | 5104 | `./Home`, `./ArgoApps`, `./KargoStages`, `./Rollouts`, `./Registry`, `./Policy` | Deliver |
| [`discover/`](./discover)              | 5105 | `./Home`, `./Logs`, `./Metrics`, `./Traces`, `./Dashboards` | Discover |
| [`decide/`](./decide)                  | 5106 | `./Home`, `./DoraSummary`                         | Decide           |
| [`platform/`](./platform)              | 5107 | `./Home`, `./ClusterList`, `./WorkloadList`, `./CrdBrowser` | Platform (cross-cutting) |
| [`workspace/`](./workspace)            | 5108 | `./Home`, `./Organization`, `./Members`, `./Projects`, `./Tokens`, `./Audit`, `./Plan` | SaaS admin (cross-cutting) |

## Template for a new module

Every module has the same shape:

```
modules/<name>/
├── deno.json
├── package.json
├── tsconfig.json
├── vite.config.ts         # @module-federation/vite as REMOTE
└── src/
    ├── home.tsx           # default export — exposed as ./Home
    └── views/…
```

`vite.config.ts` declares `federation({ name, filename: 'remoteEntry.js',
exposes: {...}, shared: { react: { singleton: true }, ... } })` — see any
existing module for a reference.

## Guidelines

- **No router.** Modules do NOT define TanStack routes. The host decides
  the route path; the module just renders a component.
- **Stick to `@adhar-console/shell-ui`.** `DataTable`, `StatusBadge`,
  `EmptyState`, `PageHeader` cover 90% of list/detail views.
- **Data via BFF.** In v1, modules can call stub clients directly from
  `@adhar-console/api-clients`. Production will swap every call for a
  `useServerFn(...)` against the host's BFF — so keep fetch logic thin and
  colocated (a `src/data/` folder is fine).
- **Errors.** Rely on the `ErrorBoundary` inside `RemoteModule` from
  `@adhar-console/mf-utils` — throw or return errors from queries naturally.
- **Tenant context.** Read tenant from `useTenant()` (from
  `@adhar-console/tenancy`); never hard-code an org or project slug.

See [../docs/architecture/module-federation.md](../docs/architecture/module-federation.md)
for the deeper why.
