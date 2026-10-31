# Authorization (RBAC)

The console has one authorization model: **Kubernetes RBAC, evaluated for the
signed-in user**, plus — for what belongs to ONE organisation — **membership of
that organisation's Keycloak groups**. There is no policy the console keeps of
its own: what a person may do in the UI is what the cluster's RBAC and their
groups say they may do.

- **Kubernetes objects** are authorized as themselves. "May I delete this
  Deployment" is a SelfSubjectAccessReview (SSAR) for `delete deployments.apps`
  in that namespace.
- **Console actions that are not Kubernetes objects** — enabling a platform
  package, changing billing, approving a scan waiver — are **virtual resources**
  in the API group `console.adhar.io`. No CRD backs them and none is needed:
  the RBAC authorizer matches rules by string, so a ClusterRole rule for
  `billing.console.adhar.io` is honoured by an SSAR for exactly that, and
  `kubectl auth can-i update billing.console.adhar.io --as …` answers the same
  question the console asks.
- **Blocked actions are hidden, not disabled**, and stay hidden while the
  answer loads — no flash of a button the user cannot use.
- **The BFF enforces the same checks.** A hidden button is not security: every
  console endpoint behind a virtual resource asks the same SSAR (same identity,
  same cache) before acting.
- **One exception: what belongs to a single organisation.** Members, teams,
  projects, tokens, approvals, billing and organisation settings are answered
  from the organisation's Keycloak groups instead of RBAC (see
  [Organisation-scoped permissions](#organisation-scoped-permissions)) — a
  ClusterRoleBinding can only say "admin of every organisation". They are still
  asked through the same `<Can>` / `requirePermission` choke point.

## How a check is answered

```
browser  <Can check>  ──┐  (all checks of one render tick)
         useCan(...)  ──┼─► POST /api/k8s/-/access-batch?cluster=  {checks:[…]}
                        │      │  validated (≤200, strict shape)
                        │      │  per-identity LRU cache (user+groups+cluster, 30 s)
                        │      ▼
                        │   SelfSubjectAccessReview × n   (≤8 in parallel, as the user)
                        │      ▼
                        └── {results: boolean[], degraded?: true}

BFF handler  requirePermission(req, CONSOLE_PERMISSIONS.x)  ─► same cache, same SSAR
```

- **Identity.** SSARs run as the signed-in user: their OIDC token, or — on
  clusters without OIDC — the console ServiceAccount impersonating them
  (`apps/console/app/server/k8s/gateway.ts`). Groups carry the `oidc:` prefix.
- **Fail closed.** A review that cannot be made (apiserver unreachable, 5xx,
  timeout) is a "no", is never cached, and marks the batch `degraded: true`.
  The UI keeps such actions hidden and re-asks; the BFF answers
  `503 authorization_unavailable` rather than performing a write.
- **Caching.** The BFF caches definitive answers for 30 s per identity (bounded
  LRU); the browser keeps each answer in TanStack Query for 60 s under
  `['k8s','can',cluster,checkKey,identity]`. A role change therefore takes up to
  ~90 s to show; call `invalidateAccess(queryClient)` after the console itself
  changes RBAC. Switching cluster, user or tenant uses different keys — no
  answer crosses identities.

## The virtual resource catalogue

Source of truth: `packages/auth/src/console-permissions.ts`
(`CONSOLE_PERMISSIONS`, re-exported from `@adhar/shell-ui`). Modules reference
permissions **by name**, never by re-typing the strings.

| Name (`CONSOLE_PERMISSIONS.…`) | RBAC (`verb resource.console.adhar.io`) | Enforced by |
| --- | --- | --- |
| `packagesToggle` | `update packages` | `POST /api/platform/appset/toggle`; scorecard fixes to platform repos |
| `billingView` † | `get billing` | every `GET /api/billing/*` |
| `billingManage` † | `update billing` | every write under `/api/billing/*` |
| `membersInvite` † | `create workspace-members` | `POST /api/workspace/members`, `GET`/`POST /api/workspace/users`, `POST /api/workspace/users/:id/setup-email` |
| `membersUpdate` † | `update workspace-members` | `PATCH /api/workspace/members/:id` |
| `membersRemove` † | `delete workspace-members` | `DELETE /api/workspace/members/:id` |
| `rolesCreate` / `rolesUpdate` / `rolesDelete` † | `create`/`update`/`delete workspace-roles` | `POST`/`PUT`/`DELETE /api/store/workspace.role` |
| `teamsCreate` / `teamsUpdate` / `teamsDelete` † | `create`/`update`/`delete workspace-teams` | `/api/workspace/teams` (update covers team membership) |
| `projectsCreate` / `projectsUpdate` / `projectsDelete` † | `create`/`update`/`delete workspace-projects` | `/api/workspace/projects` |
| `tokensCreate` / `tokensRevoke` † | `create`/`delete workspace-tokens` | `/api/workspace/tokens` |
| `approvalsDecide` † | `approve workspace-approvals` | `POST /api/workspace/approvals/:id/{approve,reject}` |
| `orgCreate` | `create organizations` | `POST /api/organizations` |
| `orgUpdate` † | `update organizations` | `PUT /api/workspace/org`, `PATCH /api/organizations/:id` |
| `orgDelete` † | `delete organizations` | `DELETE /api/workspace/org` (`DELETE /api/organizations/:id` now LEAVES an organisation) |
| `auditView` † | `get audit` | `GET /api/workspace/audit[/facets]` |
| `scorecardsRun` | `update scorecards` | `POST /api/scorecards/rerun`, `POST /api/scorecards/fix` (ownership still applies) |
| `resilienceRun` | `create resilience-runs` (in the app's namespace) | `POST /api/resilience/runs` |
| `waiverRequest` | `create scan-waivers` (in the project namespace) | waiver request / extend (+ project membership) |
| `waiverApprove` | `approve scan-waivers` | approve / reject / revoke, `POST /api/security/gate`, `/waivers/sync` |
| `waiverSelfApprove` | `self-approve scan-waivers` | approving your own request |
| `scanPolicyEdit` | `update scan-policies` | `PUT /api/security/policy` |
| `notificationsBroadcast` † | `create notifications-broadcast` | `POST /api/notifications` with `broadcast: true` |
| `aiKnowledgeAdd` | `create ai-knowledge` | `POST /api/ai/knowledge` with a note |
| `aiKnowledgeRate` | `update ai-knowledge` | `POST /api/ai/feedback` |
| `applicationsCreate` | `create applications` | `POST /api/scaffold` |
| `applicationsDelete` | `delete applications` | `POST /api/apps/delete`; repository step of `/api/catalog/teardown` |

Checks are cluster-scoped unless a namespace is added (`consoleCheck(perm, ns)`).
A ClusterRoleBinding satisfies both; a namespaced RoleBinding satisfies only
checks asked in its namespace — which is how a team that is `admin` of its own
namespace may run resilience suites there and nowhere else.

To add a permission: add it to `CONSOLE_PERMISSIONS`, gate the handler with
`requirePermission`, wrap the UI action in `<Can>`, grant it in the platform's
`console-rbac.yaml`, and add a row above. (An organisation-scoped one goes in
`ORG_SCOPED` in `apps/console/app/server/tenancy/org-access.ts` instead of
`console-rbac.yaml`.)

## Organisation-scoped permissions

Rows marked † above belong to ONE organisation, and a ClusterRoleBinding
cannot express "admin of acme" — only "admin of every organisation". So for
those the console answers from the caller's groups in the organisation the
request is working in (`ORG_SCOPED`, `apps/console/app/server/tenancy/org-access.ts`),
and **RBAC is not consulted** for them:

| Who | Groups | Gets |
| --- | --- | --- |
| Member | `org-<slug>` | `get billing`, `get audit` — and reads everything in the organisation |
| Organisation admin | `org-<slug>-admin` (always also in `org-<slug>`) | every † permission |
| Platform admin | `platform-admin`, `platform-engineer`, `super-admin` | every † permission in EVERY organisation, without being listed |
| Platform team | `platform-developer`, `platform-viewer` | member of the platform's own organisation (`adhar`) only |

Keycloak is the only user store: those groups ARE the membership. Settings →
Members lists people from them and adds, removes, promotes and creates
accounts there (a new account gets a set-password email from Keycloak, so the
realm needs an SMTP server); the console stores no members, roles or
invitations. Teams are `ws-team-<slug>.<team>` — qualified by organisation,
so two organisations' "platform" teams are two groups. The groups are the same
ones the platform's Organisation, Project and Environment compositions bind
(`org-<slug>-admin` → `admin`, `org-<slug>` → `view`, teams per project), so the
console and Kubernetes agree on who is in what.

- **Page checks** (`<Can>`, `useCan`, `access-batch`) use the token's groups —
  no network call, and they are never cached server-side.
- **Writes that change access** (members, accounts, teams, deleting, renaming
  or leaving an organisation) re-read the caller's groups from Keycloak first,
  so a demoted admin is refused at once. Keycloak unreachable is
  `503 keycloak_unavailable`, never a success.
- **Propagation.** A group added in Keycloak shows in the organisation
  switcher immediately and reaches the session on the next request (the
  console refreshes the token when Keycloak knows more than it does); a
  removal reaches console reads and Kubernetes at the user's next token
  refresh — at most one access-token lifetime (30 minutes by default).
- **Known limit.** The `groups` claim carries the last path segment of each
  group, lower-cased, so a SUBGROUP named `org-acme-admin` would look the same
  in a token. Only Keycloak administrators can create groups, and they are
  trusted; the console's own live checks count top-level groups only.

The realm-wide `ws-role-<role>` groups the console used to mirror
organisation roles into are retired (an owner of one organisation was an
admin of all of them); the console neither reads nor writes them.

## Default grants (platform)

Shipped in the platform repo at
`platform/stack/packages/core/adhar-console/manifests/console-rbac.yaml`:

| Subject | Gets |
| --- | --- |
| `oidc:platform-admin`, `oidc:platform-engineer` | everything (they hold `cluster-admin`, whose `*` covers `console.adhar.io`) |
| `oidc:super-admin` | everything (`adhar-console-admin`) |
| `system:authenticated` (every signed-in user) | `adhar-console-member`: `update scorecards`; `create scan-waivers`; `create, update ai-knowledge`; `create applications, organizations` — what every member could do before these checks existed (its `get billing, audit` no longer matters: those are organisation-scoped) |
| `oidc:application-admin` | `create resilience-runs`, `delete applications` |
| `admin` (aggregated; bound per team namespace) | `create resilience-runs` in that namespace |
| `oidc:security-reviewer`, `oidc:security-admin` | `approve scan-waivers` |
| `oidc:security-admin` | `update scan-policies` |

Workspace administration, organisation settings and billing are not granted
here: they are organisation-scoped (above), so an RBAC grant of them — the old
`oidc:ws-role-owner` / `oidc:ws-role-admin` / `oidc:ws-role-billing` bindings
included — is ignored. Someone who should manage one organisation's billing is
made an admin of that organisation.

### Example ClusterRoles

An SRE group that may run resilience suites anywhere and decide scan waivers:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: console-sre
rules:
  - apiGroups: [console.adhar.io]
    resources: [resilience-runs]
    verbs: [create]
  - apiGroups: [console.adhar.io]
    resources: [scan-waivers]
    verbs: [approve]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: console-sre
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: console-sre }
subjects:
  - { apiGroup: rbac.authorization.k8s.io, kind: Group, name: "oidc:sre" }
```

Let one team (`shop` of organisation `acme`) run resilience suites only in its
namespace:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: shop-resilience
  namespace: shop
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: adhar-console-namespace-admin }
subjects:
  - { apiGroup: rbac.authorization.k8s.io, kind: Group, name: "oidc:ws-team-acme.shop" }
```

Stop self-service organisation creation: remove `organizations` from the
`create` rule of `adhar-console-member`.

Check what someone can do:

```bash
kubectl auth can-i update packages.console.adhar.io --as oidc:ana --as-group oidc:platform-developer
kubectl auth can-i create resilience-runs.console.adhar.io -n shop --as oidc:ana --as-group oidc:ws-team-acme.shop
```

`kubectl auth can-i` does not answer the organisation-scoped (†) permissions —
they are not RBAC. Who administers an organisation is the membership of its
`org-<slug>-admin` group (Settings → Members, or Keycloak's admin console).

## Using it in the UI

**Rule: every mutating UI action is wrapped in `<Can>` (or gated on `useCan`)
with the check that matches the BFF/API it calls.** If the button calls the
Kubernetes gateway, the check is that Kubernetes verb on that resource; if it
calls a console endpoint, it is that endpoint's `CONSOLE_PERMISSIONS` entry
(table above).

```tsx
import { Button, Can, canResource, CONSOLE_PERMISSIONS, consoleCheck, useCan } from '@adhar/shell-ui'

// A console action
<Can check={CONSOLE_PERMISSIONS.packagesToggle}>
  <Button variant="primary" onClick={toggle}>Enable</Button>
</Can>

// A Kubernetes action — the exact verb/resource the request will hit
<Can check={canResource(DEPLOYMENTS, 'delete', { namespace, name })}>
  <Button variant="danger" onClick={remove}>Delete</Button>
</Can>

// Several checks: ALL must be allowed
<Can check={[canResource(SECRETS, 'get', { namespace }), canResource(SECRETS, 'update', { namespace })]}>…</Can>

// Namespaced console permission, as a boolean
const canRun = useCan(consoleCheck(CONSOLE_PERMISSIONS.resilienceRun, app.namespace))
```

- `useCan(check | check[], { cluster?, enabled? }): boolean` — `true` only when
  every check is allowed; `false` while loading.
- `<Can check cluster? fallback?={null}>` — renders `children` only when
  allowed; `fallback` (default nothing) otherwise and while loading.
- `useAccessReview(check | check[], opts)` → `{ allowed, loading, results,
  unknown }` when a view must tell "loading" or "couldn't check" from "no".
- `canResource(gvr, verb, { namespace?, name?, subresource? })` builds a check
  from the GVRs the api-clients already use.
- `invalidateAccess(queryClient)` after the console changes RBAC itself.
- The cluster defaults to the topbar's active cluster.

All checks requested in one render tick, from the host and every federated
remote, go out as one `access-batch` request per cluster (deduped).

`useCan('<persona capability>')` with a string still answers from the older
Keycloak-role persona model, for call sites not yet moved to RBAC checks.
New code passes checks.

## Using it in the BFF

```ts
import { CONSOLE_PERMISSIONS } from '@adhar/auth/server'
import { authorize, permissionsFor, requirePermission } from './k8s/access.ts'

const denied = await requirePermission(req, CONSOLE_PERMISSIONS.billingManage)
// 403 naming the missing rule (or, organisation-scoped, `requires_org_admin` /
// `not_a_member`; 409 `no_organisation` for someone in none), or 503 when it
// could not be checked
if (denied) return denied

const ok = (await authorize(req, CONSOLE_PERMISSIONS.packagesToggle)).allowed
const me = await permissionsFor(req, { canApprove: CONSOLE_PERMISSIONS.waiverApprove })
```

Never gate a console endpoint on Keycloak role names in code — grant the
virtual resource in RBAC instead.
