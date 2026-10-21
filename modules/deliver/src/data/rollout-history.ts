import { type ContainerImage, templateImages } from './rollout-apps.ts'

/**
 * A Rollout's history, read from what the cluster keeps of it.
 *
 * Argo Rollouts keeps one ReplicaSet per revision it has rolled out (up to
 * `revisionHistoryLimit`, default 10), annotated `rollout.argoproj.io/revision`
 * and labelled with the pod-template hash; each AnalysisRun it started is
 * labelled with that same hash. That is enough to answer, per revision: what
 * image it ran, when it started, whether it ever became stable, what its
 * analysis said, and what rolling back to it would change.
 *
 * What the cluster does not keep is said as such — nothing here is invented.
 * In particular "aborted" is only claimed with evidence: a failed analysis, the
 * live abort flag, or a revision newer than the stable one that is no longer
 * current (it never got promoted).
 *
 * JSX-free and fetch-free so it is unit-tested.
 */

type Loose = Record<string, unknown>
const asObj = (v: unknown): Loose | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : undefined
const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const asNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const ms = (t?: string): number | undefined => {
  if (!t) return undefined
  const n = Date.parse(t)
  return Number.isFinite(n) ? n : undefined
}

export const REVISION = 'rollout.argoproj.io/revision'
export const REVISION_HISTORY = 'rollout.argoproj.io/revision-history'
export const SCALE_DOWN_DEADLINE = 'scale-down-deadline'
export const HASH_LABEL = 'rollouts-pod-template-hash'
/** Argo Rollouts' default `scaleDownDelaySeconds` — the deadline is set this far after the switch. */
const SCALE_DOWN_DELAY_MS = 30_000

/** The minimal Kubernetes object read here (ReplicaSet, AnalysisRun, Rollout). */
export interface KubeLike {
  metadata: {
    name: string
    namespace?: string
    uid?: string
    creationTimestamp?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    ownerReferences?: Array<{ kind?: string; name?: string; uid?: string }>
  }
  spec?: Record<string, unknown>
  status?: Record<string, unknown>
}

export type HistoryOutcome =
  /** Current and stable — what is running now. */
  | 'live'
  /** Current but not yet stable — the rollout shown in full above. */
  | 'in-flight'
  /** An older revision still taking the stable side while a newer one rolls out. */
  | 'stable'
  /** Became stable, then a newer revision replaced it. */
  | 'superseded'
  /** Stopped: a failed analysis, an abort, or replaced before it was ever promoted. */
  | 'aborted'
  /** Its pods could not run (ReplicaFailure / the rollout is Degraded on it). */
  | 'degraded'

export interface MetricResult {
  name: string
  phase: string
  successful: number
  failed: number
  inconclusive: number
  error: number
  count: number
  /** The latest measurement's value, as Argo recorded it. */
  lastValue?: string
  message?: string
}

export interface AnalysisSummary {
  name: string
  phase: string
  /** Step / Background / PrePromotion / PostPromotion, from `rollout-type`. */
  type?: string
  step?: number
  startedAt?: string
  finishedAt?: string
  message?: string
  metrics: MetricResult[]
}

export interface ImageChange {
  container: string
  /** The image this entry runs (undefined: the container is new in current). */
  entry?: ContainerImage
  /** The image current runs (undefined: current dropped this container). */
  current?: ContainerImage
}

export interface SyncTrigger {
  revision: string
  shortRevision: string
  by?: string
  automated?: boolean
  at?: string
}

export interface HistoryEntry {
  revision: number
  /** Older revision numbers this template was rolled out under (rollbacks reuse a ReplicaSet). */
  reusedFrom: number[]
  hash?: string
  replicaSet: string
  images: ContainerImage[]
  createdAt?: string
  replicas: { desired: number; ready: number; available: number }
  current: boolean
  outcome: HistoryOutcome
  /** Why the outcome says what it says, in a sentence. */
  outcomeReason: string
  /** Creation → stable, when the cluster recorded the moment it became stable. */
  rolledOutMs?: number
  /** When a newer revision took over from it. */
  replacedAt?: string
  /** How long it served before it was replaced. */
  servedMs?: number
  analyses: AnalysisSummary[]
  trigger?: SyncTrigger
  /** What would change if this revision were restored (empty: same images as current). */
  diff: ImageChange[]
  /** The ReplicaSet's pod template — what an undo restores. */
  template?: Loose
}

