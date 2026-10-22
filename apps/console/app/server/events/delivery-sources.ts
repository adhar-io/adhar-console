import {
  annotationsOf,
  condition,
  createdSince,
  get,
  imageLabel,
  type KubeObject,
  labelsOf,
  links,
  nameOf,
  nsOf,
  short,
  type Signal,
  type SignalContext,
  type Source,
} from './signal-kit.ts'

/**
 * The delivery lifecycle, as notifications: a build becomes freight, freight
 * is promoted to a stage, Argo CD syncs it, Argo Rollouts shifts traffic to
 * it, and the stage verifies it. Each step is a state transition on an object
 * that already exists — nothing here invents an event, it only decides which
 * transitions a person needs to hear about and words them in the app's name
 * rather than the CR's.
 *
 * Every source keys its signature on the identity of ONE occurrence (an Argo
 * CD operation's startedAt, a rollout's pod hash, a verification id, a
 * Promotion's uid), so one deploy produces one "started" and one outcome, and
 * a resync of the same state produces nothing.
 */

/* ─────────────────────────── Argo CD naming ─────────────────────────── */

/**
 * The human name of an Argo CD Application.
 *
 * Control-plane apps are named `<project>-<app>-<env>` (`adhar-qua-service-dev`)
 * and carry `adhar.io/application` + `adhar.io/environment`; a title should say
 * "qua-service (dev)". Platform packages carry neither and keep their own name.
 */
export function argoDisplay(obj: KubeObject): { app: string; env?: string; display: string; workload: boolean } {
  const l = labelsOf(obj)
  const app = l['adhar.io/application']
  const env = l['adhar.io/environment']
  if (!app) return { app: nameOf(obj), display: nameOf(obj), workload: false }
  return { app, env, display: env ? `${app} (${env})` : app, workload: true }
}

/* ─────────────────────────── Argo CD sync operations ─────────────────────────── */

type OpState = 'running' | 'succeeded' | 'failed'

function opState(phase?: string): OpState | null {
  if (phase === 'Running' || phase === 'Terminating') return 'running'
  if (phase === 'Succeeded') return 'succeeded'
  if (phase === 'Failed' || phase === 'Error') return 'failed'
  return null
}

const argocdSync: Source = {
  /**
   * One sync = one "started" + one outcome, keyed by the operation's
   * `startedAt` (retries inside one operation share it).
   *
   * Only for the platform's WORKLOAD apps (`adhar.io/application`). The ~80
   * platform packages all sync together on any push to the packages repo; a
   * start + result for each would be 160 notifications for one commit. For
   * those only a failed sync is news — the health source already says when
   * they are back to Synced + Healthy.
   */
  id: 'argocd-sync',
  group: 'argoproj.io',
  version: 'v1alpha1',
  resource: 'applications',
  signal(obj) {
    const op = get<{ phase?: string; startedAt?: string; message?: string; operation?: { initiatedBy?: { username?: string; automated?: boolean }; info?: Array<{ name?: string; value?: string }> }; syncResult?: { revision?: string } }>(obj, 'status.operationState')
    if (!op?.startedAt) return null
    const state = opState(op.phase)
    if (!state) return null
    const who = argoDisplay(obj)
    if (!who.workload && state !== 'failed') return null

    const name = nameOf(obj)
    const target = { type: 'application', id: name, label: who.display }
    const key = `argocd-sync:${nsOf(obj)}/${name}:${op.startedAt}:${state}`
    const by = op.operation?.initiatedBy
    const promotion = op.operation?.info?.find((i) => i.name === 'kargo.akuity.io/promotion')?.value
    const initiator = promotion ? `promotion ${promotion}` : by?.automated ? 'auto-sync' : by?.username ? by.username : 'unknown'
    const rev = short(op.syncResult?.revision ?? get<string>(obj, 'status.sync.revision'))
    const where = who.env ? ` to ${who.env}` : ''
    const base = { source: 'gitops' as const, target, href: links.argoApp(name), key }

    if (state === 'running') {
      return {
        signature: `${op.startedAt}/running`,
        doc: { ...base, kind: 'info', severity: 'low', title: `${who.app} sync${where} started`, description: `Started by ${initiator}.` },
      }
    }
    if (state === 'succeeded') {
      return {
        signature: `${op.startedAt}/succeeded`,
        doc: {
          ...base,
          kind: 'success',
          severity: 'low',
          title: `${who.app} synced${where}${rev ? ` at ${rev}` : ''}`,
          description: op.message ?? 'Sync succeeded.',
        },
      }
    }
    return {
      signature: `${op.startedAt}/failed`,
      doc: {
        ...base,
        kind: 'error',
        severity: 'high',
        title: `Sync of ${who.display} failed`,
        description: op.message ?? `Argo CD reports the sync as ${op.phase}.`,
        prompt: `The Argo CD sync of ${name} failed: ${op.message ?? op.phase}. Find the resource that failed to apply and tell me how to fix it.`,
      },
    }
  },
}

