import { EmptyState, Spinner } from '@adhar-console/shell-ui'
import { XrList, type XrKindConfig } from './xr-list.tsx'
import { ResourcePlaybooks } from '../components/resource-playbooks.tsx'
import { useXrds, type XrdInfo } from '../data/xrds.ts'

/**
 * Schema-driven registration for every Adhar Platform Crossplane composite.
 *
 * The create form's field set **and** the apply payload are generated from the
 * live CompositeResourceDefinition on the cluster (see `../data/xrds.ts`), so
 * they can never drift from the real XRD — which is what caused server-side
 * apply to fail with `field not declared in schema`. All this file supplies is a
 * small **curation** map (family, glyph, connection-secret convention, nicer
 * label) per known kind for presentation; the field authorship is gone.
 *
 * `XrListForKind` resolves a kind against the live XRDs and hands a fully
 * schema-derived {@link XrKindConfig} to the generic `<XrList/>`. The section
 * views below are thin wrappers over it, keyed by the XR's plural resource.
 */

export type FamilyId = 'compute' | 'data' | 'connectivity' | 'observability' | 'governance'

/** Glyph id — mapped to an SVG in `catalog.tsx`. */
export type GlyphId =
  | 'app'
  | 'bolt'
  | 'route'
  | 'git'
  | 'database'
  | 'zap'
  | 'archive'
  | 'radio'
  | 'layers'
  | 'waves'
  | 'compass'
  | 'globe'
  | 'scale'
  | 'file'
  | 'shield'
  | 'certificate'
  | 'key'
  | 'gauge'
  | 'eye'
  | 'coins'
  | 'network'
  | 'cluster'

export interface Curation {
  family: FamilyId
  icon: GlyphId
  /** Presentation label override (defaults to the humanized kind). */
  label?: string
  description?: string
  /** How to locate the claim's connection Secret (see XrKindConfig). */
  connectionSecret?: { nameFromSpec?: string; nameTemplate?: string }
}

/**
 * Per-kind presentation curation. Field sets are NOT here — they come from the
 * live XRD schema. Unknown/newly-added kinds fall back to a derived family +
 * generic glyph, so the catalog still registers them.
 */
export const CURATION: Record<string, Curation> = {
  CompositeApplication: {
    family: 'compute',
    icon: 'app',
    description: 'End-to-end service claims composed through Crossplane.',
  },
  CompositeService: { family: 'compute', icon: 'app', description: 'Kubernetes service workloads.' },
  CompositePipeline: {
    family: 'compute',
    icon: 'git',
    description: 'CI/CD pipelines — Argo Workflows / Tekton composed into reusable pipelines.',
  },
  CompositeGitOps: {
    family: 'compute',
    icon: 'git',
    description: 'GitOps delivery wiring — Argo CD applications and projects.',
  },
  CompositeScale: {
    family: 'compute',
    icon: 'gauge',
    description: 'Autoscaling policies — HPA-backed scaling for workloads.',
  },
  CompositeWebhook: {
    family: 'compute',
    icon: 'bolt',
    description: 'Webhook endpoints wired into cluster events.',
  },
  CompositeDatabase: {
    family: 'data',
    icon: 'database',
    description: 'Managed databases — PostgreSQL / MySQL / Redis / Valkey via Crossplane providers.',
    connectionSecret: { nameFromSpec: 'writeConnectionSecretToRef.name', nameTemplate: '<name>-conn' },
  },
  CompositeStorage: {
    family: 'data',
    icon: 'archive',
    description: 'Object / block / file storage claims — S3, MinIO, PVs.',
    connectionSecret: { nameFromSpec: 'writeConnectionSecretToRef.name', nameTemplate: '<name>-conn' },
  },
  CompositeMessaging: {
    family: 'data',
    icon: 'radio',
    description: 'Event streaming — Kafka / Strimzi topics with retention and partitions.',
    connectionSecret: { nameFromSpec: 'writeConnectionSecretToRef.name', nameTemplate: '<name>-conn' },
  },
  CompositeSecret: {
    family: 'data',
    icon: 'key',
    description: 'Synced secrets — External Secrets backed material.',
  },
  CompositeSecretRotation: {
    family: 'data',
    icon: 'key',
    description: 'Automated secret rotation policies.',
  },
  CompositeBackupPolicy: {
    family: 'data',
    icon: 'archive',
    description: 'Backup policies — Velero schedules and retention.',
  },
  CompositeRestore: {
    family: 'data',
    icon: 'archive',
    description: 'Restore operations from backups.',
  },
  CompositeNetwork: {
    family: 'connectivity',
    icon: 'network',
    description: 'Networks — VPC / VNet provisioned across clouds.',
  },
  CompositeHealth: {
    family: 'observability',
    icon: 'eye',
    description: 'Health probes and synthetic checks across targets.',
  },
  CompositeMetrics: {
    family: 'observability',
    icon: 'gauge',
    description: 'Metrics pipelines — Prometheus scrape + rules.',
  },
  CompositeLogging: {
    family: 'observability',
    icon: 'waves',
    description: 'Log aggregation — Loki stacks.',
  },
  CompositeTrace: {
    family: 'observability',
    icon: 'waves',
    description: 'Distributed tracing — Jaeger pipelines.',
  },
  CompositeCostTracker: {
    family: 'observability',
    icon: 'coins',
    description: 'Cost tracking — OpenCost integration.',
  },
  CompositeEnvironment: {
    family: 'governance',
    icon: 'shield',
    description: 'Namespace blueprints — RBAC, quotas, NetworkPolicy composed as one unit.',
  },
  CompositeProject: {
    family: 'governance',
    icon: 'shield',
    description: 'Project scaffolding — namespaces, teams, and defaults.',
  },
  CompositeCluster: {
    family: 'governance',
    icon: 'cluster',
    description: 'Managed clusters — EKS / AKS / GKE / K3s provisioned via Crossplane.',
  },
  CompositePlatformConfig: {
    family: 'governance',
    icon: 'file',
    description: 'Platform-wide configuration bundles.',
  },
  CompositeCompliancePolicy: {
    family: 'governance',
    icon: 'shield',
    description: 'Compliance policies — Kyverno / Gatekeeper rule sets.',
  },
  CompositeAuthStack: {
    family: 'governance',
    icon: 'key',
    description: 'Authentication stacks — Keycloak realms and clients.',
  },
}

