import type { ComponentType, Entity, EntityKind, Lifecycle } from './catalog.ts'

/**
 * Backstage-style Software Templates.
 *
 * Each Template is a recipe for spinning up a new entity (typically a
 * Component) with golden-path defaults: a repo scaffold, CI/CD wiring,
 * observability, and registration into the catalog. The wizard collects
 * `parameters` step by step, then "executes" `steps` — in v1 each step is
 * just an animated stub so the UX is exercised end-to-end without a real
 * scaffolder backend.
 */

export type TemplateField =
  | {
      kind: 'string'
      key: string
      label: string
      placeholder?: string
      help?: string
      required?: boolean
      pattern?: { regex: RegExp; message: string }
      default?: string
    }
  | {
      kind: 'select'
      key: string
      label: string
      help?: string
      required?: boolean
      options: Array<{ value: string; label: string; description?: string }>
      default?: string
    }
  | {
      kind: 'multiselect'
      key: string
      label: string
      help?: string
      options: Array<{ value: string; label: string }>
      default?: string[]
    }
  | {
      kind: 'boolean'
      key: string
      label: string
      help?: string
      default?: boolean
    }
  | {
      kind: 'owner'
      key: string
      label: string
      help?: string
      required?: boolean
    }

export interface TemplateStep {
  key: string
  title: string
  description: string
  fields: TemplateField[]
}

export interface TemplateAction {
  /** Single line shown in the progress log (humanised). */
  title: string
  /** Estimated wall-clock seconds for the simulated run. */
  duration: number
  /** Optional sub-line shown under the title for extra context. */
  detail?: string
}

export type TemplateLanguage =
  | 'go'
  | 'java'
  | 'kotlin'
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'rust'
  | 'scala'
  | 'swift'
  | 'shell'
  | 'hcl'
  | 'helm'
  | 'mixed'

export type TemplateFamily =
  | 'service'
  | 'website'
  | 'library'
  | 'api'
  | 'mobile'
  | 'docs'
  | 'data'
  | 'infra'

export interface CatalogTemplate {
  id: string
  title: string
  description: string
  /** Type of entity produced — drives icon, default lifecycle, defaults. */
  produces: {
    kind: EntityKind
    type: ComponentType | string
  }
  family: TemplateFamily
  language: TemplateLanguage
  /** Tags shown on the template card. */
  tags: string[]
  /** Authoring info. */
  owner: string
  /** Steps in the wizard (each may have any number of fields). */
  steps: TemplateStep[]
  /** Simulated scaffold actions — drives the run-progress UI. */
  actions: TemplateAction[]
  /** Estimated wall-clock minutes for the simulated scaffold run. */
  estimateMinutes?: number
  /** Surface a "popular" badge on the card. */
  popular?: boolean
  /** Surface a "new" badge on the card. */
  isNew?: boolean
  /** Hex glyph (single emoji-like) — purely cosmetic. */
  glyph: string
  /** Tone for the card border. */
  tone: 'brand' | 'emerald' | 'sky' | 'amber' | 'violet' | 'rose' | 'slate'
  /** Where this template came from — drives a small provenance badge. */
  source?: 'seed' | 'user' | 'gitea'
  /** For Gitea templates: the source repo's browser URL. */
  repoUrl?: string
  /**
   * Declarative scaffold contract executed by the BFF `/api/scaffold` endpoint.
   * Absent → the template only registers a catalog entry (no repo/GitOps). This
   * is the low-maintenance knob: point `sourceRepo` at a real Gitea template
   * repo and the runtime does generate-repo → commit descriptor → GitOps.
   * See docs/guides/authoring-templates.md.
   */
  scaffold?: {
    /** Gitea template repo to generate from, "owner/repo". Omit → empty repo. */
    sourceRepo?: string
    /** Also create an Argo CD Application (GitOps). Default false. */
    gitops?: boolean
    /** Path Argo CD syncs within the new repo. Default "deploy". */
    manifestPath?: string
    /** Path for the catalog descriptor. Default "catalog-info.yaml". */
    catalogInfoPath?: string
    /**
     * Golden-path family. When set, `/api/scaffold` commits a complete,
     * production-shaped starter into the new repo: Dockerfile, CI workflow
     * (`.gitea/workflows/ci.yaml`), a `deploy/` Kustomize folder (probes +
     * resource requests/limits) and observability wiring (ServiceMonitor,
     * OTLP endpoint). Combine with `gitops: true` so Argo CD syncs `deploy/`.
     */
    goldenPath?: 'microservice' | 'frontend' | 'data-pipeline' | 'ml'
  }
}

/** Human-friendly label for each language used in filters and chips. */
export const LANGUAGE_LABEL: Record<TemplateLanguage, string> = {
  go: 'Go',
  java: 'Java',
  kotlin: 'Kotlin',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  rust: 'Rust',
  scala: 'Scala',
  swift: 'Swift',
  shell: 'Shell',
  hcl: 'HCL',
  helm: 'Helm',
  mixed: 'Mixed',
}

/* ─────────── shared field helpers ─────────── */

const NAME_FIELD: TemplateField = {
  kind: 'string',
  key: 'name',
  label: 'Component name',
  placeholder: 'orders-svc',
  help: 'Lowercase, kebab-case. Becomes the catalog name + repo slug.',
  required: true,
  pattern: {
    regex: /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/,
    message: 'Lowercase letters, digits and dashes — 3 to 40 characters.',
  },
}

const TITLE_FIELD: TemplateField = {
  kind: 'string',
  key: 'title',
  label: 'Display title',
  placeholder: 'Orders Service',
  help: 'Human-friendly name shown in the catalog header.',
  required: true,
}

const DESCRIPTION_FIELD: TemplateField = {
  kind: 'string',
  key: 'description',
  label: 'Description',
  placeholder: 'Short explanation of what this service does.',
  required: true,
}

const OWNER_FIELD: TemplateField = {
  kind: 'owner',
  key: 'owner',
  label: 'Owner',
  help: 'Pick a Group entity from the catalog. Inherits on-call + reviewers.',
  required: true,
}

const SYSTEM_FIELD: TemplateField = {
  kind: 'select',
  key: 'system',
  label: 'System',
  help: 'Group this component into an existing System — leave blank if none.',
  options: [
    { value: '', label: '—' },
    { value: 'system:storefront', label: 'Storefront' },
    { value: 'system:orders', label: 'Orders' },
    { value: 'system:lakehouse', label: 'Lakehouse' },
    { value: 'system:idp', label: 'Internal Developer Platform' },
  ],
}

/** Short numeric port field used by the golden-path templates. */
function portField(defaultPort: string): TemplateField {
  return {
    kind: 'string',
    key: 'port',
    label: 'HTTP port',
    default: defaultPort,
    help: 'Container port the workload listens on.',
    pattern: {
      regex: /^\d{2,5}$/,
      message: 'Numeric port, e.g. 8080.',
    },
  }
}

const LIFECYCLE_FIELD: TemplateField = {
  kind: 'select',
  key: 'lifecycle',
  label: 'Lifecycle',
  options: [
    { value: 'experimental', label: 'Experimental', description: 'Unstable — no SLOs yet.' },
    { value: 'staging', label: 'Staging', description: 'Pre-production rollout.' },
    { value: 'production', label: 'Production', description: 'Customer-facing, SLOs apply.' },
    { value: 'deprecated', label: 'Deprecated', description: 'Plan to retire.' },
  ],
  default: 'experimental',
}

/* ─────────── templates ─────────── */