/** The rollout fields history derivation reads. */
export interface RolloutLike extends KubeLike {
  status?: Loose & { currentPodHash?: string; stableRS?: string; abort?: boolean; phase?: string }
}

/** An Argo CD sync history entry (`Application.status.history`). */
export interface ArgoHistoryLike {
  id: number
  revision?: string
  revisions?: string[]
  deployedAt?: string
  deployStartedAt?: string
  initiatedBy?: { username?: string; automated?: boolean }
}

export function ownedBy(obj: KubeLike, rollout: KubeLike): boolean {
  return (obj.metadata.ownerReferences ?? []).some((o) =>
    o.kind === 'Rollout' && (rollout.metadata.uid && o.uid ? o.uid === rollout.metadata.uid : o.name === rollout.metadata.name)
  )
}

export function readAnalysisRun(a: KubeLike): AnalysisSummary {
  const st = asObj(a.status) ?? {}
  const labels = a.metadata.labels ?? {}
  const step = Number(labels['step-index'])
  const metrics = asArr(st.metricResults).map((m) => {
    const o = asObj(m) ?? {}
    const measurements = asArr(o.measurements).map((x) => asObj(x) ?? {})
    const last = measurements[measurements.length - 1]
    return {
      name: asStr(o.name) ?? 'metric',
      phase: asStr(o.phase) ?? 'Pending',
      successful: asNum(o.successful) ?? 0,
      failed: asNum(o.failed) ?? 0,
      inconclusive: asNum(o.inconclusive) ?? 0,
      error: asNum(o.error) ?? 0,
      count: asNum(o.count) ?? measurements.length,
      lastValue: last ? asStr(last.value) : undefined,
      message: asStr(o.message) ?? (last ? asStr(last.message) : undefined),
    }
  })
  const finished = asArr(st.metricResults)
    .flatMap((m) => asArr(asObj(m)?.measurements))
    .map((x) => asStr(asObj(x)?.finishedAt))
    .filter((t): t is string => Boolean(t))
    .sort()
  const phase = asStr(st.phase) ?? 'Pending'
  return {
    name: a.metadata.name,
    phase,
    type: labels['rollout-type'],
    step: Number.isFinite(step) && labels['step-index'] !== undefined ? step : undefined,
    startedAt: asStr(st.startedAt) ?? a.metadata.creationTimestamp,
    finishedAt: phase === 'Running' || phase === 'Pending' ? undefined : finished[finished.length - 1],
    message: asStr(st.message),
    metrics,
  }
}

const FAILED_ANALYSIS = new Set(['Failed', 'Error'])

export function imageDiff(entry: ContainerImage[], current: ContainerImage[]): ImageChange[] {
  const names = [...new Set([...entry.map((i) => i.container), ...current.map((i) => i.container)])]
  return names
    .map((container) => ({
      container,
      entry: entry.find((i) => i.container === container),
      current: current.find((i) => i.container === container),
    }))
    .filter((c) => c.entry?.image !== c.current?.image)
}

/** The Argo CD sync that most plausibly created this ReplicaSet. */
export function matchTrigger(createdAt: string | undefined, history: ArgoHistoryLike[]): SyncTrigger | undefined {
  const created = ms(createdAt)
  if (created === undefined) return undefined
  let best: { h: ArgoHistoryLike; at: number } | undefined
  for (const h of history) {
    const start = ms(h.deployStartedAt) ?? ms(h.deployedAt)
    if (start === undefined) continue
    // The sync starts before the ReplicaSet exists (allow clock skew), and a
    // sync more than 15 minutes earlier did not create it.
    if (start > created + 60_000 || created - start > 15 * 60_000) continue
    if (!best || start > best.at) best = { h, at: start }
  }
  if (!best) return undefined
  const revision = best.h.revisions?.find(Boolean) ?? best.h.revision
  if (!revision) return undefined
  return {
    revision,
    shortRevision: /^[0-9a-f]{40}$/i.test(revision) ? revision.slice(0, 7) : revision,
    by: best.h.initiatedBy?.username,
    automated: best.h.initiatedBy?.automated,
    at: best.h.deployedAt ?? best.h.deployStartedAt,
  }
}

function completedAt(rollout: RolloutLike): number | undefined {
  const conds = asArr(rollout.status?.conditions).map((c) => asObj(c) ?? {})
  const c = conds.find((x) => x.type === 'Completed' && x.status === 'True') ??
    conds.find((x) => x.type === 'Healthy' && x.status === 'True')
  return ms(asStr(c?.lastTransitionTime))
}

