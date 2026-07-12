# @adhar-console/api-clients

Typed clients for every backing tool. One package, many subpath exports:

| Import                                           | Tool                                                |
| ------------------------------------------------ | --------------------------------------------------- |
| `@adhar-console/api-clients/gitea`               | Gitea (repos, PRs)                                  |
| `@adhar-console/api-clients/plane`               | Plane.so (projects, issues)                         |
| `@adhar-console/api-clients/argocd`              | Argo CD (Applications)                              |
| `@adhar-console/api-clients/kargo`               | Kargo (Stages, Freight, promotions)                 |
| `@adhar-console/api-clients/harbor`              | Harbor (repositories, artifacts, vulnerabilities)   |
| `@adhar-console/api-clients/k8s`                 | Kubernetes (clusters, workloads, CRD generic list)  |
| `@adhar-console/api-clients/kyverno`             | Kyverno (PolicyReports)                             |
| `@adhar-console/api-clients/crossplane`          | Crossplane (Compositions, Providers, Claims)        |
| `@adhar-console/api-clients/argo-workflows`      | Argo Workflows (Workflows)                          |
| `@adhar-console/api-clients/argo-rollouts`       | Argo Rollouts (Rollouts + promote/abort)            |
| `@adhar-console/api-clients/lgtm`                | Grafana / Loki / Mimir / Tempo                      |
| `@adhar-console/api-clients/workspace`           | Adhar's own SaaS API (orgs, projects, envs, tokens, audit, plan, usage, webhooks) |

## Shape

Every client exports:

```ts
export const FooClient = {
  create(opts: { baseUrl: string; token?: string }): FooClient
  stub(): FooClient
}
```

- `.create(opts)` returns a real client that wraps `HttpClient` from
  `api-clients/base`. All responses are `zod`-validated.
- `.stub()` returns an in-memory implementation with realistic fixtures —
  the UI runs with no real backing service.

Types for every resource are zod schemas exported from each subpath.

## Adding a new tool

1. `mkdir src/<tool>/` and add `index.ts` with types + client + stub.
2. Add the subpath to `package.json` `exports`, `deno.json` `exports`, and
   root `deno.json` `imports`.
3. Re-export the namespace from `src/index.ts`.
4. Wire it into `apps/console/app/server/bff.ts` so views can call it
   through the BFF.

See the [BFF doc](../../docs/architecture/bff.md) for downstream patterns.