const TEMPLATES: CatalogTemplate[] = [
  /* ─────── Golden paths — real scaffolds via /api/scaffold ─────── */

  {
    id: 'golden-microservice',
    title: 'Golden Path · Microservice',
    description:
      'Production-shaped Go or Node microservice — Dockerfile, CI (build/test/containerize/push), Kustomize deploy with probes + resource limits, ServiceMonitor and OTLP wiring, synced by Argo CD from day one.',
    produces: { kind: 'Component', type: 'service' },
    family: 'service',
    language: 'go',
    tags: ['golden-path', 'docker', 'kustomize', 'prometheus', 'otel'],
    owner: 'team-platform',
    estimateMinutes: 1,
    popular: true,
    isNew: true,
    glyph: 'GP',
    tone: 'brand',
    scaffold: { gitops: true, goldenPath: 'microservice' },
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'Name, purpose and owner of the new service.',
        fields: [NAME_FIELD, DESCRIPTION_FIELD, OWNER_FIELD],
      },
      {
        key: 'runtime',
        title: 'Runtime',
        description: 'Language and listen port.',
        fields: [
          {
            kind: 'select',
            key: 'language',
            label: 'Language',
            options: [
              { value: 'go', label: 'Go 1.23', description: 'net/http, distroless image.' },
              { value: 'node', label: 'Node 22', description: 'node:http, alpine image.' },
            ],
            default: 'go',
          },
          portField('8080'),
        ],
      },
    ],
    actions: [
      { title: 'Create repository', duration: 0.8 },
      { title: 'Commit catalog-info.yaml', duration: 0.4 },
      { title: 'Commit service + Dockerfile + CI', duration: 0.9, detail: '.gitea/workflows/ci.yaml' },
      { title: 'Commit deploy/ Kustomize + ServiceMonitor', duration: 0.7 },
      { title: 'Create Argo CD Application', duration: 0.6, detail: 'syncs deploy/' },
    ],
  },
  {
    id: 'golden-frontend',
    title: 'Golden Path · Frontend',
    description:
      'Vite + React static frontend served by nginx — Dockerfile, CI, Kustomize deploy with Deployment, Service and TLS Ingress, synced by Argo CD.',
    produces: { kind: 'Component', type: 'website' },
    family: 'website',
    language: 'typescript',
    tags: ['golden-path', 'react', 'vite', 'nginx', 'kustomize'],
    owner: 'team-frontend',
    estimateMinutes: 1,
    popular: true,
    isNew: true,
    glyph: 'GF',
    tone: 'sky',
    scaffold: { gitops: true, goldenPath: 'frontend' },
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'Name, purpose and owner of the new frontend.',
        fields: [NAME_FIELD, DESCRIPTION_FIELD, OWNER_FIELD, portField('8080')],
      },
    ],
    actions: [
      { title: 'Create repository', duration: 0.8 },
      { title: 'Commit catalog-info.yaml', duration: 0.4 },
      { title: 'Commit Vite + React starter + nginx Dockerfile + CI', duration: 0.9 },
      { title: 'Commit deploy/ Deployment + Service + Ingress', duration: 0.7 },
      { title: 'Create Argo CD Application', duration: 0.6, detail: 'syncs deploy/' },
    ],
  },
  {
    id: 'golden-data-pipeline',
    title: 'Golden Path · Data Pipeline',
    description:
      'Python batch job with an Argo CronWorkflow — extract/transform/load skeleton, Dockerfile, CI, and a 6-hourly schedule Argo CD keeps in sync.',
    produces: { kind: 'Component', type: 'service' },
    family: 'data',
    language: 'python',
    tags: ['golden-path', 'python', 'argo-workflows', 'batch'],
    owner: 'team-data',
    estimateMinutes: 1,
    isNew: true,
    glyph: 'GD',
    tone: 'amber',
    scaffold: { gitops: true, goldenPath: 'data-pipeline' },
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'Name, purpose and owner of the new pipeline.',
        fields: [NAME_FIELD, DESCRIPTION_FIELD, OWNER_FIELD],
      },
    ],
    actions: [
      { title: 'Create repository', duration: 0.8 },
      { title: 'Commit catalog-info.yaml', duration: 0.4 },
      { title: 'Commit job skeleton + Dockerfile + CI', duration: 0.9 },
      { title: 'Commit deploy/cronworkflow.yaml', duration: 0.5, detail: 'Argo CronWorkflow · every 6h' },
      { title: 'Create Argo CD Application', duration: 0.6, detail: 'syncs deploy/' },
    ],
  },
  {
    id: 'golden-ml-service',
    title: 'Golden Path · ML Service',
    description:
      'FastAPI model-serving skeleton with /predict, a weekly training CronWorkflow, Dockerfile, CI, and a deploy/ with resource requests, GPU notes and a ServiceMonitor.',
    produces: { kind: 'Component', type: 'service' },
    family: 'data',
    language: 'python',
    tags: ['golden-path', 'ml', 'fastapi', 'model-serving', 'argo-workflows'],
    owner: 'team-data',
    estimateMinutes: 1,
    isNew: true,
    glyph: 'GM',
    tone: 'violet',
    scaffold: { gitops: true, goldenPath: 'ml' },
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'Name, purpose and owner of the new model service.',
        fields: [NAME_FIELD, DESCRIPTION_FIELD, OWNER_FIELD, portField('8000')],
      },
    ],
    actions: [
      { title: 'Create repository', duration: 0.8 },
      { title: 'Commit catalog-info.yaml', duration: 0.4 },
      { title: 'Commit FastAPI serving + training skeleton + CI', duration: 0.9 },
      { title: 'Commit deploy/ Deployment + ServiceMonitor + training CronWorkflow', duration: 0.7 },
      { title: 'Create Argo CD Application', duration: 0.6, detail: 'syncs deploy/' },
    ],
  },

  {
    id: 'go-rest-service',
    title: 'Go REST Service',
    description:
      'Production-ready Go service with chi-router, OpenAPI spec, OTel tracing, and a Helm chart wired to the platform.',
    produces: { kind: 'Component', type: 'service' },
    family: 'service',
    language: 'go',
    tags: ['go', 'rest', 'helm', 'otel'],
    owner: 'team-platform',
    estimateMinutes: 3,
    popular: true,
    glyph: 'GO',
    tone: 'sky',
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'Tell us what this service is.',
        fields: [NAME_FIELD, TITLE_FIELD, DESCRIPTION_FIELD],
      },
      {
        key: 'ownership',
        title: 'Ownership',
        description: 'Who owns it and where it lives.',
        fields: [OWNER_FIELD, SYSTEM_FIELD, LIFECYCLE_FIELD],
      },
      {
        key: 'wiring',
        title: 'Wiring',
        description: 'Pick the integrations to wire on day one.',
        fields: [
          {
            kind: 'select',
            key: 'database',
            label: 'Primary database',
            options: [
              { value: 'none', label: 'None' },
              { value: 'postgres', label: 'Postgres (managed)' },
              { value: 'mysql', label: 'MySQL (managed)' },
            ],
            default: 'postgres',
          },
          {
            kind: 'select',
            key: 'cache',
            label: 'Cache',
            options: [
              { value: 'none', label: 'None' },
              { value: 'redis', label: 'Redis' },
              { value: 'dragonfly', label: 'Dragonfly' },
            ],
            default: 'none',
          },
          {
            kind: 'multiselect',
            key: 'features',
            label: 'Features',
            options: [
              { value: 'metrics', label: 'OpenTelemetry metrics' },
              { value: 'tracing', label: 'OpenTelemetry tracing' },
              { value: 'feature-flags', label: 'Feature flags (LaunchDarkly)' },
              { value: 'pagerduty', label: 'PagerDuty on-call' },
            ],
            default: ['metrics', 'tracing'],
          },
          {
            kind: 'boolean',
            key: 'publishApi',
            label: 'Publish OpenAPI surface to the catalog',
            default: true,
          },
        ],
      },
    ],
    actions: [
      { title: 'Render scaffold from template', duration: 0.6 },
      { title: 'Create repository', duration: 0.9, detail: 'github.com/acme/{{name}}' },
      { title: 'Push initial commit', duration: 0.8, detail: 'main · main_v1' },
      { title: 'Open release branch + protections', duration: 0.4 },
      { title: 'Provision CI workflow', duration: 1.2, detail: 'GitHub Actions · build / test / scan' },
      { title: 'Wire Helm chart', duration: 0.7, detail: 'platform-helm/charts/{{name}}' },
      { title: 'Create Argo CD Application', duration: 0.6 },
      { title: 'Register entity in catalog', duration: 0.5 },
    ],
  },
  {
    id: 'next-website',
    title: 'Next.js Website',
    description:
      'Next.js 15 with App Router, Tailwind, Playwright, edge deploy on Vercel — pre-instrumented and pre-routed.',
    produces: { kind: 'Component', type: 'website' },
    family: 'website',
    language: 'typescript',
    tags: ['next', 'react', 'tailwind', 'vercel'],
    owner: 'team-frontend',
    estimateMinutes: 2,
    popular: true,
    glyph: 'NX',
    tone: 'brand',
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'Tell us what site this is.',
        fields: [NAME_FIELD, TITLE_FIELD, DESCRIPTION_FIELD],
      },
      {
        key: 'ownership',
        title: 'Ownership',
        description: 'Owner + system.',
        fields: [OWNER_FIELD, SYSTEM_FIELD, LIFECYCLE_FIELD],
      },
      {
        key: 'wiring',
        title: 'Site',
        description: 'Hosting + UX defaults.',
        fields: [
          {
            kind: 'string',
            key: 'domain',
            label: 'Public domain',
            placeholder: 'app.acme.io',
            help: 'A Domain entity will be claimed automatically.',
          },
          {
            kind: 'select',
            key: 'i18n',
            label: 'Internationalisation',
            options: [
              { value: 'none', label: 'None' },
              { value: 'next-intl', label: 'next-intl (recommended)' },
              { value: 'react-intl', label: 'react-intl' },
            ],
            default: 'next-intl',
          },
          {
            kind: 'boolean',
            key: 'analytics',
            label: 'Wire product analytics (Posthog)',
            default: true,
          },
        ],
      },
    ],
    actions: [
      { title: 'Render scaffold', duration: 0.5 },
      { title: 'Create Vercel project', duration: 0.6 },
      { title: 'Provision domain + cert', duration: 0.8, detail: '{{domain}}' },
      { title: 'Wire CI · preview deploys', duration: 0.6 },
      { title: 'Register entity', duration: 0.4 },
    ],
  },
  {
    id: 'shared-library',
    title: 'TypeScript Library',
    description:
      'Tree-shakeable TS package with tsup, vitest, changesets, and automated npm publish from a tagged release.',
    produces: { kind: 'Component', type: 'library' },
    family: 'library',
    language: 'typescript',
    tags: ['typescript', 'library', 'changesets'],
    owner: 'team-platform',
    estimateMinutes: 2,
    glyph: 'TS',
    tone: 'violet',
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'Library name + scope.',
        fields: [
          {
            kind: 'string',
            key: 'scope',
            label: 'NPM scope',
            placeholder: '@acme',
            default: '@acme',
          },
          NAME_FIELD,
          TITLE_FIELD,
          DESCRIPTION_FIELD,
        ],
      },
      {
        key: 'ownership',
        title: 'Ownership',
        description: 'Pick the maintainer group.',
        fields: [OWNER_FIELD, LIFECYCLE_FIELD],
      },
    ],
    actions: [
      { title: 'Render scaffold', duration: 0.5 },
      { title: 'Initialise changesets', duration: 0.4 },
      { title: 'Configure npm publish workflow', duration: 0.6 },
      { title: 'Register entity', duration: 0.4 },
    ],
  },
  {
    id: 'openapi-spec',
    title: 'OpenAPI Contract',
    description:
      'A standalone API entity — no service yet. Useful for design-first API contracts that downstreams will consume.',
    produces: { kind: 'API', type: 'openapi' },
    family: 'api',
    language: 'mixed',
    tags: ['openapi', 'rest', 'design-first'],
    owner: 'team-platform',
    estimateMinutes: 1,
    glyph: 'API',
    tone: 'emerald',
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'Name + summary.',
        fields: [NAME_FIELD, TITLE_FIELD, DESCRIPTION_FIELD],
      },
      {
        key: 'spec',
        title: 'Spec',
        description: 'Pick the API style and starting version.',
        fields: [
          {
            kind: 'select',
            key: 'apiType',
            label: 'API style',
            options: [
              { value: 'openapi', label: 'OpenAPI (REST)' },
              { value: 'asyncapi', label: 'AsyncAPI (events)' },
              { value: 'graphql', label: 'GraphQL' },
              { value: 'grpc', label: 'gRPC' },
            ],
            default: 'openapi',
          },
          {
            kind: 'string',
            key: 'version',
            label: 'Initial version',
            default: '1.0.0',
          },
          OWNER_FIELD,
          SYSTEM_FIELD,
          LIFECYCLE_FIELD,
        ],
      },
    ],
    actions: [
      { title: 'Render contract scaffold', duration: 0.5 },
      { title: 'Validate spec', duration: 0.4 },
      { title: 'Register API entity', duration: 0.4 },
    ],
  },
  {
    id: 'python-data-job',
    title: 'Python Data Pipeline',
    description:
      'PySpark-based batch / streaming pipeline, scheduled via Argo Workflows, with dbt for transformations.',
    produces: { kind: 'Component', type: 'service' },
    family: 'data',
    language: 'python',
    tags: ['python', 'spark', 'dbt', 'argo'],
    owner: 'team-data',
    estimateMinutes: 4,
    glyph: 'PY',
    tone: 'amber',
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'Pipeline name + scope.',
        fields: [NAME_FIELD, TITLE_FIELD, DESCRIPTION_FIELD],
      },
      {
        key: 'ownership',
        title: 'Ownership',
        description: 'Who owns this pipeline.',
        fields: [OWNER_FIELD, SYSTEM_FIELD, LIFECYCLE_FIELD],
      },
      {
        key: 'pipeline',
        title: 'Pipeline',
        description: 'Schedule and inputs.',
        fields: [
          {
            kind: 'select',
            key: 'mode',
            label: 'Mode',
            options: [
              { value: 'batch', label: 'Batch' },
              { value: 'streaming', label: 'Streaming' },
            ],
            default: 'batch',
          },
          {
            kind: 'string',
            key: 'schedule',
            label: 'Schedule (cron)',
            placeholder: '0 */4 * * *',
            help: 'Standard cron expression. Ignored in streaming mode.',
          },
        ],
      },
    ],
    actions: [
      { title: 'Render scaffold', duration: 0.6 },
      { title: 'Provision Argo Workflow template', duration: 0.7 },
      { title: 'Create lake bucket binding', duration: 0.5 },
      { title: 'Register entity', duration: 0.4 },
    ],
  },
  {
    id: 'mobile-app',
    title: 'React Native App',
    description:
      'Expo-managed React Native app — TypeScript, EAS build, OTA updates, Sentry, ready for the App Store.',
    produces: { kind: 'Component', type: 'mobile-app' },
    family: 'mobile',
    language: 'typescript',
    tags: ['react-native', 'expo', 'typescript'],
    owner: 'team-frontend',
    estimateMinutes: 3,
    glyph: 'MB',
    tone: 'rose',
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'App name + display title.',
        fields: [NAME_FIELD, TITLE_FIELD, DESCRIPTION_FIELD],
      },
      {
        key: 'ownership',
        title: 'Ownership',
        description: 'Owner + system.',
        fields: [OWNER_FIELD, SYSTEM_FIELD, LIFECYCLE_FIELD],
      },
      {
        key: 'wiring',
        title: 'Distribution',
        description: 'Where the app will ship.',
        fields: [
          {
            kind: 'multiselect',
            key: 'targets',
            label: 'Targets',
            options: [
              { value: 'ios', label: 'iOS' },
              { value: 'android', label: 'Android' },
              { value: 'web', label: 'Web (PWA)' },
            ],
            default: ['ios', 'android'],
          },
          {
            kind: 'boolean',
            key: 'sentry',
            label: 'Wire Sentry crash reporting',
            default: true,
          },
        ],
      },
    ],
    actions: [
      { title: 'Render scaffold', duration: 0.5 },
      { title: 'Create EAS project', duration: 0.7 },
      { title: 'Provision OTA channel', duration: 0.5 },
      { title: 'Register entity', duration: 0.4 },
    ],
  },

  /* ─────── New: backend microservices ─────── */

  {
    id: 'spring-boot-microservice',
    title: 'Spring Boot Microservice',
    description:
      'Java 21 + Spring Boot 3 service — REST + actuator endpoints, JPA/PostgreSQL, OTel tracing, and a Helm chart wired to the platform.',
    produces: { kind: 'Component', type: 'service' },
    family: 'service',
    language: 'java',
    tags: ['java', 'spring-boot', 'rest', 'jpa'],
    owner: 'team-platform',
    estimateMinutes: 4,
    popular: true,
    isNew: true,
    glyph: 'SB',
    tone: 'emerald',
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'Tell us what this microservice is.',
        fields: [NAME_FIELD, TITLE_FIELD, DESCRIPTION_FIELD],
      },
      {
        key: 'ownership',
        title: 'Ownership',
        description: 'Owner + system + lifecycle.',
        fields: [OWNER_FIELD, SYSTEM_FIELD, LIFECYCLE_FIELD],
      },
      {
        key: 'wiring',
        title: 'Wiring',
        description: 'Maven/Gradle, framework defaults, and integrations.',
        fields: [
          {
            kind: 'select',
            key: 'buildTool',
            label: 'Build tool',
            options: [
              { value: 'maven', label: 'Maven' },
              { value: 'gradle', label: 'Gradle (Kotlin DSL)' },
            ],
            default: 'maven',
          },
          {
            kind: 'select',
            key: 'javaVersion',
            label: 'Java version',
            options: [
              { value: '17', label: '17 (LTS)' },
              { value: '21', label: '21 (LTS, recommended)' },
            ],
            default: '21',
          },
          {
            kind: 'select',
            key: 'database',
            label: 'Primary database',
            options: [
              { value: 'none', label: 'None' },
              { value: 'postgres', label: 'Postgres (managed)' },
              { value: 'mysql', label: 'MySQL (managed)' },
            ],
            default: 'postgres',
          },
          {
            kind: 'multiselect',
            key: 'features',
            label: 'Spring features',
            options: [
              { value: 'web', label: 'Spring Web (REST)' },
              { value: 'webflux', label: 'Spring WebFlux (reactive)' },
              { value: 'security', label: 'Spring Security + OIDC' },
              { value: 'data-jpa', label: 'Spring Data JPA' },
              { value: 'kafka', label: 'Spring Kafka' },
              { value: 'actuator', label: 'Actuator + Micrometer' },
            ],
            default: ['web', 'data-jpa', 'security', 'actuator'],
          },
          {
            kind: 'boolean',
            key: 'publishApi',
            label: 'Publish OpenAPI surface to the catalog',
            default: true,
          },
        ],
      },
    ],
    actions: [
      { title: 'Render Spring Boot scaffold', duration: 0.7 },
      { title: 'Create repository', duration: 0.8, detail: 'github.com/acme/{{name}}' },
      { title: 'Configure build', duration: 0.6, detail: 'Maven · Java 21' },
      { title: 'Provision CI workflow', duration: 1.2, detail: 'GitHub Actions · build / test / scan' },
      { title: 'Wire Helm chart', duration: 0.7, detail: 'platform-helm/charts/{{name}}' },
      { title: 'Provision Postgres database via platform.adhar.io/Database', duration: 0.9 },
      { title: 'Create Argo CD Application', duration: 0.6 },
      { title: 'Register entity in catalog', duration: 0.4 },
    ],
  },
  {
    id: 'kotlin-spring-microservice',
    title: 'Kotlin Spring Microservice',
    description:
      'Kotlin 2.0 + Spring Boot 3 reactive service — coroutines, R2DBC Postgres, OTel tracing, and a Helm chart.',
    produces: { kind: 'Component', type: 'service' },
    family: 'service',
    language: 'kotlin',
    tags: ['kotlin', 'spring-boot', 'webflux', 'r2dbc'],
    owner: 'team-platform',
    estimateMinutes: 4,
    isNew: true,
    glyph: 'KT',
    tone: 'violet',
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'Service name + summary.',
        fields: [NAME_FIELD, TITLE_FIELD, DESCRIPTION_FIELD],
      },
      {
        key: 'ownership',
        title: 'Ownership',
        description: 'Owner + system + lifecycle.',
        fields: [OWNER_FIELD, SYSTEM_FIELD, LIFECYCLE_FIELD],
      },
      {
        key: 'wiring',
        title: 'Wiring',
        description: 'Reactive defaults and integrations.',
        fields: [
          {
            kind: 'select',
            key: 'database',
            label: 'Primary database',
            options: [
              { value: 'none', label: 'None' },
              { value: 'postgres', label: 'Postgres (R2DBC)' },
              { value: 'mongo', label: 'MongoDB (reactive)' },
            ],
            default: 'postgres',
          },
          {
            kind: 'boolean',
            key: 'graphql',
            label: 'Add GraphQL endpoint (Spring for GraphQL)',
            default: false,
          },
          {
            kind: 'boolean',
            key: 'kafka',
            label: 'Wire reactive Kafka producer + consumer',
            default: false,
          },
        ],
      },
    ],
    actions: [
      { title: 'Render Kotlin scaffold', duration: 0.6 },
      { title: 'Create repository', duration: 0.7 },
      { title: 'Provision CI workflow', duration: 1.0 },
      { title: 'Wire Helm chart', duration: 0.6 },
      { title: 'Register entity', duration: 0.4 },
    ],
  },
  {
    id: 'fastapi-service',
    title: 'FastAPI Service',
    description:
      'Python 3.12 FastAPI service — async SQLAlchemy, Pydantic v2, OTel tracing, and uvicorn served behind a managed gateway.',
    produces: { kind: 'Component', type: 'service' },
    family: 'service',
    language: 'python',
    tags: ['python', 'fastapi', 'sqlalchemy', 'async'],
    owner: 'team-platform',
    estimateMinutes: 3,
    popular: true,
    glyph: 'PY',
    tone: 'emerald',
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'Service name + summary.',
        fields: [NAME_FIELD, TITLE_FIELD, DESCRIPTION_FIELD],
      },
      {
        key: 'ownership',
        title: 'Ownership',
        description: 'Owner + system + lifecycle.',
        fields: [OWNER_FIELD, SYSTEM_FIELD, LIFECYCLE_FIELD],
      },
      {
        key: 'wiring',
        title: 'Wiring',
        description: 'Database, packaging and integrations.',
        fields: [
          {
            kind: 'select',
            key: 'packaging',
            label: 'Packaging',
            options: [
              { value: 'uv', label: 'uv (recommended)' },
              { value: 'poetry', label: 'Poetry' },
              { value: 'pip', label: 'pip + requirements.txt' },
            ],
            default: 'uv',
          },
          {
            kind: 'select',
            key: 'database',
            label: 'Database',
            options: [
              { value: 'none', label: 'None' },
              { value: 'postgres', label: 'Postgres (asyncpg)' },
              { value: 'mongo', label: 'MongoDB (motor)' },
            ],
            default: 'postgres',
          },
          {
            kind: 'multiselect',
            key: 'features',
            label: 'Features',
            options: [
              { value: 'auth', label: 'OIDC auth dependency' },
              { value: 'celery', label: 'Celery background tasks' },
              { value: 'pydantic-v2', label: 'Pydantic v2 schemas' },
            ],
            default: ['auth', 'pydantic-v2'],
          },
        ],
      },
    ],
    actions: [
      { title: 'Render FastAPI scaffold', duration: 0.6 },
      { title: 'Provision Postgres', duration: 0.7 },
      { title: 'Configure CI', duration: 0.9 },
      { title: 'Register entity', duration: 0.4 },
    ],
  },
  {
    id: 'node-express-service',
    title: 'Node Express Service',
    description:
      'TypeScript Express service with Zod validation, Prisma ORM, structured logging, and a slim Docker image.',
    produces: { kind: 'Component', type: 'service' },
    family: 'service',
    language: 'typescript',
    tags: ['node', 'express', 'typescript', 'prisma'],
    owner: 'team-platform',
    estimateMinutes: 2,
    glyph: 'NJ',
    tone: 'sky',
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'Service name + summary.',
        fields: [NAME_FIELD, TITLE_FIELD, DESCRIPTION_FIELD],
      },
      {
        key: 'ownership',
        title: 'Ownership',
        description: 'Owner + system + lifecycle.',
        fields: [OWNER_FIELD, SYSTEM_FIELD, LIFECYCLE_FIELD],
      },
      {
        key: 'wiring',
        title: 'Wiring',
        description: 'Runtime + database defaults.',
        fields: [
          {
            kind: 'select',
            key: 'runtime',
            label: 'Runtime',
            options: [
              { value: 'node22', label: 'Node 22 (LTS)' },
              { value: 'bun', label: 'Bun 1.x' },
            ],
            default: 'node22',
          },
          {
            kind: 'select',
            key: 'database',
            label: 'Database',
            options: [
              { value: 'none', label: 'None' },
              { value: 'postgres', label: 'Postgres (Prisma)' },
              { value: 'mysql', label: 'MySQL (Prisma)' },
            ],
            default: 'postgres',
          },
        ],
      },
    ],
    actions: [
      { title: 'Render Express scaffold', duration: 0.4 },
      { title: 'Configure Prisma + migrations', duration: 0.5 },
      { title: 'Provision CI', duration: 0.7 },
      { title: 'Register entity', duration: 0.3 },
    ],
  },
  {
    id: 'grpc-service',
    title: 'gRPC Service (Go)',
    description:
      'Go gRPC service with buf-managed protos, Connect-Go transport, OTel, and a published proto contract.',
    produces: { kind: 'Component', type: 'service' },
    family: 'service',
    language: 'go',
    tags: ['go', 'grpc', 'buf', 'connect'],
    owner: 'team-platform',
    estimateMinutes: 3,
    glyph: 'gR',
    tone: 'sky',
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'Service + initial RPC namespace.',
        fields: [NAME_FIELD, TITLE_FIELD, DESCRIPTION_FIELD],
      },
      {
        key: 'ownership',
        title: 'Ownership',
        description: 'Owner + system.',
        fields: [OWNER_FIELD, SYSTEM_FIELD, LIFECYCLE_FIELD],
      },
      {
        key: 'proto',
        title: 'Proto',
        description: 'Contract publishing defaults.',
        fields: [
          {
            kind: 'string',
            key: 'protoPath',
            label: 'Proto package path',
            placeholder: 'acme.{{name}}.v1',
            default: 'acme.{{name}}.v1',
          },
          {
            kind: 'boolean',
            key: 'publishContract',
            label: 'Publish proto + buf SDK to the catalog as an API entity',
            default: true,
          },
        ],
      },
    ],
    actions: [
      { title: 'Render gRPC scaffold', duration: 0.5 },
      { title: 'Initialise buf module', duration: 0.4 },
      { title: 'Generate stubs', duration: 0.5 },
      { title: 'Configure CI · proto lint + breaking', duration: 0.9 },
      { title: 'Register entity + API contract', duration: 0.5 },
    ],
  },
  {
    id: 'background-worker',
    title: 'Background Worker',
    description:
      'Async job processor in Go — pulls from Kafka or NATS, retries with backoff, dead-letter queue support.',
    produces: { kind: 'Component', type: 'service' },
    family: 'service',
    language: 'go',
    tags: ['go', 'worker', 'kafka', 'queue'],
    owner: 'team-platform',
    estimateMinutes: 3,
    glyph: 'WK',
    tone: 'amber',
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'Worker name + summary.',
        fields: [NAME_FIELD, TITLE_FIELD, DESCRIPTION_FIELD],
      },
      {
        key: 'ownership',
        title: 'Ownership',
        description: 'Owner + system.',
        fields: [OWNER_FIELD, SYSTEM_FIELD, LIFECYCLE_FIELD],
      },
      {
        key: 'wiring',
        title: 'Source',
        description: 'Where the worker pulls jobs from.',
        fields: [
          {
            kind: 'select',
            key: 'source',
            label: 'Source',
            options: [
              { value: 'kafka', label: 'Kafka topic' },
              { value: 'nats', label: 'NATS subject' },
              { value: 'sqs', label: 'AWS SQS' },
            ],
            default: 'kafka',
          },
          {
            kind: 'string',
            key: 'topic',
            label: 'Topic / subject / queue',
            placeholder: 'orders.events.v1',
          },
        ],
      },
    ],
    actions: [
      { title: 'Render worker scaffold', duration: 0.5 },
      { title: 'Wire consumer + retry policy', duration: 0.4 },
      { title: 'Provision CI', duration: 0.8 },
      { title: 'Register entity', duration: 0.3 },
    ],
  },

  /* ─────── New: frontends ─────── */

  {
    id: 'react-spa',
    title: 'React SPA',
    description:
      'Vite + React 19 + TypeScript SPA — Tailwind v4, TanStack Router & Query, Vitest, Playwright. Deploys to S3+CloudFront via Argo CD.',
    produces: { kind: 'Component', type: 'website' },
    family: 'website',
    language: 'typescript',
    tags: ['react', 'vite', 'tanstack', 'tailwind'],
    owner: 'team-frontend',
    estimateMinutes: 2,
    popular: true,
    isNew: true,
    glyph: 'RX',
    tone: 'sky',
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'App name + summary.',
        fields: [NAME_FIELD, TITLE_FIELD, DESCRIPTION_FIELD],
      },
      {
        key: 'ownership',
        title: 'Ownership',
        description: 'Owner + system + lifecycle.',
        fields: [OWNER_FIELD, SYSTEM_FIELD, LIFECYCLE_FIELD],
      },
      {
        key: 'wiring',
        title: 'Stack',
        description: 'Pick the libraries you want pre-wired.',
        fields: [
          {
            kind: 'multiselect',
            key: 'features',
            label: 'Pre-wired',
            options: [
              { value: 'tanstack-router', label: 'TanStack Router' },
              { value: 'tanstack-query', label: 'TanStack Query' },
              { value: 'tailwind', label: 'Tailwind v4' },
              { value: 'i18n', label: 'i18next + ICU' },
              { value: 'auth', label: 'OIDC PKCE auth' },
              { value: 'storybook', label: 'Storybook 8' },
              { value: 'msw', label: 'MSW for tests' },
            ],
            default: ['tanstack-router', 'tanstack-query', 'tailwind', 'auth'],
          },
          {
            kind: 'string',
            key: 'domain',
            label: 'Public domain',
            placeholder: 'app.acme.io',
            help: 'A Domain entity will be claimed automatically.',
          },
        ],
      },
    ],
    actions: [
      { title: 'Render React + Vite scaffold', duration: 0.5 },
      { title: 'Wire TanStack Router + Query', duration: 0.5 },
      { title: 'Configure CI · build / test / preview', duration: 0.8 },
      { title: 'Provision S3 bucket + CloudFront distribution', duration: 0.9 },
      { title: 'Provision domain + cert', duration: 0.7, detail: '{{domain}}' },
      { title: 'Register entity', duration: 0.3 },
    ],
  },
  {
    id: 'vue-spa',
    title: 'Vue SPA',
    description:
      'Vue 3 + Vite + TypeScript SPA — Pinia store, Vue Router, Vitest, Cypress. Deploys to the platform CDN.',
    produces: { kind: 'Component', type: 'website' },
    family: 'website',
    language: 'typescript',
    tags: ['vue', 'vite', 'pinia'],
    owner: 'team-frontend',
    estimateMinutes: 2,
    glyph: 'VU',
    tone: 'emerald',
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'App name + summary.',
        fields: [NAME_FIELD, TITLE_FIELD, DESCRIPTION_FIELD],
      },
      {
        key: 'ownership',
        title: 'Ownership',
        description: 'Owner + system + lifecycle.',
        fields: [OWNER_FIELD, SYSTEM_FIELD, LIFECYCLE_FIELD],
      },
      {
        key: 'wiring',
        title: 'Stack',
        description: 'Pick the libraries you want pre-wired.',
        fields: [
          {
            kind: 'multiselect',
            key: 'features',
            label: 'Pre-wired',
            options: [
              { value: 'pinia', label: 'Pinia store' },
              { value: 'vue-router', label: 'Vue Router' },
              { value: 'tailwind', label: 'Tailwind v4' },
              { value: 'auth', label: 'OIDC PKCE auth' },
            ],
            default: ['pinia', 'vue-router', 'tailwind', 'auth'],
          },
        ],
      },
    ],
    actions: [
      { title: 'Render Vue + Vite scaffold', duration: 0.5 },
      { title: 'Wire Pinia + Vue Router', duration: 0.4 },
      { title: 'Configure CI', duration: 0.7 },
      { title: 'Register entity', duration: 0.3 },
    ],
  },
  {
    id: 'angular-spa',
    title: 'Angular SPA',
    description:
      'Angular 18 + standalone components, Signals, Tailwind v4 — pre-wired with TanStack Query for Angular and OIDC auth.',
    produces: { kind: 'Component', type: 'website' },
    family: 'website',
    language: 'typescript',
    tags: ['angular', 'signals', 'standalone'],
    owner: 'team-frontend',
    estimateMinutes: 3,
    glyph: 'NG',
    tone: 'rose',
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'App name + summary.',
        fields: [NAME_FIELD, TITLE_FIELD, DESCRIPTION_FIELD],
      },
      {
        key: 'ownership',
        title: 'Ownership',
        description: 'Owner + system + lifecycle.',
        fields: [OWNER_FIELD, SYSTEM_FIELD, LIFECYCLE_FIELD],
      },
      {
        key: 'wiring',
        title: 'Stack',
        description: 'Pick the libraries you want pre-wired.',
        fields: [
          {
            kind: 'multiselect',
            key: 'features',
            label: 'Pre-wired',
            options: [
              { value: 'signals', label: 'Signals + computed' },
              { value: 'tailwind', label: 'Tailwind v4' },
              { value: 'auth', label: 'OIDC PKCE auth' },
              { value: 'ngx-charts', label: 'ngx-charts' },
            ],
            default: ['signals', 'tailwind', 'auth'],
          },
        ],
      },
    ],
    actions: [
      { title: 'Render Angular workspace', duration: 0.6 },
      { title: 'Configure CI', duration: 0.8 },
      { title: 'Register entity', duration: 0.3 },
    ],
  },

  /* ─────── New: data + ML ─────── */

  {
    id: 'jupyter-notebook',
    title: 'Jupyter Notebook Project',
    description:
      'Python 3.12 notebook environment — uv-managed deps, JupyterLab, papermill for parameterised runs, MLflow tracking.',
    produces: { kind: 'Component', type: 'service' },
    family: 'data',
    language: 'python',
    tags: ['jupyter', 'mlflow', 'papermill'],
    owner: 'team-data',
    estimateMinutes: 2,
    isNew: true,
    glyph: 'JL',
    tone: 'amber',
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'Project name + summary.',
        fields: [NAME_FIELD, TITLE_FIELD, DESCRIPTION_FIELD],
      },
      {
        key: 'ownership',
        title: 'Ownership',
        description: 'Owner + system + lifecycle.',
        fields: [OWNER_FIELD, SYSTEM_FIELD, LIFECYCLE_FIELD],
      },
      {
        key: 'wiring',
        title: 'Wiring',
        description: 'Compute + tracking defaults.',
        fields: [
          {
            kind: 'select',
            key: 'compute',
            label: 'Default compute',
            options: [
              { value: 'cpu-small', label: 'CPU · small (2 vCPU / 8 GiB)' },
              { value: 'cpu-large', label: 'CPU · large (16 vCPU / 64 GiB)' },
              { value: 'gpu-t4', label: 'GPU · T4' },
              { value: 'gpu-a100', label: 'GPU · A100' },
            ],
            default: 'cpu-small',
          },
          {
            kind: 'boolean',
            key: 'mlflow',
            label: 'Wire MLflow tracking',
            default: true,
          },
        ],
      },
    ],
    actions: [
      { title: 'Render notebook scaffold', duration: 0.4 },
      { title: 'Provision JupyterLab workspace', duration: 0.7 },
      { title: 'Wire MLflow tracking', duration: 0.4 },
      { title: 'Register entity', duration: 0.3 },
    ],
  },

  /* ─────── New: infrastructure ─────── */

  {
    id: 'helm-chart',
    title: 'Helm Chart',
    description:
      'Reusable Helm chart with golden-path values — sane defaults for Deployment, Service, Ingress, HPA, ServiceMonitor and NetworkPolicy.',
    produces: { kind: 'Component', type: 'library' },
    family: 'infra',
    language: 'helm',
    tags: ['helm', 'kubernetes', 'platform'],
    owner: 'team-platform',
    estimateMinutes: 2,
    isNew: true,
    glyph: 'HM',
    tone: 'slate',
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'Chart name + summary.',
        fields: [NAME_FIELD, TITLE_FIELD, DESCRIPTION_FIELD],
      },
      {
        key: 'ownership',
        title: 'Ownership',
        description: 'Owner + lifecycle.',
        fields: [OWNER_FIELD, LIFECYCLE_FIELD],
      },
      {
        key: 'wiring',
        title: 'Defaults',
        description: 'Resources rendered out of the box.',
        fields: [
          {
            kind: 'multiselect',
            key: 'resources',
            label: 'Resources',
            options: [
              { value: 'deployment', label: 'Deployment' },
              { value: 'service', label: 'Service' },
              { value: 'ingress', label: 'Ingress' },
              { value: 'hpa', label: 'HorizontalPodAutoscaler' },
              { value: 'service-monitor', label: 'ServiceMonitor (Prometheus Operator)' },
              { value: 'network-policy', label: 'NetworkPolicy' },
              { value: 'cron-job', label: 'CronJob' },
            ],
            default: ['deployment', 'service', 'ingress', 'hpa', 'service-monitor'],
          },
        ],
      },
    ],
    actions: [
      { title: 'Render chart scaffold', duration: 0.4 },
      { title: 'Lint with helm-unittest', duration: 0.4 },
      { title: 'Publish to internal registry', duration: 0.6 },
      { title: 'Register entity', duration: 0.3 },
    ],
  },
  {
    id: 'terraform-module',
    title: 'Terraform Module',
    description:
      'Reusable Terraform module — versioned, documented with terraform-docs, examples folder, and CI for plan + drift detection.',
    produces: { kind: 'Component', type: 'library' },
    family: 'infra',
    language: 'hcl',
    tags: ['terraform', 'iac', 'platform'],
    owner: 'team-platform',
    estimateMinutes: 2,
    glyph: 'TF',
    tone: 'violet',
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'Module name + summary.',
        fields: [NAME_FIELD, TITLE_FIELD, DESCRIPTION_FIELD],
      },
      {
        key: 'ownership',
        title: 'Ownership',
        description: 'Owner + lifecycle.',
        fields: [OWNER_FIELD, LIFECYCLE_FIELD],
      },
      {
        key: 'wiring',
        title: 'Provider',
        description: 'Pick the provider this module targets.',
        fields: [
          {
            kind: 'select',
            key: 'provider',
            label: 'Provider',
            options: [
              { value: 'aws', label: 'AWS' },
              { value: 'gcp', label: 'GCP' },
              { value: 'azure', label: 'Azure' },
              { value: 'kubernetes', label: 'Kubernetes' },
              { value: 'multi', label: 'Multi-provider' },
            ],
            default: 'aws',
          },
        ],
      },
    ],
    actions: [
      { title: 'Render module scaffold', duration: 0.4 },
      { title: 'Generate terraform-docs', duration: 0.3 },
      { title: 'Configure CI · plan + drift', duration: 0.7 },
      { title: 'Register entity', duration: 0.3 },
    ],
  },
  {
    id: 'docs-site',
    title: 'Documentation Site',
    description:
      'Markdown-as-code docs portal — Astro Starlight, search, versioned navigation, deployed to the docs gateway.',
    produces: { kind: 'Component', type: 'documentation' },
    family: 'docs',
    language: 'mixed',
    tags: ['astro', 'starlight', 'markdown'],
    owner: 'team-platform',
    estimateMinutes: 2,
    glyph: 'DC',
    tone: 'brand',
    steps: [
      {
        key: 'identity',
        title: 'Identity',
        description: 'Site name + summary.',
        fields: [NAME_FIELD, TITLE_FIELD, DESCRIPTION_FIELD],
      },
      {
        key: 'ownership',
        title: 'Ownership',
        description: 'Owner + lifecycle.',
        fields: [OWNER_FIELD, LIFECYCLE_FIELD],
      },
    ],
    actions: [
      { title: 'Render Starlight scaffold', duration: 0.4 },
      { title: 'Configure docs gateway routing', duration: 0.5 },
      { title: 'Register entity', duration: 0.3 },
    ],
  },
]

