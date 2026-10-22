# Tool logos — provenance

Official logos of the open-source tools the Adhar platform packages, bundled
with `@adhar/shell-ui` and rendered by `ToolLogo` (`../tool-logo.tsx`). They
are used nominatively — only to identify each tool — and remain trademarks of
their respective owners. Downloaded once (2026-10-23) from the sources below;
nothing is fetched at runtime.

Every SVG was treated as untrusted input and sanitised before it was copied
here: `<script>`, `<foreignObject>`, `<image>`, `on*` handlers, non-fragment
`href`s, `@import`, `<!DOCTYPE>`/entities, metadata, comments and
`prefers-color-scheme` media rules removed, then optimised with svgo
(viewBox kept). PNGs were re-encoded and downscaled to at most 256 px.
`tool-logos_test.ts` re-checks the sanitisation rules on every bundled SVG.

Adhar-built packages (`adhar-*`) are not listed: they render the Adhar
symbol (`AdharSymbol`) instead.

| Key | File | Source | Licence / trademark | Processing |
| --- | --- | --- | --- | --- |
| `agentgateway` | `agentgateway.svg` | <https://raw.githubusercontent.com/agentgateway/agentgateway/HEAD/ui/public/agw-mark-color.svg> | Project-published artwork; trademark of its owner |  |
| `airbyte` | `airbyte.svg` | <https://raw.githubusercontent.com/airbytehq/airbyte/HEAD/docs/platform/assets/airbyte_new_logo.svg> | Project-published artwork; trademark of its owner | viewBox tightened to the mark (wordmark dropped) |
| `alloy` | `alloy.svg` | <https://raw.githubusercontent.com/grafana/alloy/HEAD/docs/sources/assets/alloy_icon_orange.svg> | Project-published artwork; trademark of its owner |  |
| `argo` | `argo.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/argo/icon/color/argo-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `baserow` | `baserow.svg` | <https://raw.githubusercontent.com/baserow/baserow/HEAD/web-frontend/modules/core/static/img/logoOnly.svg> | Project-published artwork; trademark of its owner |  |
| `beyla` | `beyla.png` | <https://raw.githubusercontent.com/grafana/beyla/HEAD/docs/sources/assets/logo.png> | Project-published artwork; trademark of its owner | re-encoded; resized to ≤256 px |
| `buildpacks` | `buildpacks.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/buildpacks/icon/color/buildpacks-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `cert-manager` | `cert-manager.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/cert-manager/icon/color/cert-manager-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `chaos-mesh` | `chaos-mesh.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/chaosmesh/icon/color/chaosmesh-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `cilium` | `cilium.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/cilium/icon/color/cilium_icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `cloudnative-pg` | `cloudnative-pg.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/cloudnativepg/icon/color/cloudnativepg-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `coder` | `coder.svg` | <https://raw.githubusercontent.com/coder/coder/HEAD/site/static/favicons/favicon-dark.svg> | Project-published artwork; trademark of its owner |  |
| `cosign` | `cosign.svg` | <https://raw.githubusercontent.com/sigstore/community/HEAD/artwork/cosign/icons/color/sigstore_cosign-icon-color.svg> | Project-published artwork; trademark of its owner |  |
| `crossplane` | `crossplane.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/crossplane/icon/color/crossplane-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `dagster` | `dagster.svg` | <https://raw.githubusercontent.com/dagster-io/dagster/HEAD/docs/static/images/dagster-primary-mark.svg> | Project-published artwork; trademark of its owner |  |
| `dapr` | `dapr.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/dapr/icon/color/dapr-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `dbt` | `dbt.png` | <https://raw.githubusercontent.com/dbt-labs/dbt-core/HEAD/assets/dbt-logo-full.png> | Project-published artwork; trademark of its owner | cropped to the mark, resized |
| `dex` | `dex.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/dex/icon/color/dex-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `external-dns` | `external-dns.png` | <https://raw.githubusercontent.com/kubernetes-sigs/external-dns/HEAD/docs/img/external-dns.png> | Project-published artwork; trademark of its owner | re-encoded; resized to ≤256 px |
| `external-secrets` | `external-secrets.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/external-secrets-operator/icon/color/eso-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `falco` | `falco.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/falco/icon/color/falco-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `faro` | `faro.png` | <https://raw.githubusercontent.com/grafana/faro-web-sdk/HEAD/docs/faro_logo.png> | Project-published artwork; trademark of its owner | cropped to the mark, resized |
| `fluent-bit` | `fluent-bit.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/fluentd/fluentbit/icon/fluentbit-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `flux` | `flux.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/flux/icon/color/flux-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `gitea` | `gitea.svg` | <https://raw.githubusercontent.com/go-gitea/gitea/HEAD/assets/logo.svg> | Project-published artwork; trademark of its owner |  |
| `grafana` | `grafana.svg` | <https://raw.githubusercontent.com/grafana/grafana/HEAD/public/img/grafana_icon.svg> | Project-published artwork; trademark of its owner |  |
| `harbor` | `harbor.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/harbor/icon/color/harbor-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `headlamp` | `headlamp.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/headlamp/icon/color/headlamp-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `helm` | `helm.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/helm/icon/color/helm-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `hubble` | `hubble.png` | <https://raw.githubusercontent.com/cilium/hubble/HEAD/Documentation/images/hubble_logo.png> | Project-published artwork; trademark of its owner | cropped to the mark, resized |
| `istio` | `istio.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/istio/icon/color/istio-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `jaeger` | `jaeger.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/jaeger/icon/color/jaeger-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `jupyterhub` | `jupyterhub.svg` | <https://raw.githubusercontent.com/jupyter/design/HEAD/logos/Logo%20Mark/logomark-orangebody-greyplanets/logomark-orangebody-greyplanets.svg> | Project-published artwork; trademark of its owner |  |
| `k6` | `k6.svg` | <https://raw.githubusercontent.com/grafana/k6/HEAD/assets/logo.svg> | Project-published artwork; trademark of its owner |  |
| `k8sgpt` | `k8sgpt.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/k8sgpt/icon/color/k8sgpt-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `kafka-ui` | `kafka-ui.svg` | <https://raw.githubusercontent.com/provectus/kafka-ui/HEAD/kafka-ui-react-app/public/favicon/icon.svg> | Project-published artwork; trademark of its owner |  |
| `kamaji` | `kamaji.svg` | <https://raw.githubusercontent.com/clastix/kamaji/HEAD/assets/logo.svg> | Project-published artwork; trademark of its owner |  |
| `kargo` | `kargo.png` | <https://raw.githubusercontent.com/akuity/kargo/HEAD/ui/public/kargo-logo-head-only.png> | Project-published artwork; trademark of its owner | re-encoded; resized to ≤256 px |
| `karmada` | `karmada.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/karmada/icon/color/karmada-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `kata-containers` | `kata-containers.png` | <https://raw.githubusercontent.com/kata-containers/kata-containers/HEAD/docs/assets/images/favicon.svg> | Project-published artwork; trademark of its owner | raster mark extracted from the SVG (it only wraps a PNG), resized |
| `keda` | `keda.svg` | <https://raw.githubusercontent.com/kedacore/keda/HEAD/images/logos/keda-icon-simple.svg> | Project-published artwork; trademark of its owner |  |
| `keycloak` | `keycloak.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/keycloak/icon/color/keycloak-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `knative` | `knative.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/knative/icon/color/knative-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `kubeflow` | `kubeflow.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/kubeflow/icon/color/kubeflow-icon.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `kubeflow-pipelines` | `kubeflow-pipelines.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/kubeflow-pipelines/icon/color/kubeflow-pipelines-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `kubernetes` | `kubernetes.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/kubernetes/icon/color/kubernetes-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `kubescape` | `kubescape.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/kubescape/icon/color/kubescape-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `kyverno` | `kyverno.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/kyverno/icon/color/kyverno-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `libredb-studio` | `libredb-studio.svg` | <https://raw.githubusercontent.com/libredb/libredb-studio/HEAD/public/logo.svg> | Project-published artwork; trademark of its owner |  |
| `litmus` | `litmus.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/litmus/icon/color/litmus-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `llm-d` | `llm-d.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/llm-d/icon/color/llm-d-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `loki` | `loki.svg` | <https://raw.githubusercontent.com/grafana/grafana/HEAD/public/app/features/loki-helpers/loki_icon.svg> | Project-published artwork; trademark of its owner |  |
| `longhorn` | `longhorn.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/longhorn/icon/color/longhorn-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `mariadb` | `mariadb.svg` | <https://mariadb-operator.github.io/mariadb-operator/assets/mariadb_centered_whitebg.svg> | Project-published artwork; trademark of its owner | viewBox tightened to the mark (wordmark dropped) |
| `metabase` | `metabase.svg` | <https://raw.githubusercontent.com/metabase/metabase/HEAD/resources/frontend_client/app/assets/img/logo.svg> | Project-published artwork; trademark of its owner |  |
| `mimir` | `mimir.svg` | <https://raw.githubusercontent.com/grafana/grafana/HEAD/public/img/alerting/mimir_logo.svg> | Project-published artwork; trademark of its owner |  |
| `minio` | `minio.svg` | <https://raw.githubusercontent.com/minio/minio/HEAD/.github/logo.svg> | Project-published artwork; trademark of its owner |  |
| `mlflow` | `mlflow.svg` | <https://raw.githubusercontent.com/mlflow/mlflow/HEAD/assets/icon.svg> | Project-published artwork; trademark of its owner |  |
| `mongodb` | `mongodb.svg` | <https://cdn.jsdelivr.net/npm/simple-icons@13.21.0/icons/mongodb.svg> | simple-icons glyph, CC0-1.0 — **fallback** (no official SVG found) | brand colour #47A248 applied |
| `mysql` | `mysql.svg` | <https://cdn.jsdelivr.net/npm/simple-icons@13.21.0/icons/mysql.svg> | simple-icons glyph, CC0-1.0 — **fallback** (no official SVG found) | brand colour #4479A1 applied |
| `n8n` | `n8n.svg` | <https://raw.githubusercontent.com/n8n-io/n8n/HEAD/packages/frontend/@n8n/design-system/src/components/N8nLogo/logo-icon.svg> | Project-published artwork; trademark of its owner |  |
| `nats` | `nats.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/nats/icon/color/nats-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `neo4j` | `neo4j.png` | <https://neo4j.com/favicon-194x194.png?v=bOXynyJWa61> | Project-published artwork; trademark of its owner | re-encoded; resized to ≤256 px |
| `nexus` | `nexus.svg` | <https://raw.githubusercontent.com/sonatype/nexus-public/HEAD/public/common/components/nexus-rapture/src/main/resources/static/rapture/resources/favicon.svg> | Project-published artwork; trademark of its owner |  |
| `nvidia` | `nvidia.svg` | <https://cdn.jsdelivr.net/npm/simple-icons@13.21.0/icons/nvidia.svg> | simple-icons glyph, CC0-1.0 — **fallback** (no official SVG found) | brand colour #76B900 applied |
| `oncall` | `oncall.svg` | <https://raw.githubusercontent.com/grafana/grafana/HEAD/public/img/alerting/oncall_logo.svg> | Project-published artwork; trademark of its owner |  |
| `open-metadata` | `open-metadata.svg` | <https://raw.githubusercontent.com/open-metadata/OpenMetadata/HEAD/openmetadata-ui/src/main/resources/ui/src/assets/svg/logo.svg> | Project-published artwork; trademark of its owner | viewBox tightened to the mark (wordmark dropped) |
| `openbao` | `openbao.svg` | <https://raw.githubusercontent.com/openbao/openbao/HEAD/website/public/img/favicon.svg> | Project-published artwork; trademark of its owner |  |
| `opencost` | `opencost.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/opencost/icon/color/Opencost_Icon_Color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `openfunction` | `openfunction.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/openfunction/icon/color/openfunction-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `opensearch` | `opensearch.svg` | <https://opensearch.org/assets/img/opensearch-logo-themed.svg> | Project-published artwork; trademark of its owner | viewBox tightened to the mark (wordmark dropped) |
| `opentelemetry` | `opentelemetry.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/opentelemetry/icon/color/opentelemetry-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `opentofu` | `opentofu.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/opentofu/icon/color/opentofu-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `penpot` | `penpot.svg` | <https://raw.githubusercontent.com/penpot/penpot/HEAD/frontend/resources/images/favicon.svg> | Project-published artwork; trademark of its owner |  |
| `pixie` | `pixie.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/pixie/icon/color/pixie-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `plane` | `plane.svg` | <https://plane.so/brand-logos/logo-dark.svg> | Project-published artwork; trademark of its owner |  |
| `posthog` | `posthog.svg` | <https://raw.githubusercontent.com/PostHog/posthog/HEAD/frontend/public/posthog-icon.svg> | Project-published artwork; trademark of its owner |  |
| `prefect` | `prefect.svg` | <https://raw.githubusercontent.com/PrefectHQ/prefect/HEAD/docs/logos/favicon.svg> | Project-published artwork; trademark of its owner |  |
| `prometheus` | `prometheus.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/prometheus/icon/color/prometheus-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `pyroscope` | `pyroscope.svg` | <https://raw.githubusercontent.com/grafana/pyroscope/HEAD/ui/public/favicon.svg> | Project-published artwork; trademark of its owner |  |
| `rabbitmq` | `rabbitmq.svg` | <https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/HEAD/static/img/rabbitmq-logo.svg> | Project-published artwork; trademark of its owner |  |
| `redis-operator` | `redis-operator.svg` | <https://raw.githubusercontent.com/OT-CONTAINER-KIT/redis-operator/HEAD/static/redis-operator-logo.svg> | Project-published artwork; trademark of its owner | viewBox tightened to the mark (wordmark dropped) |
| `rustfs` | `rustfs.png` | <https://rustfs.com/apple-touch-icon.png> | Project-published artwork; trademark of its owner | re-encoded; resized to ≤256 px |
| `spark-operator` | `spark-operator.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/kubeflow-spark-operator/icon/svg/icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `strapi` | `strapi.svg` | <https://raw.githubusercontent.com/strapi/strapi/HEAD/docs/static/img/favicon.svg> | Project-published artwork; trademark of its owner |  |
| `strimzi` | `strimzi.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/strimzi/icon/color/strimzi-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `tekton` | `tekton.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/tekton/icon/color/tekton-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `tempo` | `tempo.png` | <https://raw.githubusercontent.com/grafana/tempo/HEAD/cmd/tempo/app/static/tempo-icon.png> | Project-published artwork; trademark of its owner | re-encoded; resized to ≤256 px |
| `tetragon` | `tetragon.png` | <https://raw.githubusercontent.com/cilium/tetragon/HEAD/docs/static/favicons/favicon-256.png> | Project-published artwork; trademark of its owner | re-encoded; resized to ≤256 px |
| `tldraw` | `tldraw.svg` | <https://raw.githubusercontent.com/tldraw/tldraw/HEAD/apps/docs/public/favicon.svg> | Project-published artwork; trademark of its owner |  |
| `tolgee` | `tolgee.svg` | <https://raw.githubusercontent.com/tolgee/tolgee-platform/HEAD/webapp/public/favicon.svg> | Project-published artwork; trademark of its owner |  |
| `tooljet` | `tooljet.svg` | <https://raw.githubusercontent.com/ToolJet/ToolJet/HEAD/docs/static/img/Icon.svg> | Project-published artwork; trademark of its owner |  |
| `trino` | `trino.svg` | <https://raw.githubusercontent.com/trinodb/trino/HEAD/core/trino-web-ui/src/main/resources/webapp/src/assets/trino.svg> | Project-published artwork; trademark of its owner |  |
| `trivy` | `trivy.png` | <https://raw.githubusercontent.com/aquasecurity/trivy/HEAD/docs/imgs/logo.png> | Project-published artwork; trademark of its owner | re-encoded; resized to ≤256 px |
| `valkey` | `valkey.svg` | <https://raw.githubusercontent.com/valkey-io/valkey-website/HEAD/static/img/Valkey-logo.svg> | Project-published artwork; trademark of its owner |  |
| `vault` | `vault.svg` | <https://cdn.jsdelivr.net/npm/simple-icons@13.21.0/icons/vault.svg> | simple-icons glyph, CC0-1.0 — **fallback** (no official SVG found) | brand colour #000000 applied |
| `vcluster` | `vcluster.svg` | <https://raw.githubusercontent.com/loft-sh/vcluster-docs/HEAD/static/media/rebranding/VCluster_vCluster-icon_3.svg> | Project-published artwork; trademark of its owner | viewBox tightened to the mark (wordmark dropped) |
| `velero` | `velero.svg` | <https://raw.githubusercontent.com/cncf/artwork/main/projects/velero/icon/color/velero-icon-color.svg> | CNCF artwork (Linux Foundation trademark policy) |  |
| `victoria-metrics` | `victoria-metrics.svg` | <https://raw.githubusercontent.com/VictoriaMetrics/VictoriaMetrics/HEAD/app/vmui/packages/vmui/assets/favicon.svg> | Project-published artwork; trademark of its owner |  |
| `vllm` | `vllm.png` | <https://raw.githubusercontent.com/vllm-project/vllm/HEAD/docs/assets/logos/vllm-logo-only-light.png> | Project-published artwork; trademark of its owner | re-encoded; resized to ≤256 px |
| `webstudio` | `webstudio.svg` | <https://raw.githubusercontent.com/webstudio-is/webstudio/HEAD/packages/icons/icons/webstudio.svg> | Project-published artwork; trademark of its owner |  |

## Fallbacks

No official logo could be downloaded for these, so the `simple-icons` glyph
(CC0-1.0 path data; the mark itself is still the brand owner's trademark) is
used, tinted with the brand colour:

- `mongodb` (MongoDB), `mysql` (MySQL), `nvidia` (NVIDIA — `gpu-operator`),
  `vault` (HashiCorp Vault; vaultproject.io served only an HTML page).

## Mapping notes

- `argo` covers Argo CD, Argo Workflows, Argo Rollouts and Argo Events.
- `terraform` package → `opentofu` (it runs Flux's tofu-controller).
- `kafka-operator` → `strimzi`; `metrics-server` → `kubernetes`;
  `gpu-operator` → `nvidia`; `redis` → `redis-operator` (OT-Container-Kit).
- `jupyterhub` uses the Jupyter logomark from `jupyter/design`.

