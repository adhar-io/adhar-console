import type { NotificationDoc } from '../notify.ts'
import type { KubeObject as SaKubeObject } from '../k8s/sa-watch.ts'

/**
 * The shared vocabulary of the platform-event sources: what a source is, what
 * it may know when it judges an object, and the small readers every signal
 * function uses. Split out of `platform-events.ts` so the delivery and
 * control-plane sources can live in files of their own without importing the
 * watcher (and its database) to get a type.
 */

export type KubeObject = SaKubeObject

/**
 * A notification minus its timestamp. Not `Omit<NotificationDoc, 'at'>`: the
 * document has a string index signature, and `Omit` over one collapses every
 * named field to `unknown` — `doc.title` would stop being a string.
 */
export type SignalDoc = { [K in keyof NotificationDoc as K extends 'at' ? never : K]: NotificationDoc[K] }

/** One thing worth telling somebody about. */
export interface Signal {
  /** Stable per-object state; a notification is emitted only when this changes. */
  signature: string
  doc: SignalDoc
}

/**
 * What a signal function may know besides the object itself.
 *
 * Kept deliberately small, and every field optional, so the functions stay
 * pure and a test can hand them exactly the world it wants.
 */
export interface SignalContext {
  /**
   * When the watcher started (epoch ms). An object CREATED before this is not
   * news when it is first seen — that is a console restart or a relist, not a
   * thing that just happened. Defaults to 0 (everything is new).
   */
  since?: number
  /** The signature last recorded for this object by this source, if any. */
  previous?: string
  /** Labels of a namespace, from the watcher's periodic namespace read. */
  namespaceLabels?: (namespace: string) => Record<string, string> | undefined
  /** A Kargo Freight's human alias, from the Freight watch. */
  freightAlias?: (name: string) => string | undefined
}

export interface Source {
  id: string
  /** Empty string for core/v1. */
  group: string
  version: string
  resource: string
  /** Extra query parameters (field and label selectors). */
  search?: Record<string, string>
  /** Null when the object is in a state nobody needs to hear about. */
  signal(obj: KubeObject, ctx?: SignalContext): Signal | null
  /**
   * The object was DELETED (a watch frame, not a resync eviction — an object
   * deleted while the watch was down left nothing to describe). Optional:
   * most sources have nothing to say about a deletion.
   */
  removed?(obj: KubeObject, ctx?: SignalContext): Signal | null
  /**
   * Called for every object the watch delivers, priming included, before
   * `signal`. For sources that feed a lookup another source reads (Freight
   * aliases for Promotion titles). Must not emit anything.
   */
  observe?(obj: KubeObject): void
}

/* ─────────────────────────── readers ─────────────────────────── */

export const nameOf = (o: KubeObject) => o.metadata?.name ?? '<unnamed>'
export const nsOf = (o: KubeObject) => o.metadata?.namespace ?? ''
export const labelsOf = (o: KubeObject): Record<string, string> => o.metadata?.labels ?? {}
export const annotationsOf = (o: KubeObject): Record<string, string> => o.metadata?.annotations ?? {}

export function get<T>(obj: unknown, path: string): T | undefined {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur as T | undefined
}

export interface Condition {
  type?: string
  status?: string
  reason?: string
  message?: string
}

/** `status.conditions[type]`. */
export function condition(obj: KubeObject, type: string): Condition | undefined {
  return get<Condition[]>(obj, 'status.conditions')?.find((c) => c.type === type)
}

/**
 * True when the object was created after the watcher started.
 *
 * An object with no (or an unparseable) creationTimestamp is treated as old:
 * announcing "created" for something whose age is unknown is how a restart
 * floods the feed.
 */
export function createdSince(o: KubeObject, ctx: SignalContext | undefined): boolean {
  const ts = Date.parse(o.metadata?.creationTimestamp ?? '')
  if (Number.isNaN(ts)) return false
  return ts >= (ctx?.since ?? 0)
}

export const short = (sha?: string) => (sha ? sha.slice(0, 7) : '')

/** `harbor…/library/qua-service` + `72ad021fd…` → `qua-service:72ad021`. */
export function imageLabel(img?: { repoURL?: string; tag?: string; digest?: string }): string | undefined {
  if (!img?.repoURL) return undefined
  const repo = img.repoURL.split('/').pop() ?? img.repoURL
  const ref = img.tag ? (/^[0-9a-f]{40}$/.test(img.tag) ? short(img.tag) : img.tag) : img.digest?.replace(/^sha256:/, '').slice(0, 12)
  return ref ? `${repo}:${ref}` : repo
}

/** Bucket a repeat count so a recurring thing escalates instead of repeating. */
export function countBucket(count: number): string {
  return count >= 100 ? '100+' : count >= 10 ? '10+' : '1'
}

/* ─────────────────────────── console links ─────────────────────────── */

const enc = encodeURIComponent

/**
 * Every deep link a platform notification uses, in one place, so a route that
 * moves is one edit — and so the tests can assert on them without each source
 * restating the URL grammar of a view it does not own.
 */
export const links = {
  argoApp: (name: string) => `/deliver?section=apps&app=${enc(name)}`,
  build: (ns: string, name: string) => `/develop?section=builds&run=${enc(`${ns}/${name}`)}`,
  releases: () => '/deliver?section=releases',
  stages: () => '/deliver?section=stages',
  rollout: (scope: string, app: string, env?: string) =>
    `/deliver?section=rollouts&app=${enc(`${scope}/${app}`)}${env ? `&env=${enc(env)}` : ''}`,
  component: (app: string) => `/catalog?entity=${enc(`component:${app}`)}&tab=deploy`,
  readiness: (app: string) => `/deliver?section=performance&view=readiness&app=${enc(app)}`,
  nodes: () => '/platform?section=nodes',
  events: (ns: string) => `/platform?section=events&namespace=${enc(ns)}`,
  projectEnvironments: (project: string) => `/deliver?section=environments&project=${enc(project)}`,
}