/*
 * The composed list (user-registered + seed) is rebuilt only when user
 * templates actually change. This is critical because `getTemplates` is
 * also the snapshot function for `useSyncExternalStore` — returning a new
 * array reference on every call would trigger an infinite render loop
 * (React diffs by reference, sees a new array, re-renders, calls the
 * snapshot again, …). The cache is invalidated by `notify()` whenever
 * `registerTemplate` / `removeUserTemplate` runs.
 */
let cachedComposed: CatalogTemplate[] | null = null

function invalidateComposed() {
  cachedComposed = null
}

export function getTemplates(): CatalogTemplate[] {
  if (cachedComposed) return cachedComposed
  // Order: user-registered first, then Gitea-hosted (the platform's curated
  // golden paths), then the built-in seed as an always-present fallback.
  cachedComposed = [...readUserTemplates(), ...giteaTemplates, ...TEMPLATES]
  return cachedComposed
}

/* ─────────── Gitea-hosted templates (GET /api/templates) ─────────── */

/**
 * Templates discovered from Gitea by the BFF (`/api/templates`) — repos flagged
 * as template repositories, plus the curated templates org. Loaded once per tab
 * (call {@link loadGiteaTemplates} from the Create New page) and folded into
 * `getTemplates()` through the same external store, so the list re-renders when
 * they arrive. When Gitea isn't configured the list stays empty and the seed
 * templates are shown — the page always works.
 */
