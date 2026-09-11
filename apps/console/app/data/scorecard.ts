import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  type Entity,
  type EntityKind,
  type EntityMetadata,
  entityRef,
  type EntityRef,
  parseRef,
  useCatalog,
} from './catalog.ts'
// Type-only (erased at build, no server code reaches the browser bundle) — the
// wire contract of `GET /api/scorecards`, owned by the handler that emits it.
// Relative, not `~/`: the alias is Vite-only and does not resolve under `deno check`.
import type {
  PlatformCategory,
  PlatformScorecards,
  PlatformService,
  PlatformSignal,
} from '../server/scorecards.ts'

export type { PlatformCategory, PlatformScorecards, PlatformService, PlatformSignal }

/**
 * Production-readiness scorecards.
 *
 * Every catalog entity is graded against a weighted set of checks derived from
 * the entity's REAL fields — owner / description / lifecycle from `spec`,
 * docs / repo / runbook / dashboard from `metadata.links`, and operational
 * signals (Argo CD app, CI pipeline, resource limits, HPA, PDB, image scan,
 * alerts/SLO) from `adhar.io/*` / `backstage.io/*` / `argocd/*` annotations
 * when the live source carries them through.
 *
 * Honesty rule: a signal that is not derivable from the entity NEVER passes.
 * It fails with a `hint` explaining how to surface it (usually an annotation
 * on the workload), so the score can only improve by actually wiring the
 * signal up — the engine never fabricates readiness.
 *
 * ── Two scorers, one authoritative ──────────────────────────────────────────
 * The platform's `application/scorecards` package runs an in-cluster CronJob
 * that grades services from signals the browser simply cannot see (Argo CD
 * health/sync, container probes + requests/limits, image not `:latest`, Kyverno
 * PolicyReport pass rate, HTTPRoute exposure, Velero/CNPG backup coverage) and
 * publishes them to the `adhar-system/adhar-scorecards` ConfigMap. That scorer
 * is **authoritative**: `useLiveScorecards()` reads it through
 * `GET /api/scorecards` and uses its score/grade whenever it has graded a
 * service, falling back to the catalog derivation above otherwise. Every card
 * records which scorer produced it (`source`) so the UI can say so out loud,
 * and both numbers are kept (`score`/`grade` vs `derivedScore`/`derivedGrade`)
 * — nothing is averaged, blended, or invented.
 */

export type CheckCategory =
  | 'ownership'
  | 'delivery'
  | 'reliability'
  | 'security'
  | 'observability'

export const CHECK_CATEGORIES: readonly CheckCategory[] = [
  'ownership',
  'delivery',
  'reliability',
  'security',
  'observability',
]

export const CATEGORY_LABEL: Record<CheckCategory, string> = {
  ownership: 'Ownership',
  delivery: 'Delivery',
  reliability: 'Reliability',
  security: 'Security',
  observability: 'Observability',
}

export interface Check {
  id: string
  label: string
  category: CheckCategory
  weight: number
  pass: boolean
  detail?: string
  hint?: string
}

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F'

export interface CategoryScore {
  /** 0–100 over the category's applicable checks (100 when none apply). */
  score: number
  pass: number
  total: number
}

/** Which scorer produced a card's headline `score` / `grade`. */
export type ScoreSource = 'platform' | 'catalog'

export const SCORE_SOURCE_LABEL: Record<ScoreSource, string> = {
  platform: 'platform scorer',
  catalog: 'catalog-derived',
}

export interface Scorecard {
  entityRef: EntityRef
  /** Headline score, 0–100 — the platform scorer's when it graded this service. */
  score: number
  grade: Grade
  checks: Check[]
  byCategory: Record<CheckCategory, CategoryScore>
  /** The scored entity — handy for tables (name / kind / owner columns). */
  entity: Entity
  /** Where `score` / `grade` came from. */
  source: ScoreSource
  /** The in-cluster scorer's record, when it graded this service. */
  platform?: PlatformService
  /**
   * The console's own catalog derivation — kept alongside the platform score so
   * both are visible. Absent on a platform-only card: there is no catalog
   * entity to derive from, and a placeholder number would be a fabrication.
   */
  derivedScore?: number
  derivedGrade?: Grade
  /**
   * True when the platform scorer graded a service the catalog does not know
   * about. Such a card carries NO derived checks (there is no entity metadata
   * to check) — the entity below holds only what the scorer itself reported.
   */
  platformOnly: boolean
}

