import { useMemo } from 'react'
import {
  type Entity,
  type EntityKind,
  type EntityMetadata,
  entityRef,
  type EntityRef,
  parseRef,
  useCatalog,
} from './catalog.ts'

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

export interface Scorecard {
  entityRef: EntityRef
  /** Weighted pass ratio, 0–100. */
  score: number
  grade: Grade
  checks: Check[]
  byCategory: Record<CheckCategory, CategoryScore>
  /** The scored entity — handy for tables (name / kind / owner columns). */
  entity: Entity
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