export interface GiteaTemplateStatus {
  loading: boolean
  loaded: boolean
  configured: boolean
  count: number
  error?: string
}

const VALID_FAMILIES = new Set<string>([
  'service',
  'website',
  'library',
  'api',
  'mobile',
  'docs',
  'data',
  'infra',
])

let giteaTemplates: CatalogTemplate[] = []
let giteaStatus: GiteaTemplateStatus = {
  loading: false,
  loaded: false,
  configured: false,
  count: 0,
}
let giteaInFlight: Promise<void> | null = null

export function getGiteaStatus(): GiteaTemplateStatus {
  return giteaStatus
}

/** Coerce a RegExp that survived JSON as `{source,flags}` or a string. */
function toRegExp(v: unknown): RegExp | undefined {
  try {
    if (v instanceof RegExp) return v
    if (typeof v === 'string') return new RegExp(v)
    if (v && typeof v === 'object' && 'source' in v) {
      const o = v as { source: string; flags?: string }
      return new RegExp(o.source, o.flags ?? '')
    }
  } catch {
    /* malformed pattern — skip validation */
  }
  return undefined
}

/** Harden one server-provided template into a well-formed CatalogTemplate. */
function sanitizeServerTemplate(raw: unknown): CatalogTemplate | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  if (typeof t.id !== 'string' || typeof t.title !== 'string') return null
  const steps = Array.isArray(t.steps)
    ? (t.steps as Array<Record<string, unknown>>).map((s) => ({
        key: String(s.key ?? s.id ?? 'step'),
        title: String(s.title ?? 'Details'),
        description: String(s.description ?? ''),
        fields: Array.isArray(s.fields)
          ? (s.fields as Array<Record<string, unknown>>).map((f) => {
              const field = { ...f, key: String(f.key ?? f.id ?? 'field') }
              if (f.pattern && typeof f.pattern === 'object') {
                const p = f.pattern as { regex?: unknown; message?: unknown }
                const regex = toRegExp(p.regex)
                field.pattern = regex ? { regex, message: String(p.message ?? 'Invalid value.') } : undefined
              }
              return field
            })
          : [],
      }))
    : []
  // Constrain to known enums so downstream label lookups never blow up.
  const language: TemplateLanguage = (LANGUAGE_LABEL as Record<string, string>)[String(t.language)]
    ? (t.language as TemplateLanguage)
    : 'mixed'
  const family: TemplateFamily = VALID_FAMILIES.has(String(t.family))
    ? (t.family as TemplateFamily)
    : 'service'
  return {
    id: t.id,
    title: t.title,
    description: String(t.description ?? ''),
    produces: (t.produces as CatalogTemplate['produces']) ?? { kind: 'Component', type: 'service' },
    family,
    language,
    tags: Array.isArray(t.tags) ? (t.tags as string[]).map(String) : ['gitea'],
    owner: String(t.owner ?? 'team-platform'),
    steps: steps.length ? (steps as CatalogTemplate['steps']) : [],
    actions: Array.isArray(t.actions) ? (t.actions as CatalogTemplate['actions']) : [],
    estimateMinutes: typeof t.estimateMinutes === 'number' ? t.estimateMinutes : 1,
    popular: Boolean(t.popular),
    isNew: Boolean(t.isNew),
    glyph: String(t.glyph ?? 'GT'),
    tone: (t.tone as CatalogTemplate['tone']) ?? 'brand',
    source: 'gitea',
    repoUrl: typeof t.repoUrl === 'string' ? t.repoUrl : undefined,
    scaffold: (t.scaffold as CatalogTemplate['scaffold']) ?? undefined,
  }
}