export interface DeriveInput {
  rollout: RolloutLike
  replicaSets: KubeLike[]
  analysisRuns?: KubeLike[]
  argoHistory?: ArgoHistoryLike[]
}

/** Every revision of the rollout, newest first. */
export function deriveHistory({ rollout, replicaSets, analysisRuns = [], argoHistory = [] }: DeriveInput): HistoryEntry[] {
  const st = rollout.status ?? {}
  const currentHash = asStr(st.currentPodHash)
  const stableHash = asStr(st.stableRS)
  const aborted = Boolean(st.abort)
  const degraded = st.phase === 'Degraded'
  const currentTemplate = asObj(asObj(rollout.spec)?.template)
  const currentImages = templateImages(currentTemplate)

  const owned = replicaSets.filter((rs) => ownedBy(rs, rollout))
  const runs = analysisRuns.filter((a) => ownedBy(a, rollout)).map((a) => ({ a, s: readAnalysisRun(a) }))

  const base = owned
    .map((rs) => {
      const ann = rs.metadata.annotations ?? {}
      const revision = Number(ann[REVISION])
      const hash = rs.metadata.labels?.[HASH_LABEL]
      const spec = asObj(rs.spec) ?? {}
      const status = asObj(rs.status) ?? {}
      const template = asObj(spec.template)
      return {
        rs,
        revision: Number.isFinite(revision) ? revision : 0,
        reusedFrom: (ann[REVISION_HISTORY] ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0),
        hash,
        template,
        images: templateImages(template),
        createdAt: rs.metadata.creationTimestamp,
        scaleDownAt: ms(ann[SCALE_DOWN_DEADLINE]),
        replicas: {
          desired: asNum(spec.replicas) ?? 0,
          ready: asNum(status.readyReplicas) ?? 0,
          available: asNum(status.availableReplicas) ?? 0,
        },
        replicaFailure: asArr(status.conditions).some((c) => asObj(c)?.type === 'ReplicaFailure' && asObj(c)?.status === 'True'),
        analyses: runs
          .filter(({ a }) => hash && a.metadata.labels?.[HASH_LABEL] === hash)
          .map(({ s }) => s)
          .sort((x, y) => (y.startedAt ?? '').localeCompare(x.startedAt ?? '')),
      }
    })
    .sort((a, b) => b.revision - a.revision || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))

  const stableRevision = base.find((b) => b.hash && b.hash === stableHash)?.revision

  const classified = base.map((b) => {
    const current = Boolean(b.hash && b.hash === currentHash)
    const isStable = Boolean(b.hash && b.hash === stableHash)
    const failedAnalysis = b.analyses.find((a) => FAILED_ANALYSIS.has(a.phase))

    let outcome: HistoryOutcome
    let outcomeReason: string
    if (current) {
      if (aborted) {
        outcome = 'aborted'
        outcomeReason = failedAnalysis
          ? `Aborted after analysis ${failedAnalysis.name} ${failedAnalysis.phase.toLowerCase()}.`
          : 'Aborted — traffic is back on the stable revision.'
      } else if (degraded || b.replicaFailure) {
        outcome = 'degraded'
        outcomeReason = 'The rollout is degraded on this revision.'
      } else if (isStable) {
        outcome = 'live'
        outcomeReason = 'Fully promoted — this is what is running.'
      } else {
        outcome = 'in-flight'
        outcomeReason = 'Rolling out now.'
      }
    } else if (isStable) {
      outcome = 'stable'
      outcomeReason = 'Still serving the stable side while the newer revision rolls out.'
    } else if (failedAnalysis) {
      outcome = 'aborted'
      outcomeReason = `Analysis ${failedAnalysis.name} ${failedAnalysis.phase.toLowerCase()} — the rollout was aborted.`
    } else if (b.replicaFailure) {
      outcome = 'degraded'
      outcomeReason = 'Its pods could not be created (ReplicaFailure).'
    } else if (stableRevision !== undefined && b.revision > stableRevision) {
      // Newer than what is stable and no longer current: it never got promoted.
      outcome = 'aborted'
      outcomeReason = 'Never promoted — replaced before the rollout finished.'
    } else {
      outcome = 'superseded'
      outcomeReason = 'Was stable, then replaced by a newer revision.'
    }
    return { ...b, current, outcome, outcomeReason }
  })

  /** Revisions that served as stable at some point, in the same newest-first order. */
  const servedStable = (o: HistoryOutcome) => o === 'live' || o === 'stable' || o === 'superseded'
  /** When a stable revision was replaced: its scale-down deadline minus the delay. */
  const switchedAwayAt = (b: (typeof classified)[number]) =>
    b.scaleDownAt !== undefined ? b.scaleDownAt - SCALE_DOWN_DELAY_MS : undefined

  return classified.map((b, i): HistoryEntry => {
    const created = ms(b.createdAt)

    // When did this revision become stable? The live one: the rollout's
    // Completed condition. An older one: when the stable revision before it
    // (aborted ones never were) was marked for scale-down.
    let stableAt: number | undefined
    if (b.outcome === 'live') stableAt = completedAt(rollout)
    else if (b.outcome === 'superseded' || b.outcome === 'stable') {
      const previous = classified.slice(i + 1).find((p) => servedStable(p.outcome))
      stableAt = previous ? switchedAwayAt(previous) : undefined
    }
    const rolledOutMs = created !== undefined && stableAt !== undefined && stableAt >= created ? stableAt - created : undefined

    // When it was replaced: its own scale-down deadline, else the creation of
    // the next newer revision that went on to serve.
    let replacedMs: number | undefined
    if (b.outcome === 'superseded') {
      replacedMs = switchedAwayAt(b) ??
        ms(classified.slice(0, i).reverse().find((n) => servedStable(n.outcome) || n.outcome === 'in-flight')?.createdAt)
    }
    const servedFrom = stableAt ?? created
    const servedMs = replacedMs !== undefined && servedFrom !== undefined ? Math.max(0, replacedMs - servedFrom) : undefined

    return {
      revision: b.revision,
      reusedFrom: b.reusedFrom,
      hash: b.hash,
      replicaSet: b.rs.metadata.name,
      images: b.images,
      createdAt: b.createdAt,
      replicas: b.replicas,
      current: b.current,
      outcome: b.outcome,
      outcomeReason: b.outcomeReason,
      rolledOutMs,
      replacedAt: replacedMs !== undefined ? new Date(replacedMs).toISOString() : undefined,
      servedMs,
      analyses: b.analyses,
      trigger: matchTrigger(b.createdAt, argoHistory),
      diff: b.current ? [] : imageDiff(b.images, currentImages),
      template: b.template,
    }
  })
}