/** Derive a family from the kind name when it isn't explicitly curated. */
function deriveFamily(kind: string): FamilyId {
  const k = kind.toLowerCase()
  if (/(database|storage|messaging|secret|backup|restore|cache|bucket|topic|queue)/.test(k)) return 'data'
  if (/(network|route|domain|ingress|gateway|dns|loadbalancer)/.test(k)) return 'connectivity'
  if (/(health|metric|log|trace|observ|cost|monitor)/.test(k)) return 'observability'
  if (/(environment|project|cluster|policy|compliance|auth|config|governance|rbac)/.test(k)) {
    return 'governance'
  }
  return 'compute'
}

export function curationFor(kind: string): Curation {
  return CURATION[kind] ?? { family: deriveFamily(kind), icon: 'file' }
}

/**
 * Build a fully schema-derived {@link XrKindConfig} from a discovered XRD plus
 * its presentation curation. The form fields + apply shape come from the XRD; a
 * matching drawer "Spec" view is generated from the same fields (paths honour
 * whether values live under `spec.parameters`).
 */
export function configFromXrd(info: XrdInfo): XrKindConfig {
  const cur = curationFor(info.kind)
  const singular = cur.label ?? info.humanSingular
  const specFields = info.fields.slice(0, 12).map((f) => ({
    key: info.parametersMode ? `parameters.${f.key}` : f.key,
    label: f.label,
    mono: f.mono,
  }))
  return {
    gvr: info.gvr,
    kind: info.kind,
    singular,
    plural: cur.label ? `${cur.label}s` : info.humanPlural,
    description: cur.description ?? `${info.kind} — provisioned via Crossplane composition.`,
    docsHref: 'https://docs.adhar.io/platform',
    formFields: info.fields,
    specFields,
    connectionSecret: cur.connectionSecret,
    parametersMode: info.parametersMode,
    supportsCompositionSelector: info.supportsCompositionSelector,
    compositionSelectorRequired: info.compositionSelectorRequired,
  }
}

/**
 * Resolve a kind against the live XRDs (by plural resource, kind, or singular)
 * and render the generic `<XrList/>` with a schema-derived config. Honest
 * states while discovery is loading and when the XRD isn't installed.
 */