function setGiteaStatus(next: GiteaTemplateStatus): void {
  giteaStatus = next
  invalidateComposed()
  notify()
}

/**
 * Fetch Gitea templates once (deduped). Safe to call from multiple mounts;
 * concurrent calls share the same in-flight promise. Pass `force` to refetch.
 */
export function loadGiteaTemplates(force = false): Promise<void> {
  if (giteaInFlight) return giteaInFlight
  if (giteaStatus.loaded && !force) return Promise.resolve()
  setGiteaStatus({ ...giteaStatus, loading: true, error: undefined })
  giteaInFlight = (async () => {
    try {
      const res = await fetch('/api/templates', {
        credentials: 'include',
        headers: { accept: 'application/json' },
      })
      const ct = res.headers.get('content-type') ?? ''
      if (!res.ok || !ct.includes('application/json')) {
        // No BFF (dev SPA) or an error — keep seed templates, note the state.
        giteaTemplates = []
        setGiteaStatus({ loading: false, loaded: true, configured: false, count: 0 })
        return
      }
      const json = (await res.json()) as {
        configured?: boolean
        templates?: unknown[]
        error?: string
      }
      giteaTemplates = (json.templates ?? [])
        .map(sanitizeServerTemplate)
        .filter((t): t is CatalogTemplate => t !== null)
      setGiteaStatus({
        loading: false,
        loaded: true,
        configured: json.configured === true,
        count: giteaTemplates.length,
        error: json.error,
      })
    } catch (e) {
      giteaTemplates = []
      setGiteaStatus({
        loading: false,
        loaded: true,
        configured: false,
        count: 0,
        error: e instanceof Error ? e.message : 'network error',
      })
    } finally {
      giteaInFlight = null
    }
  })()
  return giteaInFlight
}