/* ─────────────────────────── Kargo ─────────────────────────── */

interface FreightRef {
  name?: string
  origin?: { kind?: string; name?: string }
  images?: Array<{ repoURL?: string; tag?: string; digest?: string }>
  commits?: Array<{ repoURL?: string; id?: string; tag?: string; message?: string }>
}

/** What a piece of freight carries, in one short phrase: an image, else a commit. */
function contentOf(f?: FreightRef): string | undefined {
  const img = imageLabel(f?.images?.[0])
  if (img) return img
  const c = f?.commits?.[0]
  if (c?.id) return `commit ${short(c.id)}`
  return c?.tag
}

/** Freight alias by name, maintained by the Freight watch for Promotion titles. */
const freightAliases = new Map<string, string>()
const MAX_ALIASES = 5_000
export const freightAliasOf = (name: string) => freightAliases.get(name)

const kargoFreight: Source = {
  /**
   * A new build of an app is available to promote — "new build
   * qua-service:72ad021 of qua-service is available". Only freight created
   * after the watcher started: everything a Warehouse discovered before a
   * console restart is history, not news.
   */
  id: 'kargo-freight',
  group: 'kargo.akuity.io',
  version: 'v1alpha1',
  resource: 'freights',
  observe(obj) {
    const alias = get<string>(obj, 'alias') ?? labelsOf(obj)['kargo.akuity.io/alias']
    if (!alias) return
    if (freightAliases.size >= MAX_ALIASES) {
      const oldest = freightAliases.keys().next().value
      if (oldest !== undefined) freightAliases.delete(oldest)
    }
    freightAliases.set(nameOf(obj), alias)
  },
  signal(obj, ctx) {
    if (!createdSince(obj, ctx)) return null
    const app = get<string>(obj, 'origin.name') ?? 'an application'
    const alias = get<string>(obj, 'alias') ?? labelsOf(obj)['kargo.akuity.io/alias']
    const content = contentOf(obj as FreightRef) ?? alias ?? short(nameOf(obj))
    return {
      signature: 'discovered',
      doc: {
        source: 'gitops',
        kind: 'info',
        severity: 'low',
        title: `New build ${content} of ${app} is available`,
        description: `Freight ${alias ?? short(nameOf(obj))} discovered by the ${app} warehouse in project ${nsOf(obj)}.`,
        href: links.releases(),
        key: `kargo-freight:${nsOf(obj)}/${nameOf(obj)}`,
        target: { type: 'freight', id: nameOf(obj), label: `${app} ${alias ?? short(nameOf(obj))}` },
      },
    }
  },
}

type PromoState = 'started' | 'succeeded' | 'failed' | 'aborted'

function promoState(phase?: string): PromoState | null {
  if (phase === 'Running') return 'started'
  if (phase === 'Succeeded') return 'succeeded'
  if (phase === 'Failed' || phase === 'Errored') return 'failed'
  if (phase === 'Aborted') return 'aborted'
  return null // Pending: queued behind another promotion — nothing has happened yet
}

const kargoPromotion: Source = {
  /**
   * "qua-service promoted to dev". A Promotion is one occurrence (its own
   * object), so its uid is the identity and the phase is the transition.
   */
  id: 'kargo-promotion',
  group: 'kargo.akuity.io',
  version: 'v1alpha1',
  resource: 'promotions',
  signal(obj, ctx) {
    const phase = get<string>(obj, 'status.phase')
    const state = promoState(phase)
    if (!state) return null
    const freight = get<FreightRef>(obj, 'status.freight')
    const freightName = freight?.name ?? get<string>(obj, 'spec.freight') ?? ''
    const app = freight?.origin?.name ?? 'freight'
    const stage = get<string>(obj, 'spec.stage') ?? labelsOf(obj)['kargo.akuity.io/stage'] ?? 'a stage'
    const alias = ctx?.freightAlias?.(freightName)
    const content = contentOf(freight)
    const what = [alias ? `freight ${alias}` : freightName ? `freight ${short(freightName)}` : '', content].filter(Boolean).join(' · ')
    const message = get<string>(obj, 'status.message')
    const base = {
      source: 'gitops' as const,
      href: links.releases(),
      key: `kargo-promotion:${nsOf(obj)}/${nameOf(obj)}:${state}`,
      target: { type: 'promotion', id: nameOf(obj), label: `${app} → ${stage}` },
    }
    switch (state) {
      case 'started':
        return { signature: 'started', doc: { ...base, kind: 'info', severity: 'low', title: `Promoting ${app} to ${stage}`, description: what || undefined } }
      case 'succeeded':
        return { signature: 'succeeded', doc: { ...base, kind: 'success', severity: 'low', title: `${app} promoted to ${stage}`, description: what || undefined } }
      case 'aborted':
        return { signature: 'aborted', doc: { ...base, kind: 'warning', severity: 'medium', title: `Promotion of ${app} to ${stage} was aborted`, description: message ?? (what || undefined) } }
      default:
        return {
          signature: 'failed',
          doc: {
            ...base,
            kind: 'error',
            severity: 'high',
            title: `Promotion of ${app} to ${stage} ${phase === 'Errored' ? 'errored' : 'failed'}`,
            description: message ?? (what || undefined),
            prompt: `The Kargo promotion ${nameOf(obj)} of ${app} to ${stage} ${phase?.toLowerCase()}${message ? `: ${message}` : ''}. Find the failing promotion step and tell me how to fix it.`,
          },
        }
    }
  },
}