/* ─────────── annotation access (optional, never fabricated) ─────────── */

/**
 * `Entity.metadata` has no `annotations` field in the core model, but live
 * k8s-derived entities may carry one structurally. Read it defensively so the
 * engine picks the signal up the moment the live mapper forwards annotations —
 * and simply fails the check (with a hint) until then.
 */
function annotationsOf(e: Entity): Record<string, string> {
  const meta = e.metadata as EntityMetadata & { annotations?: Record<string, string> }
  return meta.annotations && typeof meta.annotations === 'object' ? meta.annotations : {}
}

function ann(e: Entity, ...keys: string[]): string | undefined {
  const all = annotationsOf(e)
  for (const k of keys) {
    const v = all[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

const FALSY = new Set(['false', '0', 'no', 'none', 'disabled', 'off'])

/** Annotation present and not an explicit "off" value. */
function annEnabled(e: Entity, ...keys: string[]): string | undefined {
  const v = ann(e, ...keys)
  if (!v || FALSY.has(v.toLowerCase())) return undefined
  return v
}

/* ─────────── shared signal helpers ─────────── */

type LinkIcon = 'docs' | 'dashboard' | 'repo' | 'runbook' | 'chat' | 'on-call'

function link(e: Entity, icon: LinkIcon): string | undefined {
  return (e.metadata.links ?? []).find((l) => l.icon === icon)?.url
}

function tags(e: Entity): Set<string> {
  return new Set((e.metadata.tags ?? []).map((t) => t.toLowerCase()))
}

function hasTag(e: Entity, ...names: string[]): string | undefined {
  const set = tags(e)
  return names.find((n) => set.has(n))
}

/** Deployable workload components — full operational bar applies. */
function isWorkload(e: Entity): boolean {
  if (e.kind !== 'Component') return false
  const t = e.spec.type
  return t === undefined || t === 'service' || t === 'website' || t === 'mobile-app'
}

function isComponent(e: Entity): boolean {
  return e.kind === 'Component'
}

/* ─────────── check definitions ─────────── */

interface CheckDef {
  id: string
  label: string
  category: CheckCategory
  weight: number
  applies(e: Entity): boolean
  run(e: Entity): { pass: boolean; detail?: string; hint?: string }
}

const CHECK_DEFS: CheckDef[] = [
  /* ─ ownership ─ */
  {
    id: 'has-owner',
    label: 'Has an owner',
    category: 'ownership',
    weight: 10,
    applies: () => true,
    run: (e) =>
      e.spec.owner
        ? { pass: true, detail: `Owned by ${parseRef(e.spec.owner).name}` }
        : {
            pass: false,
            detail: 'No owner declared',
            hint: 'Assign a Group via spec.owner or the adhar.io/owner annotation.',
          },
  },
  {
    id: 'has-description',
    label: 'Has a description',
    category: 'ownership',
    weight: 4,
    applies: () => true,
    run: (e) => {
      const d = e.metadata.description?.trim()
      return d
        ? { pass: true, detail: d.length > 80 ? `${d.slice(0, 77)}…` : d }
        : {
            pass: false,
            detail: 'Description missing',
            hint: 'Add metadata.description (or the adhar.io/description annotation) so people know what this is.',
          }
    },
  },
  {
    id: 'has-docs',
    label: 'Documentation linked',
    category: 'ownership',
    weight: 4,
    applies: () => true,
    run: (e) => {
      const url = link(e, 'docs') ?? annEnabled(e, 'adhar.io/docs', 'backstage.io/techdocs-ref')
      return url
        ? { pass: true, detail: url }
        : {
            pass: false,
            detail: 'No docs link registered',
            hint: 'Add a docs link to metadata.links or set the adhar.io/docs annotation.',
          }
    },
  },

  /* ─ delivery ─ */
  {
    id: 'has-repo',
    label: 'Source repository linked',
    category: 'delivery',
    weight: 8,
    applies: (e) => isComponent(e) || e.kind === 'API',
    run: (e) => {
      const url =
        link(e, 'repo') ??
        annEnabled(e, 'adhar.io/git-repo', 'adhar.io/source-repo', 'backstage.io/source-location')
      return url
        ? { pass: true, detail: url }
        : {
            pass: false,
            detail: 'No repo registered',
            hint: 'Link the Gitea repository via metadata.links or the adhar.io/git-repo annotation.',
          }
    },
  },
  {
    id: 'has-ci',
    label: 'CI pipeline configured',
    category: 'delivery',
    weight: 6,
    applies: isComponent,
    run: (e) => {
      const a = annEnabled(e, 'adhar.io/ci', 'adhar.io/ci-pipeline')
      const t = hasTag(e, 'ci', 'actions', 'woodpecker', 'drone', 'argo-workflows')
      if (a) return { pass: true, detail: `Pipeline: ${a}` }
      if (t) return { pass: true, detail: `Tagged "${t}"` }
      return {
        pass: false,
        detail: 'No CI signal in catalog metadata',
        hint: 'Annotate the workload with adhar.io/ci-pipeline=<pipeline url or name> once builds run in CI.',
      }
    },
  },
  {
    id: 'gitops-deployed',
    label: 'Deployed via GitOps (Argo CD)',
    category: 'delivery',
    weight: 8,
    applies: isWorkload,
    run: (e) => {
      const app = annEnabled(e, 'argocd/app-name', 'argocd.argoproj.io/instance', 'adhar.io/argocd-app')
      const t = hasTag(e, 'argocd', 'argo-cd', 'flux')
      if (app) return { pass: true, detail: `Argo CD app: ${app}` }
      if (t) return { pass: true, detail: `Managed by ${t} (workload label)` }
      return {
        pass: false,
        detail: 'No Argo CD application detected',
        hint: 'Deploy through Argo CD — the argocd/app-name annotation (or app.kubernetes.io/managed-by label) surfaces here.',
      }
    },
  },
  {
    id: 'lifecycle-production',
    label: 'Production lifecycle declared',
    category: 'delivery',
    weight: 6,
    applies: () => true,
    run: (e) =>
      e.spec.lifecycle === 'production'
        ? { pass: true, detail: 'lifecycle: production' }
        : {
            pass: false,
            detail: e.spec.lifecycle ? `lifecycle: ${e.spec.lifecycle}` : 'Lifecycle not declared',
            hint: 'Set spec.lifecycle (adhar.io/lifecycle annotation) to "production" once the service is GA.',
          },
  },

  /* ─ reliability ─ */
  {
    id: 'resource-limits',
    label: 'Resource requests/limits set',
    category: 'reliability',
    weight: 6,
    applies: isWorkload,
    run: (e) => {
      const v = annEnabled(e, 'adhar.io/resource-limits', 'adhar.io/resources')
      return v
        ? { pass: true, detail: `Declared: ${v}` }
        : {
            pass: false,
            detail: 'Not derivable from catalog metadata',
            hint: 'Set CPU/memory requests and limits on every container, and surface it with adhar.io/resource-limits=true.',
          }
    },
  },
  {
    id: 'has-hpa',
    label: 'Horizontal Pod Autoscaler',
    category: 'reliability',
    weight: 4,
    applies: isWorkload,
    run: (e) => {
      const v = annEnabled(e, 'adhar.io/hpa', 'adhar.io/autoscaling')
      return v
        ? { pass: true, detail: `HPA: ${v}` }
        : {
            pass: false,
            detail: 'No HPA signal',
            hint: 'Add an HPA for the workload and annotate it with adhar.io/hpa=<name or true>.',
          }
    },
  },
  {
    id: 'has-pdb',
    label: 'PodDisruptionBudget',
    category: 'reliability',
    weight: 4,
    applies: isWorkload,
    run: (e) => {
      const v = annEnabled(e, 'adhar.io/pdb', 'adhar.io/disruption-budget')
      return v
        ? { pass: true, detail: `PDB: ${v}` }
        : {
            pass: false,
            detail: 'No PDB signal',
            hint: 'Create a PodDisruptionBudget so voluntary evictions cannot take the service down; annotate with adhar.io/pdb.',
          }
    },
  },

  /* ─ security ─ */
  {
    id: 'image-scanned',
    label: 'Container image scanned',
    category: 'security',
    weight: 8,
    applies: isWorkload,
    run: (e) => {
      const v = annEnabled(e, 'adhar.io/image-scanned', 'adhar.io/trivy-scan', 'adhar.io/image-scan')
      return v
        ? { pass: true, detail: `Scan: ${v}` }
        : {
            pass: false,
            detail: 'No image-scan attestation',
            hint: 'Scan images in CI (e.g. Trivy via Harbor) and stamp the workload with adhar.io/image-scanned=true.',
          }
    },
  },

  /* ─ observability ─ */
  {
    id: 'has-alerts',
    label: 'Alerts / SLOs defined',
    category: 'observability',
    weight: 6,
    applies: (e) => isWorkload(e) || e.kind === 'Resource',
    run: (e) => {
      const v = annEnabled(e, 'adhar.io/slo', 'adhar.io/alerts', 'adhar.io/alerting')
      return v
        ? { pass: true, detail: `Declared: ${v}` }
        : {
            pass: false,
            detail: 'No alert/SLO signal',
            hint: 'Define PrometheusRules or an SLO and surface it via adhar.io/slo / adhar.io/alerts.',
          }
    },
  },
  {
    id: 'has-runbook',
    label: 'Runbook linked',
    category: 'observability',
    weight: 6,
    applies: (e) => isWorkload(e) || e.kind === 'Resource',
    run: (e) => {
      const url = link(e, 'runbook') ?? annEnabled(e, 'adhar.io/runbook', 'backstage.io/runbook')
      return url
        ? { pass: true, detail: url }
        : {
            pass: false,
            detail: 'No runbook registered',
            hint: 'Link an incident runbook via metadata.links or the adhar.io/runbook annotation.',
          }
    },
  },
  {
    id: 'has-dashboard',
    label: 'Dashboard linked',
    category: 'observability',
    weight: 4,
    applies: (e) => e.kind !== 'User' && e.kind !== 'Group',
    run: (e) => {
      const url = link(e, 'dashboard') ?? annEnabled(e, 'adhar.io/dashboard', 'backstage.io/dashboard')
      return url
        ? { pass: true, detail: url }
        : {
            pass: false,
            detail: 'No dashboard registered',
            hint: 'Link the Grafana (or product) dashboard via metadata.links or adhar.io/dashboard.',
          }
    },
  },
]

/* ─────────── scoring ─────────── */

export function gradeOf(score: number): Grade {
  if (score >= 90) return 'A'
  if (score >= 75) return 'B'
  if (score >= 60) return 'C'
  if (score >= 40) return 'D'
  return 'F'
}

/** Score one entity against every applicable check. Pure — safe in render. */
export function scoreEntity(entity: Entity): Scorecard {
  const checks: Check[] = CHECK_DEFS.filter((def) => def.applies(entity)).map((def) => {
    const res = def.run(entity)
    return {
      id: def.id,
      label: def.label,
      category: def.category,
      weight: def.weight,
      pass: res.pass,
      detail: res.detail,
      hint: res.pass ? undefined : res.hint,
    }
  })

  let earned = 0
  let possible = 0
  const byCategory = {} as Record<CheckCategory, CategoryScore>
  for (const cat of CHECK_CATEGORIES) byCategory[cat] = { score: 100, pass: 0, total: 0 }
  for (const c of checks) {
    possible += c.weight
    const bucket = byCategory[c.category]
    bucket.total += 1
    if (c.pass) {
      earned += c.weight
      bucket.pass += 1
    }
  }
  for (const cat of CHECK_CATEGORIES) {
    const applicable = checks.filter((c) => c.category === cat)
    const w = applicable.reduce((s, c) => s + c.weight, 0)
    const ok = applicable.reduce((s, c) => s + (c.pass ? c.weight : 0), 0)
    byCategory[cat].score = w > 0 ? Math.round((ok / w) * 100) : 100
  }

  const score = possible > 0 ? Math.round((earned / possible) * 100) : 100
  return {
    entityRef: entityRef(entity),
    score,
    grade: gradeOf(score),
    checks,
    byCategory,
    entity,
    source: 'catalog',
    derivedScore: score,
    derivedGrade: gradeOf(score),
    platformOnly: false,
  }
}

/* ─────────── hook ─────────── */

/** Kinds that get a production-readiness scorecard. */
export const SCOREABLE_KINDS: readonly EntityKind[] = ['Component', 'API', 'Resource']

export interface ScorecardsResult {
  scorecards: Scorecard[]
  isLoading: boolean
  /** Sample-catalog fallback is showing (no live / registered data). */
  offline: boolean
  /** At least one live source contributed entities. */
  live: boolean
}

/** All scoreable catalog entities → Scorecard[], derived from `useCatalog()`. */
export function useScorecards(): ScorecardsResult {
  const catalog = useCatalog()
  const scorecards = useMemo(
    () =>
      catalog.data
        .filter((e) => SCOREABLE_KINDS.includes(e.kind))
        .map(scoreEntity)
        .sort((a, b) => a.score - b.score || a.entityRef.localeCompare(b.entityRef)),
    [catalog.data],
  )
  return {
    scorecards,
    isLoading: catalog.isLoading,
    offline: catalog.offline,
    live: catalog.live,
  }
}

/* ─────────── platform scorer (authoritative, in-cluster) ─────────── */

export const PLATFORM_CATEGORIES: readonly PlatformCategory[] = [
  'reliability',
  'security',
  'observability',
  'operations',
]

export const PLATFORM_CATEGORY_LABEL: Record<PlatformCategory, string> = {
  reliability: 'Reliability',
  security: 'Security',
  observability: 'Observability',
  operations: 'Operations',
}

/**
 * Human labels for the scorer's signal ledger. An unknown signal name (the
 * platform package gained one and this build has not caught up) is humanised
 * from the key rather than dropped — the number is still real.
 */
const PLATFORM_SIGNAL_LABEL: Record<string, string> = {
  argocd_healthy: 'Argo CD application Healthy',
  probes: 'Readiness + liveness probe on every container',
  resources: 'CPU/memory requests AND limits on every container',
  image_not_latest: 'No :latest or untagged container image',
  kyverno_pass_rate: 'Kyverno policy-report pass rate',
  argocd_synced: 'Argo CD application Synced with Git',
  httproute_exposed: 'Reachable through an HTTPRoute',
  backup: 'Backup coverage (Velero Schedule / CNPG)',
}

export function platformSignalLabel(name: string): string {
  return PLATFORM_SIGNAL_LABEL[name] ?? name.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

/** The entity annotation the `scorecards` package defines as its join key. */
export const SCORECARD_ANNOTATION = 'adhar.io/scorecard'

/** Endpoint state, as the UI needs to talk about it. */
export interface PlatformScorecardsState {
  /** True only when the scorer's ConfigMap exists and parsed. */
  configured: boolean
  isLoading: boolean
  lastRun?: string
  weights?: Record<PlatformCategory, number>
  gradeThresholds?: Record<'A' | 'B' | 'C' | 'D', number>
  /** Services the scorer graded (whether or not the catalog knows them). */
  serviceCount: number
  averageScore?: number
  /** Of those, how many matched a catalog entity. */
  matched: number
  namespace: string
  configMap: string
  error?: string
  detail?: string
}

const UNCONFIGURED: PlatformScorecards = {
  configured: false,
  source: 'platform-scorer',
  namespace: 'adhar-system',
  configMap: 'adhar-scorecards',
  serviceCount: 0,
  services: [],
}

/**
 * Read the platform scorer's results. Never throws and never invents: any
 * failure (no BFF in a dev SPA, 403, unparseable body) resolves to
 * `configured: false` with the machine `error` code the server reported.
 */
export async function fetchPlatformScorecards(): Promise<PlatformScorecards> {
  let res: Response
  try {
    res = await fetch('/api/scorecards', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
  } catch (e) {
    return { ...UNCONFIGURED, error: 'unreachable', detail: e instanceof Error ? e.message : String(e) }
  }
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('application/json')) {
    // No BFF here (static dev SPA) — honest "not configured", not an error box.
    return { ...UNCONFIGURED, error: 'no_bff' }
  }
  let body: PlatformScorecards
  try {
    body = (await res.json()) as PlatformScorecards
  } catch {
    return { ...UNCONFIGURED, error: 'unreadable' }
  }
  if (res.status === 401) return { ...UNCONFIGURED, error: 'unauthenticated' }
  return {
    ...UNCONFIGURED,
    ...body,
    configured: body.configured === true,
    services: Array.isArray(body.services) ? body.services : [],
    serviceCount: typeof body.serviceCount === 'number' ? body.serviceCount : 0,
  }
}

/** `GET /api/scorecards`, refreshed on the scorer's own cadence (30 min job). */
export function usePlatformScorecards() {
  return useQuery({
    queryKey: ['platform-scorecards'],
    queryFn: fetchPlatformScorecards,
    refetchInterval: 120_000,
    staleTime: 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  })
}

/**
 * Build the synthetic entity for a service only the platform scorer knows
 * about. It carries EXACTLY what the scorer reported (name, namespace) and
 * nothing else — no owner, no description, no links — because nothing else is
 * known. Its scorecard has zero derived checks, so the catalog checks can
 * never read as "failing" for a service the catalog has never seen.
 */
function platformOnlyCard(rec: PlatformService): Scorecard {
  const namespace = rec.namespace || 'default'
  const entity: Entity = {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: rec.name,
      namespace,
      annotations: { [SCORECARD_ANNOTATION]: rec.name },
    },
    spec: { type: 'service' },
    origin: 'live',
  }
  const byCategory = {} as Record<CheckCategory, CategoryScore>
  for (const cat of CHECK_CATEGORIES) byCategory[cat] = { score: 0, pass: 0, total: 0 }
  return {
    entityRef: entityRef(entity),
    score: rec.score,
    grade: rec.grade,
    checks: [],
    byCategory,
    entity,
    source: 'platform',
    platform: rec,
    // No catalog entity → no derivation at all (the UI shows "—").
    platformOnly: true,
  }
}

/** The key a catalog entity joins the platform scorer on. */
function scorecardKey(e: Entity): string {
  return ann(e, SCORECARD_ANNOTATION) ?? e.metadata.name
}

export interface LiveScorecardsResult extends ScorecardsResult {
  platform: PlatformScorecardsState
}

/**
 * Scorecards for the whole fleet, platform scorer first.
 *
 *   • catalog entity + platform record → the platform score/grade wins, the
 *     catalog checks stay available in the drawer (they answer a different
 *     question: is this service *documented and owned*).
 *   • catalog entity only             → the console's own derivation, labelled.
 *   • platform record only            → a platform-only card (no derived checks).
 *
 * Nothing is merged numerically: one card shows one scorer's number, and says
 * which scorer it was.
 */
export function useLiveScorecards(): LiveScorecardsResult {
  const catalog = useScorecards()
  const q = usePlatformScorecards()
  const platform = q.data

  return useMemo(() => {
    const records = platform?.configured ? platform.services : []
    const byName = new Map(records.map((r) => [r.name, r]))
    const used = new Set<string>()

    const merged = catalog.scorecards.map((card) => {
      const rec = byName.get(scorecardKey(card.entity))
      if (!rec) return card
      used.add(rec.name)
      return {
        ...card,
        score: rec.score,
        grade: rec.grade,
        source: 'platform' as const,
        platform: rec,
      }
    })

    const orphans = records.filter((r) => !used.has(r.name)).map(platformOnlyCard)
    const scorecards = [...merged, ...orphans].sort(
      (a, b) => a.score - b.score || a.entityRef.localeCompare(b.entityRef),
    )

    return {
      scorecards,
      isLoading: catalog.isLoading,
      offline: catalog.offline,
      live: catalog.live,
      platform: {
        configured: platform?.configured === true,
        isLoading: q.isLoading,
        lastRun: platform?.lastRun,
        weights: platform?.weights,
        gradeThresholds: platform?.gradeThresholds,
        serviceCount: records.length,
        averageScore: platform?.averageScore,
        matched: used.size,
        namespace: platform?.namespace ?? UNCONFIGURED.namespace,
        configMap: platform?.configMap ?? UNCONFIGURED.configMap,
        error: platform?.error,
        detail: platform?.detail,
      },
    }
  }, [catalog.scorecards, catalog.isLoading, catalog.offline, catalog.live, platform, q.isLoading])
}

/** Fleet average per platform category, over the services the scorer graded. */
export function platformCategoryAverages(
  cards: Scorecard[],
): Array<{ cat: PlatformCategory; score: number | null; count: number }> {
  return PLATFORM_CATEGORIES.map((cat) => {
    const vals = cards
      .map((c) => c.platform?.categories?.[cat])
      .filter((v): v is number => typeof v === 'number')
    return {
      cat,
      score: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null,
      count: vals.length,
    }
  })
}