export function getTemplate(id: string): CatalogTemplate | undefined {
  return getTemplates().find((t) => t.id === id)
}

/* ─────────── user-registered templates (localStorage) ─────────── */

/*
 * Templates an organisation has registered themselves — the Backstage-style
 * "import a template.yaml" path. Stored in localStorage so each user can
 * experiment freely without a backend; a real implementation would POST
 * these to the Adhar BFF and the UI would consume `/api/templates`.
 *
 * `useUserTemplates` is a `useSyncExternalStore` subscriber — every
 * `registerTemplate` / `removeUserTemplate` call notifies all mounted
 * consumers in the tab, so the list updates immediately without
 * round-trips through React state.
 */

const USER_TEMPLATES_KEY = 'adhar.catalog.user-templates'

type Listener = () => void
const listeners = new Set<Listener>()
function notify() {
  for (const l of listeners) l()
}

function readUserTemplates(): CatalogTemplate[] {
  if (typeof globalThis === 'undefined' || !globalThis.localStorage) return []
  try {
    const raw = globalThis.localStorage.getItem(USER_TEMPLATES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as CatalogTemplate[]) : []
  } catch {
    return []
  }
}

function writeUserTemplates(next: CatalogTemplate[]): void {
  if (typeof globalThis === 'undefined' || !globalThis.localStorage) return
  try {
    globalThis.localStorage.setItem(USER_TEMPLATES_KEY, JSON.stringify(next))
  } catch {
    /* storage quota / private mode — non-fatal */
  }
  invalidateComposed()
  notify()
}