interface Verification {
  id?: string
  phase?: string
  message?: string
  analysisRun?: { name?: string; namespace?: string; phase?: string }
}

/**
 * Which app a stage verification is about.
 *
 * A project Stage is SHARED by every app (requestedFreight lists each
 * warehouse), so the stage name alone does not say. The failing metric does —
 * the health template names metrics `<app>-rollout-healthy` — so the app whose
 * warehouse name the message mentions wins; a single-app collection is that
 * app; otherwise the last promotion's app, and failing that nobody.
 */
function verificationApp(obj: KubeObject, entry: { items?: Record<string, FreightRef> }, v: Verification): string | undefined {
  const apps = Object.values(entry.items ?? {}).map((f) => f.origin?.name).filter((x): x is string => Boolean(x))
  const msg = v.message ?? ''
  const named = apps.filter((a) => msg.includes(`"${a}-`) || msg.includes(` ${a} `) || msg.includes(`"${a}"`))
  if (named.length) return named.sort((a, b) => b.length - a.length)[0]
  if (apps.length === 1) return apps[0]
  return get<string>(obj, 'status.lastPromotion.freight.origin.name')
}

const kargoVerification: Source = {
  /**
   * The stage's verification of what it now holds — the AnalysisRun the
   * resilience gate and the health checks feed. Keyed by the verification id,
   * so each verification passes or fails exactly once; the failing metric's
   * own message is the description.
   */
  id: 'kargo-verification',
  group: 'kargo.akuity.io',
  version: 'v1alpha1',
  resource: 'stages',
  signal(obj) {
    const entry = get<Array<{ id?: string; items?: Record<string, FreightRef>; verificationHistory?: Verification[] }>>(obj, 'status.freightHistory')?.[0]
    const v = entry?.verificationHistory?.[0]
    if (!entry || !v?.id || !v.phase) return null
    const ok = v.phase === 'Successful'
    const bad = v.phase === 'Failed' || v.phase === 'Error' || v.phase === 'Inconclusive'
    const aborted = v.phase === 'Aborted'
    if (!ok && !bad && !aborted) return null // Pending / Running

    const stage = nameOf(obj)
    const app = verificationApp(obj, entry, v)
    const subject = app ? `${app} in ${stage}` : `stage ${stage}`
    const base = {
      source: 'gitops' as const,
      href: links.stages(),
      key: `kargo-verification:${nsOf(obj)}/${stage}:${v.id}:${v.phase}`,
      target: { type: 'stage', id: `${nsOf(obj)}/${stage}`, label: app ? `${app} · ${stage}` : stage },
    }
    if (ok) {
      return { signature: `${v.id}/${v.phase}`, doc: { ...base, kind: 'success', severity: 'low', title: `Verification passed for ${subject}`, description: v.message } }
    }
    if (aborted) {
      return { signature: `${v.id}/${v.phase}`, doc: { ...base, kind: 'warning', severity: 'medium', title: `Verification aborted for ${subject}`, description: v.message } }
    }
    return {
      signature: `${v.id}/${v.phase}`,
      doc: {
        ...base,
        kind: 'error',
        severity: 'high',
        title: `Verification failed for ${subject}`,
        description: v.message ?? `Verification ${v.phase}${v.analysisRun?.name ? ` (AnalysisRun ${v.analysisRun.name})` : ''}.`,
        prompt: `Kargo verification of ${subject} (project ${nsOf(obj)}) ${v.phase?.toLowerCase()}: ${v.message ?? 'no message'}${v.analysisRun?.name ? `. AnalysisRun ${v.analysisRun.namespace ?? nsOf(obj)}/${v.analysisRun.name}` : ''}. Explain why and what to fix before promoting further.`,
      },
    }
  },
}

