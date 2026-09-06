import type {
  BackingTool,
  ChangelogEntry,
  FeatureHighlight,
  PlatformVersion,
  RoadmapItem,
} from './types.ts'

export const PLATFORM_VERSION: PlatformVersion = {
  console: '0.1.42',
  api: '0.1.42',
  built: '2026-09-06T10:00:00Z',
  commit: 'main',
  released: '2026-09-06',
}

/**
 * Marquee capabilities showcased on the What's New page. Curated (not every
 * patch) — the headline experiences that define the Adhar platform.
 */
export const FEATURE_HIGHLIGHTS: FeatureHighlight[] = [
  {
    title: 'Service Catalog',
    description:
      'A Backstage-style catalog of every service, API, resource, system and team — with lifecycle, ownership, tech-docs and a deployment drawer wiring repo, GitOps, environments and monitoring together.',
    icon: 'catalog',
    category: 'Develop',
    isNew: true,
  },
  {
    title: 'Blue Ocean pipelines',
    description:
      'A Jenkins Blue Ocean-style PipelineRun viewer: a live stage graph with parallel branches and per-stage streaming console — search, follow, per-step log downloads and fullscreen.',
    icon: 'pipeline',
    category: 'Deliver',
    isNew: true,
  },
  {
    title: 'GitOps delivery',
    description:
      'ArgoCD applications, sync status, revisions and environments surfaced across the console — from the catalog drawer to the Deliver phase — so what is running is always tied back to Git.',
    icon: 'gitops',
    category: 'Deliver',
  },
  {
    title: 'OpenShift-grade logs',
    description:
      'Live, streaming pod logs with follow, regex/severity filtering, ANSI colour, timestamps, download — and workload-level aggregation that merges every pod of a Deployment in one view.',
    icon: 'logs',
    category: 'Observe',
    isNew: true,
  },
  {
    title: 'In-browser Cloud Shell',
    description:
      'A full terminal into any pod — or a cluster shell with kubectl, helm and k9s — running as you, under your Kubernetes RBAC. No kubeconfig juggling.',
    icon: 'shell',
    category: 'Platform',
  },
  {
    title: 'Adhar Resources',
    description:
      'Self-service infrastructure via Crossplane composites — provision databases, environments, buckets and more from a schema-driven catalog with a Composition/variant picker.',
    icon: 'resources',
    category: 'Platform',
  },
  {
    title: 'Unified observability',
    description:
      'Golden-signal metrics, SLOs, alerts, traces and service maps from the LGTM stack — with an incident timeline and platform-health scoring on the overview.',
    icon: 'observability',
    category: 'Observe',
  },
  {
    title: 'Policy & supply-chain security',
    description:
      'Kyverno policy reports, Trivy image scans and runtime signals fold into a live security score, so drift and vulnerabilities surface where you work.',
    icon: 'security',
    category: 'Secure',
  },
  {
    title: 'First-class code editor',
    description:
      'A Monaco-powered editor everywhere you touch YAML or JSON — manifests, ConfigMaps, Secrets, pipeline specs — with folding, search, format, diff-ready theming and one-click copy/download.',
    icon: 'editor',
    category: 'Platform',
    isNew: true,
  },
  {
    title: 'Production-readiness scorecards',
    description:
      'Every service graded against ownership, docs, delivery, security and observability checks — so teams see exactly what to fix before shipping.',
    icon: 'scorecard',
    category: 'Decide',
  },
]