export function getUserTemplates(): CatalogTemplate[] {
  return readUserTemplates()
}

export function isUserTemplate(id: string): boolean {
  return readUserTemplates().some((t) => t.id === id)
}

export function registerTemplate(template: CatalogTemplate): void {
  const current = readUserTemplates()
  const idx = current.findIndex((t) => t.id === template.id)
  const next = idx >= 0 ? current.with(idx, template) : [template, ...current]
  writeUserTemplates(next)
}

export function removeUserTemplate(id: string): void {
  const next = readUserTemplates().filter((t) => t.id !== id)
  writeUserTemplates(next)
}

export function subscribeUserTemplates(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/**
 * Build a `CatalogTemplate` from minimal user input. Used by the
 * "Register template" modal to turn either a quick form OR a parsed
 * Backstage `template.yaml` snippet into a fully-typed local template.
 *
 * Sensible defaults plug every required field so the resulting template
 * is usable in the wizard immediately — the user can iterate later.
 */
export function buildCustomTemplate(input: {
  id?: string
  title: string
  description: string
  family?: TemplateFamily
  language?: TemplateLanguage
  owner?: string
  glyph?: string
  tone?: CatalogTemplate['tone']
  tags?: string[]
  sourceUrl?: string
}): CatalogTemplate {
  const id =
    input.id?.trim() ||
    `${input.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')}-${Date.now().toString(36).slice(-4)}`
  const family = input.family ?? 'service'
  const language = input.language ?? 'typescript'
  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean)
  return {
    id,
    title: input.title.trim(),
    description: input.description.trim(),
    produces: {
      kind: family === 'api' ? 'API' : family === 'infra' ? 'Resource' : 'Component',
      type: family,
    },
    family,
    language,
    tags: tags.length ? tags : ['custom'],
    owner: input.owner?.trim() || 'team-platform',
    glyph: input.glyph?.trim() || '⚙︎',
    tone: input.tone ?? 'brand',
    estimateMinutes: 5,
    steps: [
      {
        id: 'basics',
        title: 'Basics',
        description: 'Name and ownership for the new component.',
        fields: [
          {
            id: 'name',
            label: 'Name',
            type: 'string',
            required: true,
            placeholder: 'orders-svc',
          },
          {
            id: 'description',
            label: 'Description',
            type: 'string',
            placeholder: 'What does this component do?',
          },
          { id: 'owner', label: 'Owner', type: 'string', defaultValue: input.owner ?? 'team-platform' },
        ],
      },
    ],
    actions: [
      { title: 'Render scaffold from source', duration: 0.6, detail: input.sourceUrl ?? undefined },
      { title: 'Publish repository', duration: 0.5 },
      { title: 'Wire CI/CD', duration: 0.4 },
      { title: 'Register entity in catalog', duration: 0.3 },
    ],
  }
}