/* ─────────────────────────── Argo Rollouts ─────────────────────────── */

interface CanaryStep {
  pause?: { duration?: string | number }
}

/** A pause that resumes on its own (a timed canary step) is not worth a notification. */
function indefinitePause(obj: KubeObject): boolean {
  const steps = get<CanaryStep[]>(obj, 'spec.strategy.canary.steps')
  const idx = get<number>(obj, 'status.currentStepIndex')
  if (steps && typeof idx === 'number') {
    const pause = steps[idx]?.pause
    if (pause && pause.duration !== undefined && pause.duration !== '') return false
  }
  return true
}

const rollouts: Source = {
  /**
   * A canary / blue-green rollout: started (a new pod hash is rolling out),
   * paused (waiting for a person — timed canary pauses are skipped), completed,
   * aborted or degraded. The pod hash is the revision's identity, so each
   * revision reports each state once.
   */
  id: 'argo-rollouts',
  group: 'argoproj.io',
  version: 'v1alpha1',
  resource: 'rollouts',
  signal(obj, ctx) {
    const phase = get<string>(obj, 'status.phase')
    const hash = get<string>(obj, 'status.currentPodHash')
    if (!phase || !hash) return null
    const stable = get<string>(obj, 'status.stableRS')
    const aborted = get<boolean>(obj, 'status.abort') === true
    const strategy = get<unknown>(obj, 'spec.strategy.blueGreen') ? 'blue-green' : 'canary'
    const l = labelsOf(obj)
    const app = l['adhar.io/application'] ?? l['app'] ?? l['app.kubernetes.io/name'] ?? nameOf(obj)
    const nsLabels = ctx?.namespaceLabels?.(nsOf(obj)) ?? {}
    const env = l['adhar.io/environment'] ?? nsLabels['adhar.io/environment'] ?? nsOf(obj)
    const scope = l['adhar.io/project'] ?? nsLabels['adhar.io/project'] ?? nsOf(obj)
    const revision = annotationsOf(obj)['rollout.argoproj.io/revision']
    const rev = revision ? ` (revision ${revision})` : ''
    const message = get<string>(obj, 'status.message')

    let state: 'started' | 'paused' | 'completed' | 'aborted' | 'degraded'
    if (aborted) state = 'aborted'
    else if (phase === 'Degraded') state = 'degraded'
    else if (phase === 'Paused') {
      if (!indefinitePause(obj)) return null
      state = 'paused'
    } else if (phase === 'Healthy') state = 'completed'
    else if (phase === 'Progressing' && stable && hash !== stable) state = 'started'
    else return null // scaling, or a first revision settling

    const base = {
      source: 'gitops' as const,
      href: links.rollout(scope, app, env),
      key: `rollout:${nsOf(obj)}/${nameOf(obj)}:${hash}:${state}`,
      target: { type: 'rollout', id: `${nsOf(obj)}/${nameOf(obj)}`, label: `${app} · ${env}` },
    }
    const signature = `${hash}/${state}`
    switch (state) {
      case 'started':
        return { signature, doc: { ...base, kind: 'info', severity: 'low', title: `${app} ${strategy} rollout started in ${env}${rev}` } }
      case 'paused': {
        const why = get<Array<{ reason?: string }>>(obj, 'status.pauseConditions')?.[0]?.reason
        return {
          signature,
          doc: {
            ...base,
            kind: 'warning',
            severity: 'medium',
            title: `${app} rollout paused in ${env}${rev}`,
            description: `Waiting to be promoted or aborted${why ? ` (${why})` : ''}.`,
          },
        }
      }
      case 'completed':
        return { signature, doc: { ...base, kind: 'success', severity: 'low', title: `${app} rolled out to ${env}${rev}` } }
      default: {
        const verb = state === 'aborted' ? 'aborted' : 'degraded'
        return {
          signature,
          doc: {
            ...base,
            kind: 'error',
            severity: 'high',
            title: `${app} rollout ${verb} in ${env}${rev}`,
            description: message ?? condition(obj, 'Progressing')?.message,
            prompt: `The Argo Rollout ${nsOf(obj)}/${nameOf(obj)} (${app} in ${env}) is ${verb}${message ? `: ${message}` : ''}. Diagnose why the new revision is not becoming healthy and tell me whether to abort, retry or fix forward.`,
          },
        }
      }
    }
  },
}

export const DELIVERY_SOURCES: Source[] = [argocdSync, kargoFreight, kargoPromotion, kargoVerification, rollouts]

/** Exported for the watcher's context. */
export type { Signal, SignalContext }
