# Phase · Platform

A full-featured Kubernetes dashboard, scoped to the Adhar platform's own CRDs.

- **Primary backer:** Kubernetes API (in-cluster) + Adhar-stack CRDs.
- **Module:** `modules/platform` → exposes `./Home`, `./ClusterList`,
  `./WorkloadList`, `./CrdBrowser`.
- **Port in dev:** 5107.

## Tabs

| Tab             | What it covers                                             |
| --------------- | ---------------------------------------------------------- |
| Clusters        | Multi-cluster registry with health, version, node count   |
| Nodes           | (placeholder in v1)                                        |
| Workloads       | Deployments in the selected cluster/namespace              |
| Pods            | Pod list with phase, restarts, ready containers            |
| Networking      | (placeholder)                                              |
| Storage         | (placeholder)                                              |
| RBAC            | (placeholder)                                              |
| Events          | Events filtered by cluster/namespace                       |
| Custom Resources| CRD browser for ArgoCD / Kargo / Crossplane / Kyverno / …  |
| Policy          | (placeholder — will mirror Deliver's Kyverno view)         |
| Observability   | (placeholder — will embed cluster-health dashboard)        |

## CRD browser

Lives in `modules/platform/src/views/crd-browser.tsx`. It has a curated
list of Adhar-stack GVRs:

- `argoproj.io/v1alpha1/applications`
- `kargo.akuity.io/v1alpha1/stages`
- `apiextensions.crossplane.io/v1/compositions`
- `kyverno.io/v1/clusterpolicies`
- `argoproj.io/v1alpha1/workflows`
- `argoproj.io/v1alpha1/rollouts`

Extending: drop a new entry into `CRD_KINDS` with its GVR. The generic
`k8s.listGeneric(...)` handles fetching; only the row-render needs per-kind
logic when you want richer columns.

## Platform status page

Accessed via `/status`, not under `/platform`. It lists every backing OSS
tool with real version, license, source URL, and live health. The page is
driven by `@adhar-console/platform-info` — update `BACKING_TOOLS` there to
add / remove components.

## Permissions

- Read access is broad by design (SA's ClusterRole is `adhar-console-reader`).
- Destructive actions (delete pod, scale deployment, exec into pod) are
  gated by `useHasRole('platform-admin' | 'tenant-admin')`. The BFF enforces
  the check server-side as well.

## Multi-cluster

`k8sClient.listClusters()` returns the cluster registry; each cluster has
a `source` of `in-cluster` / `kubeconfig` / `crossplane-managed`. The
currently-selected cluster drives every downstream call. Switching cluster
re-keys the TanStack Query cache.

## What's deliberately not here

- Editing arbitrary resources via a raw YAML editor. That's a power-user
  feature coming in v0.3.x as a sidecar "advanced mode" requiring an
  explicit feature flag.
- Shell-into-pod. Requires websocket plumbing and very deliberate RBAC;
  targeted for v0.4.x.
