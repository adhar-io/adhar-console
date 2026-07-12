# Phase · Deliver

GitOps delivery, multi-stage promotion, progressive rollouts, artifact
registry, admission policy.

- **Primary backers:** Argo CD, Kargo, Argo Rollouts, Harbor, Kyverno.
- **Module:** `modules/deliver` → exposes `./Home`, `./ArgoApps`,
  `./KargoStages`, `./Rollouts`, `./Registry`, `./Policy`.
- **Port in dev:** 5104.

## Views

### ArgoCD Apps

Lists every Application for the active tenant, with sync + health badges.
The BFF calls `argocd.listApplications(tenant.argoProject)`. Sync actions
stream back through the same BFF endpoint with an optimistic update.

### Kargo Stages

Shows each stage (dev → staging → prod) as a card, with:

- current Freight id,
- last promotion time,
- phase (Steady / Promoting / Verifying / Failed / …),
- Promote and View-history buttons.

Below: the Freight catalog — every image bundle available for promotion.

### Rollouts

Active Argo Rollouts across the tenant's namespaces, showing strategy
(canary / blue-green), current step, replica count, and promote/abort
buttons.

### Registry (Harbor)

Master-detail: left pane lists repositories, right pane shows artifacts
for the selected repo. Each artifact shows size, tags, push time, and a
vulnerability summary (critical / high / medium).

### Policy (Kyverno)

Aggregates cluster-wide PolicyReports into pass/fail/warn/error/skip
counters and a findings table. Each finding deep-links into the Platform
phase for the failing resource.

## Scoping

- `argocd.listApplications` filters to `tenant.argoProject`.
- Kargo calls use `tenant.id` as the project identifier.
- Harbor uses `tenant.harborProject`.
- Kyverno is cluster-scoped — non-admin users see reports scoped to
  namespaces labeled `adhar.io/tenant=<id>`.

## What's intentionally not here

- Raw `kubectl apply`. That's the Platform phase, guarded behind a
  feature flag for admins.
- Manual Git force-pushes to the GitOps repo. Kargo owns promotion; the
  console exposes promote/abort buttons only.