export const BACKING_TOOLS: BackingTool[] = [
  {
    id: 'gitea',
    name: 'Gitea',
    purpose: 'Git repository hosting, PRs, issues, packages',
    version: '1.23.1',
    homepage: 'https://about.gitea.com',
    sourceRepo: 'https://github.com/go-gitea/gitea',
    license: 'MIT',
    health: 'operational',
    docsUrl: 'https://docs.gitea.com',
  },
  {
    id: 'argocd',
    name: 'Argo CD',
    purpose: 'GitOps continuous delivery',
    version: 'v2.13.3',
    homepage: 'https://argo-cd.readthedocs.io',
    sourceRepo: 'https://github.com/argoproj/argo-cd',
    license: 'Apache-2.0',
    health: 'operational',
  },
  {
    id: 'kargo',
    name: 'Kargo',
    purpose: 'Multi-stage GitOps promotion',
    version: 'v1.2.0',
    homepage: 'https://kargo.akuity.io',
    sourceRepo: 'https://github.com/akuity/kargo',
    license: 'Apache-2.0',
    health: 'operational',
  },
  {
    id: 'argo-rollouts',
    name: 'Argo Rollouts',
    purpose: 'Progressive deployment strategies (canary, blue/green)',
    version: 'v1.8.2',
    homepage: 'https://argoproj.github.io/argo-rollouts',
    sourceRepo: 'https://github.com/argoproj/argo-rollouts',
    license: 'Apache-2.0',
    health: 'operational',
  },
  {
    id: 'argo-workflows',
    name: 'Argo Workflows',
    purpose: 'Container-native CI / workflow engine',
    version: 'v3.6.4',
    homepage: 'https://argoproj.github.io/argo-workflows',
    sourceRepo: 'https://github.com/argoproj/argo-workflows',
    license: 'Apache-2.0',
    health: 'operational',
  },
  {
    id: 'crossplane',
    name: 'Crossplane',
    purpose: 'Cloud infrastructure via Kubernetes APIs',
    version: 'v1.18.0',
    homepage: 'https://www.crossplane.io',
    sourceRepo: 'https://github.com/crossplane/crossplane',
    license: 'Apache-2.0',
    health: 'operational',
  },
  {
    id: 'keycloak',
    name: 'Keycloak',
    purpose: 'Identity, SSO, realm federation',
    version: '26.0.5',
    homepage: 'https://www.keycloak.org',
    sourceRepo: 'https://github.com/keycloak/keycloak',
    license: 'Apache-2.0',
    health: 'operational',
  },
  {
    id: 'harbor',
    name: 'Harbor',
    purpose: 'OCI registry with vulnerability scanning',
    version: 'v2.12.1',
    homepage: 'https://goharbor.io',
    sourceRepo: 'https://github.com/goharbor/harbor',
    license: 'Apache-2.0',
    health: 'operational',
  },
  {
    id: 'kyverno',
    name: 'Kyverno',
    purpose: 'Kubernetes admission policy engine',
    version: 'v1.13.2',
    homepage: 'https://kyverno.io',
    sourceRepo: 'https://github.com/kyverno/kyverno',
    license: 'Apache-2.0',
    health: 'operational',
  },
  {
    id: 'plane',
    name: 'Plane',
    purpose: 'Agile project management (issues, cycles, OKRs)',
    version: 'v0.24.0',
    homepage: 'https://plane.so',
    sourceRepo: 'https://github.com/makeplane/plane',
    license: 'AGPL-3.0',
    health: 'operational',
  },
  {
    id: 'grafana',
    name: 'Grafana',
    purpose: 'Dashboards + alerting (LGTM observability)',
    version: '11.4.0',
    homepage: 'https://grafana.com',
    sourceRepo: 'https://github.com/grafana/grafana',
    license: 'AGPL-3.0',
    health: 'operational',
  },
  {
    id: 'loki',
    name: 'Loki',
    purpose: 'Log aggregation (LGTM observability)',
    version: '3.3.0',
    homepage: 'https://grafana.com/oss/loki',
    sourceRepo: 'https://github.com/grafana/loki',
    license: 'AGPL-3.0',
    health: 'operational',
  },
  {
    id: 'mimir',
    name: 'Mimir',
    purpose: 'Horizontally scalable metrics (LGTM observability)',
    version: '2.14.2',
    homepage: 'https://grafana.com/oss/mimir',
    sourceRepo: 'https://github.com/grafana/mimir',
    license: 'AGPL-3.0',
    health: 'operational',
  },
  {
    id: 'tempo',
    name: 'Tempo',
    purpose: 'Distributed traces (LGTM observability)',
    version: '2.7.0',
    homepage: 'https://grafana.com/oss/tempo',
    sourceRepo: 'https://github.com/grafana/tempo',
    license: 'AGPL-3.0',
    health: 'operational',
  },
  {
    id: 'prometheus',
    name: 'Prometheus',
    purpose: 'Metrics collection and alerting',
    version: 'v3.1.0',
    homepage: 'https://prometheus.io',
    sourceRepo: 'https://github.com/prometheus/prometheus',
    license: 'Apache-2.0',
    health: 'operational',
  },
  {
    id: 'opentelemetry',
    name: 'OpenTelemetry Collector',
    purpose: 'Telemetry pipeline for traces, metrics, logs',
    version: '0.116.0',
    homepage: 'https://opentelemetry.io',
    sourceRepo: 'https://github.com/open-telemetry/opentelemetry-collector',
    license: 'Apache-2.0',
    health: 'operational',
  },
  {
    id: 'beyla',
    name: 'Grafana Beyla',
    purpose: 'Zero-code eBPF auto-instrumentation',
    version: 'v2.0.0',
    homepage: 'https://grafana.com/oss/beyla-ebpf',
    sourceRepo: 'https://github.com/grafana/beyla',
    license: 'Apache-2.0',
    health: 'operational',
  },
]

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.1.42',
    date: '2026-09-06',
    highlights: [
      'Service Catalog: redesigned entity cards, a Deployment drawer (repo · GitOps · environments · monitoring) and embedded TechDocs',
      'Pipelines: a Jenkins Blue Ocean-style stage viewer with a live stage graph and per-stage streaming console (search, follow, downloads)',
      'Logs: OpenShift-grade viewer with workload-level aggregation across every pod of a Deployment/StatefulSet/DaemonSet/Job',
      'A shared Monaco code editor across every YAML/JSON surface (manifests, ConfigMaps, Secrets, pipeline specs)',
      'Overview: real storage capacity, live security & performance health, and DORA lead time from Git',
      'Platform status: fully dynamic, live component health derived from the cluster',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-04-19',
    highlights: [
      'Initial shell with 6D phase navigation (Define, Design, Develop, Deliver, Discover, Decide) + cross-cutting Platform view',
      'Module Federation host + remotes for each phase',
      'Stubbed BFF facade across Gitea, Plane, ArgoCD, Kargo, Harbor, K8s, Kyverno, Crossplane, Argo Workflows, Argo Rollouts, LGTM',
      'Kubernetes dashboard (cluster + workloads + events + Adhar-stack CRD browser)',
      'SaaS admin: onboarding, orgs, members, teams, projects, environments, tokens, audit, billing',
      'Public platform status page showing each OSS tool with version and source links',
    ],
  },
]

export const ROADMAP_HIGHLIGHTS: RoadmapItem[] = [
  { title: 'Real Keycloak OIDC + tenant-scoped access tokens', status: 'in-progress', target: '0.2.0' },
  { title: 'Live K8s API streaming (watch + server-sent events)', status: 'in-progress', target: '0.2.0' },
  { title: 'Kargo-driven promotions visible in Deliver', status: 'planned', target: '0.3.0' },
  { title: 'Per-user personal access tokens + CLI', status: 'planned', target: '0.3.0' },
  { title: 'External Secrets + SOPS-native secret management UI', status: 'planned', target: '0.4.0' },
  { title: 'Organization SSO (Keycloak realm federation) from UI', status: 'planned', target: '0.4.0' },
]
