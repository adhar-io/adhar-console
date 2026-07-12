# Tenancy

Three nested concepts:

```
 Tenant  (a.k.a. Organization)
   └─ Project
        └─ Environment
```

Every piece of state the console renders is scoped to an **active tenant**,
which the user picks via the Tenant switcher in the sidebar.

## Tenant

- Unit of isolation. Resources (namespaces, registries, git orgs) are
  prefixed by the tenant's `namespacePrefix`.
- Mapped to one or more Keycloak groups.
- Visible in `useTenant()` everywhere in the UI.

Shape (see `@adhar-console/tenancy`):

```ts
interface Tenant {
  id: string
  name: string
  namespacePrefix: string
  giteaOrg: string
  argoProject: string
  harborProject: string
  planeWorkspace: string
}
```

A "tenant" (framework-level term) is the same thing the Workspace module
surfaces as an "organization" (user-level term). Tenancy is the technical
scoping primitive; Organization is the product noun.

## Project

- Groups a primary Gitea repo, a set of environments, and one or more teams.
- Unit of shipping: a deployable thing lives inside one project.
- Users belong to tenants; teams own projects; teams are assigned to projects.

Defined in `@adhar-console/api-clients/workspace`.

## Environment

- A deploy target tied to a cluster + namespace.
- Has a `kind` (`dev`, `staging`, `preview`, `prod`) and optional promotion
  config (`promoteFromEnvId`).
- Protection rules (approvals, allowed windows) live on the env.

## Scoping rules (BFF)

Every server function follows:

```ts
const session = await requireSession()
const tenant = resolveTenant(session)
const repos = await clients.gitea.listRepos(tenant.giteaOrg)
```

- Tenant resolves from the session cookie, **never** from request input.
- Project / env come from the request body but are validated against the
  active tenant's membership before being used.

## Namespace convention

Kubernetes namespaces are derived: `<tenantPrefix>-<projectSlug>-<envName>`
for workload namespaces, or `<tenantPrefix>-<projectSlug>` for prod-only
setups. Kyverno enforces the `adhar.io/tenant=<id>` label on every namespace,
and the Platform view uses that label to filter when a non-admin user is
browsing.

## Cross-tenant access

- `platform-admin` role bypasses tenant filters — used by support and by the
  `/status` page.
- Everyone else sees only the tenants present in their Keycloak claims.

## Multi-org UX

- The topbar pill shows the active tenant.
- Switching tenant re-keys all TanStack Query caches — views re-fetch from
  scratch to avoid mixing data across tenants.
- The URL does **not** encode the tenant in v1; the session cookie does.
  v0.3.x will add an `/o/<orgSlug>/...` URL prefix so deep links carry
  tenant context explicitly.

## Migration model

Changing a tenant's namespace prefix is allowed but expensive — it rewrites
every label selector. The console's Workspace → Organization page treats
`slug` as read-only for this reason.