/* ─────────── rollback ─────────── */

/**
 * The template `kubectl argo rollouts undo` writes back: the ReplicaSet's pod
 * template without the hash label the controller added to it.
 */
export function undoTemplate(template: Loose): Loose {
  const copy = JSON.parse(JSON.stringify(template)) as Loose
  const meta = asObj(copy.metadata)
  const labels = asObj(meta?.labels)
  if (labels) delete labels[HASH_LABEL]
  return copy
}

/** JSON patch restoring a revision's template on the Rollout. */
export function undoPatch(template: Loose): Array<{ op: 'replace'; path: string; value: unknown }> {
  return [{ op: 'replace', path: '/spec/template', value: undoTemplate(template) }]
}

/**
 * Whether the console can restore this revision itself. A Rollout that points
 * at a Deployment (`workloadRef`) has no template of its own to replace.
 */
export function canUndoInConsole(rollout: RolloutLike, entry: HistoryEntry): boolean {
  const spec = asObj(rollout.spec) ?? {}
  return !entry.current && Boolean(entry.template) && !spec.workloadRef && Boolean(spec.template)
}

export function undoCommand(namespace: string, name: string, revision: number): string {
  return `kubectl argo rollouts undo ${name} -n ${namespace} --to-revision=${revision}`
}

/* ─────────── formatting ─────────── */

export function formatDuration(msValue: number | undefined): string | undefined {
  if (msValue === undefined) return undefined
  const s = Math.round(msValue / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 && m < 10 ? `${m}m ${s % 60}s` : `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 && d < 7 ? `${d}d ${h % 24}h` : `${d}d`
}

export const OUTCOME_LABEL: Record<HistoryOutcome, string> = {
  live: 'Live',
  'in-flight': 'Rolling out',
  stable: 'Stable',
  superseded: 'Superseded',
  aborted: 'Aborted',
  degraded: 'Degraded',
}
