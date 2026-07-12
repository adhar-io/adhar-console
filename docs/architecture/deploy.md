# Deploy

One container image, many replicas, on the Adhar Kubernetes cluster.

## Image

Built from `deploy/Dockerfile`. Multi-stage:

1. **Builder** (`denoland/deno:2.1.4`) — installs pnpm, runs `pnpm install`,
   runs `turbo run build`. `turbo` fans out the build across packages,
   modules, and apps; each module emits to `modules/<m>/dist/mf/` and the
   host emits to `apps/console/.output/` (TanStack Start / Nitro server
   bundle + public dir).
   After build, each remote's `dist/mf/` is copied under
   `apps/console/.output/public/mf/<m>/` so the runtime image serves
   everything from one origin.
2. **Runtime** (`denoland/deno:2.1.4-distroless`) — copies `.output`, runs
   as `nonroot`, with `--allow-net --allow-read --allow-env`.

Build context assumes `adhar-ui` is staged at `/build/adhar-ui` (a sibling
repo). In CI, both repos are checked out side-by-side and the Docker build
is kicked off from the parent directory.

```bash
cd ..
docker build \
  -t harbor.adhar.local/adhar/console:$TAG \
  -f adhar-console/deploy/Dockerfile \
  adhar-console
```

## Manifests

Under `deploy/k8s/`, applied via `kubectl apply -k`:

| Manifest                | What it does                                                                  |
| ----------------------- | ----------------------------------------------------------------------------- |
| `namespace.yaml`        | Creates `adhar-console` namespace                                             |
| `serviceaccount.yaml`   | The SA the pod runs as                                                        |
| `rbac.yaml`             | `ClusterRole` granting read on the Adhar stack + `patch` on `Deployments/scale` |
| `configmap.yaml`        | Non-secret env: URLs, feature flags                                           |
| `secret.example.yaml`   | Template for Keycloak client secret + service tokens                          |
| `deployment.yaml`       | 2 replicas, read-only rootfs, `runAsNonRoot`, liveness/readiness probes       |
| `service.yaml`          | ClusterIP on port 80 → container 3000                                         |
| `ingress.yaml`          | TLS + host-based routing (default: `console.adhar.local`)                     |
| `kustomization.yaml`    | Base kustomize entry + image tag pin                                          |

## Config sources

Three layers, increasing specificity:

1. **Baked-in defaults** in code (stub URLs, fallbacks).
2. **ConfigMap** — per-environment non-secret URLs. Mounted via `envFrom`.
3. **Secret** — Keycloak client secret, backing-tool robot tokens. Mounted
   via `envFrom` (optional — console starts fine without, using user
   impersonation).

Recommended production setup:

- External Secrets Operator syncing from Vault or AWS Secrets Manager.
- Alternatively, SOPS-encrypted `secret.yaml` committed to the GitOps repo.

## Observability of the console itself

- Pod emits OpenTelemetry traces (via the OTel collector sidecar's
  `Service` at the cluster level; no code changes needed — Deno's fetch gets
  auto-instrumented by Beyla eBPF).
- Logs to stdout → Loki.
- Prometheus scrapes `/metrics` (Nitro's default endpoint).

The console sees its own metrics in the Discover phase and on
`/status`. Releases are announced to `/changelog` automatically by the
release workflow (when wired).

## Release cycle

1. Tag a commit on `main` (e.g. `v0.2.3`).
2. CI builds the image, pushes to Harbor, and updates the image tag in the
   GitOps repo via Kargo.
3. Kargo promotes through `dev` → `staging` → `prod` based on the project's
   stage graph and approvers.
4. Argo CD applies the updated manifests; Rollouts do a canary with Grafana
   queries as analysis gates.
5. If any metric is off, Rollouts auto-aborts.

## Multi-cluster

One console deployment can front many clusters:

- The Platform view tracks each cluster in a registry
  (`@adhar-console/api-clients/k8s`'s `listClusters()`).
- Credentials are held as Kubeconfig secrets OR the console's SA in each
  cluster trusts the central Keycloak realm for user impersonation.
- Latency note: the BFF talks cluster-to-cluster via the kube-apiserver of
  each target cluster; not ideal for streaming pod logs at scale. The 0.3.x
  roadmap is to deploy a small agent per cluster that the central console
  multiplexes to.

## Rollback

- `kubectl rollout undo deployment/adhar-console -n adhar-console` (standard
  K8s rollback).
- Or: revert the GitOps commit → Kargo → Argo CD picks it up → Rollout
  reverses the canary.

## Hardening checklist

- [ ] PodSecurity admission `restricted` — Kyverno enforces.
- [ ] `NetworkPolicy` scoped to backing tool namespaces only (not yet in repo).
- [ ] `PodDisruptionBudget` with `minAvailable: 1` so Kargo promotions can't
      take the console down.
- [ ] `HorizontalPodAutoscaler` on CPU + request rate for high-traffic tenants.
- [ ] Signed images (`cosign sign`), verified by Kyverno policy at admission.