/* ─────────── render template result ─────────── */

/**
 * Build the Entity that the wizard will register on submit. Pure — no I/O.
 * Driven entirely by the values collected by the wizard.
 */
export function entityFromTemplate(
  template: CatalogTemplate,
  values: Record<string, unknown>,
): Entity {
  const name = String(values.name ?? '').trim()
  const title = String(values.title ?? '').trim() || name
  const description = String(values.description ?? '').trim() || template.description
  const owner = String(values.owner ?? `group:${template.owner}`).trim()
  const lifecycle = (values.lifecycle as Lifecycle | undefined) ?? 'experimental'
  const system = String(values.system ?? '').trim() || undefined
  const apiType = (values.apiType as string | undefined) ?? template.produces.type
  const tags = Array.from(new Set([...template.tags, ...(values.features as string[] | undefined ?? [])]))

  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: template.produces.kind,
    metadata: {
      name,
      namespace: 'default',
      title,
      description,
      tags,
      links: [
        { url: `https://github.com/acme/${name}`, title: 'Source', icon: 'repo' },
        { url: `https://docs.acme.io/${name}`, title: 'Docs', icon: 'docs' },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    spec: {
      type: template.produces.kind === 'API'
        ? (apiType as EntitySpecType)
        : (template.produces.type as EntitySpecType),
      lifecycle,
      owner,
      system,
    },
  }
}

// Local alias to satisfy `EntitySpec.type`'s union without re-importing.
type EntitySpecType = NonNullable<Entity['spec']['type']>
