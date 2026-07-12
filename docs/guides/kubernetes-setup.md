# Running the Platform view against a real cluster

The Platform module talks to the Kubernetes API that your local
`kubectl` context points at. Connection topology in dev:

```
browser  ──▶  Vite dev server (5100)  ──▶  kubectl proxy (8001)  ──▶  kube-apiserver
           [host]           [/kube-api]      [current kubeconfig context, auth + TLS]
```

`kubectl proxy` handles TLS, auth, and token rotation — the console just sees
an unauthenticated HTTP endpoint on localhost. For production the same
`/kube-api/*` path is served by the console's BFF after Keycloak login.

## 1. Start the proxy

Any terminal, any directory:

```bash
kubectl proxy --port=8001
```

You should see:

```
Starting to serve on 127.0.0.1:8001
```

Leave it running. It uses your current `kubectl` context — verify first:

```bash
kubectl config current-context
kubectl get nodes       # sanity check
```

## 2. Start the console

In another terminal, from the repo root:

```bash
pnpm dev
```

Open [http://localhost:5100/platform](http://localhost:5100/platform). The
tab should render with a small green "Connected · v1.xx.x" chip at the top.
If it doesn't, the module shows a banner with the exact command to run plus
the underlying error.

## 3. Override the proxy URL

If you want to run the proxy elsewhere (different host, non-default port, a
service exposed via ingress, etc.):

```bash
ADHAR_K8S_PROXY=http://127.0.0.1:9000 pnpm dev
```

The `host.ts` Vite proxy reads `ADHAR_K8S_PROXY` on startup.

## 4. Permissions

Whatever `kubectl` user your context uses needs list + get across the
resources the Platform views touch. For full coverage with no 403s:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: adhar-console-viewer
rules:
  - apiGroups: ['']
    resources: ['*']
    verbs: ['get', 'list', 'watch']
  - apiGroups: ['apps', 'batch', 'networking.k8s.io', 'storage.k8s.io', 'rbac.authorization.k8s.io']
    resources: ['*']
    verbs: ['get', 'list', 'watch']
  - apiGroups: ['apiextensions.k8s.io']
    resources: ['customresourcedefinitions']
    verbs: ['get', 'list', 'watch']
  # Optional — only if these operators are installed:
  - apiGroups: ['argoproj.io', 'kargo.akuity.io', 'kyverno.io', 'wgpolicyk8s.io']
    resources: ['*']
    verbs: ['get', 'list', 'watch']
```

Bind it to your user (or the `kubectl`-proxied SA). Read-only is intentional
— the Platform view doesn't perform destructive writes in v1.

## 5. Features by tab

| Tab              | Under the hood                                                                |
| ---------------- | ----------------------------------------------------------------------------- |
| Clusters         | `/version`, `/api`, `/apis`, `/api/v1/nodes`, `/api/v1/namespaces`            |
| Nodes            | `/api/v1/nodes` — role labels, Ready condition, allocatable capacity          |
| Workloads        | `/apis/apps/v1/deployments\|statefulsets\|daemonsets`, `/apis/batch/v1/jobs\|cronjobs` |
| Pods             | `/api/v1/pods` — click for drawer with YAML, events, streaming logs           |
| Networking       | `/api/v1/services`, `/apis/networking.k8s.io/v1/ingresses`                   |
| Storage          | PVs, PVCs, StorageClasses                                                     |
| RBAC             | SAs, Roles, RoleBindings, ClusterRoles, ClusterRoleBindings                   |
| Events           | `/api/v1/events`, sorted newest-first, 5s auto-refresh                        |
| Custom Resources | Generic GVR lister for ArgoCD, Kargo, Crossplane, Kyverno, Argo Workflows/Rollouts |
| Policy           | `wgpolicyk8s.io/v1alpha2/clusterpolicyreports` — graceful if not installed    |
| Observability    | Detects Prometheus Operator + ServiceMonitors; points at Discover for dashboards |

## 6. Auto-refresh

- Pods, Deployments, StatefulSets, DaemonSets, Nodes → poll every **10s**.
- Events → poll every **5s** (events are the most volatile signal).
- Static-ish lists (ClusterRoles, StorageClasses) → TanStack Query default (30s stale).

Polling is used instead of the Kubernetes `watch` API because `watch` over
kubectl proxy requires chunked streaming — brittle under Vite's dev server.
The `watch` path is a future upgrade when the BFF ships.

## 7. Pod logs

Click any pod row → drawer opens → **Logs** tab.

- Tail is 500 lines, timestamps on.
- Container dropdown switches between pod containers.
- Auto-refreshes every 5s.
- Streaming follow (`?follow=true`) isn't used yet — Vite dev proxy doesn't
  forward the chunked response reliably. Real streaming arrives with the BFF.

## 8. Troubleshooting

**"Cluster unreachable"**
- `kubectl proxy --port=8001` not running, or running on a different port.
- `curl http://127.0.0.1:8001/api/v1/namespaces` to check.

**"Not authorized" (401/403)**
- Your kubeconfig user doesn't have list rights on the resource the view is
  asking for. Check with `kubectl auth can-i list pods -A`.
- The banner shows which verb/resource failed.

**"CRD is not installed"**
- Shown inside Policy / CRDs when a resource kind's API group isn't registered.
  Install the operator (Kyverno, ArgoCD, etc.) and the view populates.

**WebSocket errors in the console (pod exec)**
- Pod exec isn't implemented yet. Use `kubectl exec` directly or wait for BFF.

**Slow lists**
- `/api/v1/pods` across a large cluster is heavy — scope to a namespace via
  the picker in the top-right.