export function XrListForKind({
  resource,
  kind,
  namespace,
}: {
  /** XR plural resource, e.g. `compositedatabases`. */
  resource?: string
  /** XR kind, e.g. `CompositeDatabase`. */
  kind?: string
  namespace?: string
}) {
  const xrdsQ = useXrds()

  if (xrdsQ.isLoading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-content-muted">
        <Spinner size={16} /> Discovering Adhar Resources…
      </div>
    )
  }

  const info = (xrdsQ.data ?? []).find(
    (x) =>
      (resource && x.plural === resource) ||
      (kind && x.kind === kind) ||
      (resource && x.humanSingular.toLowerCase() === resource.toLowerCase()),
  )

  if (!info) {
    const label = kind ?? resource ?? 'This resource'
    return (
      <EmptyState
        title={`${label} not installed`}
        description={
          <>
            No <code className="font-mono">CompositeResourceDefinition</code> for{' '}
            <code className="font-mono">{label}</code> is registered on this cluster. Install the
            Adhar Platform Crossplane stack to provision it, or browse the{' '}
            <a
              className="text-brand-700 dark:text-brand-300 underline hover:text-brand-800"
              href="?section=catalog"
            >
              Adhar Resources catalog
            </a>{' '}
            for what is available.
          </>
        }
      />
    )
  }

  return (
    <div className="space-y-4">
      <XrList config={configFromXrd(info)} namespace={namespace} />
      <ResourcePlaybooks
        kind={info.kind}
        namespace={namespace}
        docsPath={`resources/${info.plural}`}
      />
    </div>
  )
}

/* ───── section views (thin wrappers, keyed by live XR plural resource) ─────
 *
 * These map the legacy platform section ids to live XRDs. Kinds that aren't
 * installed on the cluster render an honest "not installed" state via
 * <XrListForKind/>. The Adhar Resources catalog (catalog.tsx) is the dynamic,
 * complete registry of every discovered XRD.
 */

export function ApplicationsView({ namespace }: { namespace?: string }) {
  return <XrListForKind resource="compositeapplications" namespace={namespace} />
}
export function DatabasesView({ namespace }: { namespace?: string }) {
  return <XrListForKind resource="compositedatabases" namespace={namespace} />
}
export function DataPipelinesView({ namespace }: { namespace?: string }) {
  return <XrListForKind resource="datapipelines" namespace={namespace} />
}
export function PipelinesView({ namespace }: { namespace?: string }) {
  return <XrListForKind resource="compositepipelines" namespace={namespace} />
}
export function RoutesView({ namespace }: { namespace?: string }) {
  return <XrListForKind resource="routes" namespace={namespace} />
}
export function CachesView({ namespace }: { namespace?: string }) {
  return <XrListForKind resource="compositecaches" namespace={namespace} />
}
export function BucketsView({ namespace }: { namespace?: string }) {
  return <XrListForKind resource="compositestorages" namespace={namespace} />
}
export function TopicsView({ namespace }: { namespace?: string }) {
  return <XrListForKind resource="compositemessagings" namespace={namespace} />
}
export function FunctionsView({ namespace }: { namespace?: string }) {
  return <XrListForKind resource="compositefunctions" namespace={namespace} />
}
export function WorkflowsView({ namespace }: { namespace?: string }) {
  return <XrListForKind resource="compositeworkflows" namespace={namespace} />
}
export function EnvironmentsView({ namespace }: { namespace?: string }) {
  return <XrListForKind resource="compositeenvironments" namespace={namespace} />
}
export function DomainsView({ namespace }: { namespace?: string }) {
  return <XrListForKind resource="domains" namespace={namespace} />
}
export function ApiContractsView({ namespace }: { namespace?: string }) {
  return <XrListForKind resource="apicontracts" namespace={namespace} />
}
export function QueuesView({ namespace }: { namespace?: string }) {
  return <XrListForKind resource="messagequeues" namespace={namespace} />
}
export function CertificatesView({ namespace }: { namespace?: string }) {
  return <XrListForKind resource="certificates" namespace={namespace} />
}
export function SecretStoresView({ namespace }: { namespace?: string }) {
  return <XrListForKind resource="compositesecrets" namespace={namespace} />
}
export function LoadBalancersView({ namespace }: { namespace?: string }) {
  return <XrListForKind resource="loadbalancers" namespace={namespace} />
}
