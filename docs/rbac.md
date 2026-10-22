# Authorization (RBAC)

The console has one authorization model: **Kubernetes RBAC, evaluated for the
signed-in user**. There is no second policy engine in the console — what a
person may do in the UI is exactly what the cluster's RBAC says they may do.

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
| `billingView` | `get billing` | every `GET /api/billing/*` |
| `billingManage` | `update billing` | every write under `/api/billing/*` |
| `membersInvite` | `create workspace-members` | `POST /api/workspace/invitations` |
| `membersUpdate` | `update workspace-members` | `PATCH /api/workspace/members/:id` |
| `membersRemove` | `delete workspace-members` | `DELETE /api/workspace/members/:id`, `DELETE /api/workspace/invitations/:id` |
| `rolesCreate` / `rolesUpdate` / `rolesDelete` | `create`/`update`/`delete workspace-roles` | `POST`/`PUT`/`DELETE /api/store/workspace.role` |
| `teamsCreate` / `teamsUpdate` / `teamsDelete` | `create`/`update`/`delete workspace-teams` | `/api/workspace/teams` (update covers team membership) |
| `projectsCreate` / `projectsUpdate` / `projectsDelete` | `create`/`update`/`delete workspace-projects` | `/api/workspace/projects` |
| `tokensCreate` / `tokensRevoke` | `create`/`delete workspace-tokens` | `/api/workspace/tokens` |
| `approvalsDecide` | `approve workspace-approvals` | `POST /api/workspace/approvals/:id/{approve,reject}` |
| `orgCreate` | `create organizations` | `POST /api/organizations` |
| `orgUpdate` | `update organizations` | `PUT /api/workspace/org`, `POST /api/workspace/org/transfer` (+ caller must be owner), `PATCH /api/organizations/:id` |
| `orgDelete` | `delete organizations` | `DELETE /api/workspace/org`, `DELETE /api/organizations/:id` |
| `auditView` | `get audit` | `GET /api/workspace/audit[/facets]` |
| `scorecardsRun` | `update scorecards` | `POST /api/scorecards/rerun`, `POST /api/scorecards/fix` (ownership still applies) |
| `resilienceRun` | `create resilience-runs` (in the app's namespace) | `POST /api/resilience/runs` |
| `waiverRequest` | `create scan-waivers` (in the project namespace) | waiver request / extend (+ project membership) |
| `waiverApprove` | `approve scan-waivers` | approve / reject / revoke, `POST /api/security/gate`, `/waivers/sync` |
| `waiverSelfApprove` | `self-approve scan-waivers` | approving your own request |
| `scanPolicyEdit` | `update scan-policies` | `PUT /api/security/policy` |
| `notificationsBroadcast` | `create notifications-broadcast` | `POST /api/notifications` with `broadcast: true` |
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
`console-rbac.yaml`, and add a row above.

## Default grants (platform)

Shipped in the platform repo at
`platform/stack/packages/core/adhar-console/manifests/console-rbac.yaml`:

| Subject | Gets |
| --- | --- |
| `oidc:platform-admin`, `oidc:platform-engineer` | everything (they hold `cluster-admin`, whose `*` covers `console.adhar.io`) |
| `oidc:super-admin` | everything (`adhar-console-admin`) |
| `system:authenticated` (every signed-in user) | `adhar-console-member`: `get billing, audit`; `update scorecards`; `create scan-waivers`; `create, update ai-knowledge`; `create applications, organizations` — what every member could do before these checks existed |
| `oidc:ws-role-owner`, `oidc:ws-role-admin` | workspace administration, `update organizations`, billing, broadcasts (`adhar-console-workspace-admin`) |
| `oidc:ws-role-owner` | `delete organizations` |
| `oidc:ws-role-billing` | `get, update billing` |
| `oidc:application-admin` | `create resilience-runs`, `delete applications` |
| `admin` (aggregated; bound per team namespace) | `create resilience-runs` in that namespace |
| `oidc:security-reviewer`, `oidc:security-admin` | `approve scan-waivers` |
| `oidc:security-admin` | `update scan-policies` |

The console mirrors organisation roles into the Keycloak groups
`ws-role-<role>` (`workspace/keycloak-admin.ts`), which is how the
owner/admin/billing roles of Workspace settings keep their meaning.

### Example ClusterRoles

A FinOps group that may manage billing and nothing else:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: console-finops
rules:
  - apiGroups: [console.adhar.io]
    resources: [billing]
    verbs: [get, update]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: console-finops
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: console-finops }
subjects:
  - { apiGroup: rbac.authorization.k8s.io, kind: Group, name: "oidc:finops" }
```

Let one team run resilience suites only in its namespace:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: shop-resilience
  namespace: shop
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: adhar-console-namespace-admin }
subjects:
  - { apiGroup: rbac.authorization.k8s.io, kind: Group, name: "oidc:ws-team-shop" }
```

Stop self-service organisation creation: remove `organizations` from the
`create` rule of `adhar-console-member`.

Check what someone can do:

```bash
kubectl auth can-i update packages.console.adhar.io --as oidc:ana --as-group oidc:platform-developer
kubectl auth can-i create resilience-runs.console.adhar.io -n shop --as oidc:ana --as-group oidc:ws-team-shop
```

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
if (denied) return denied // 403 naming the missing rule, or 503 if the cluster could not be asked

const ok = (await authorize(req, CONSOLE_PERMISSIONS.packagesToggle)).allowed
const me = await permissionsFor(req, { canApprove: CONSOLE_PERMISSIONS.waiverApprove })
```

Never gate a console endpoint on Keycloak role names in code — grant the
virtual resource in RBAC instead.
