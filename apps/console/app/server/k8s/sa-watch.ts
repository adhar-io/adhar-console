import { apiServerFetch } from './gateway.ts'

/**
 * A long-lived, self-healing `list + watch` against the apiserver, running as
 * the console's own ServiceAccount.
 *
 * This is the machinery behind every server-owned index in the console — the
 * notification watcher and the platform knowledge graph — and it is extracted
 * rather than copied because the interesting parts are the failure paths, and
 * having two subtly different copies of those is how one of them ends up
 * wrong. (It already did once: a relist that re-primed silently swallowed
 * every transition that happened while the watch was disconnected.)
 *
 * Distinct from `live.ts`, which multiplexes watches *for a browser client*
 * using that user's token. These watches belong to the server, run whether or
 * not anyone is looking, and see the whole cluster — so anything built on them
 * must filter by the viewer's access on the way out.
 *
 * The contract:
 *
 *   • The FIRST list primes. `upsert` is called with `priming: true` so an
 *     index can fill without the side effects a real change would have.
 *   • Every LATER list is a resync after the watch dropped. `upsert` runs with
 *     `priming: false` — anything that changed while disconnected must be
 *     caught here or it is lost — and then `resynced` is called with the keys
 *     that exist, so an index can drop objects deleted behind its back.
 *   • 404 disables the source: the CRD is not installed, which is a fact about
 *     the cluster, not an error to retry forever.
 *   • 401/403 disables it with an RBAC hint, for the same reason.
 *   • Anything else is transient and retried with capped exponential backoff.
 */

export interface KubeMeta {
  uid?: string
  name?: string
  namespace?: string
  resourceVersion?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  creationTimestamp?: string
  ownerReferences?: Array<{ apiVersion?: string; kind?: string; name?: string; uid?: string; controller?: boolean }>
  deletionTimestamp?: string
}

export interface KubeObject {
  apiVersion?: string
  kind?: string
  metadata?: KubeMeta
  [k: string]: unknown
}

interface WatchFrame {
  type?: 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR'
  object?: KubeObject
}

export interface WatchSpec {
  /** Short name used in logs. */
  id: string
  /** Empty string for core/v1. */
  group: string
  version: string
  resource: string
  /** Extra query parameters, e.g. a field selector. */
  search?: Record<string, string>
  /** Page size for the priming list. */
  limit?: number
}

export interface WatchHandlers {
  /**
   * An object exists, or changed. `priming` is true only during the very
   * first list — the one that establishes the baseline.
   */
  upsert(obj: KubeObject, ctx: { priming: boolean }): void | Promise<void>
  /** An object is gone. */
  remove(obj: KubeObject): void
  /**
   * A resync list finished. `seen` holds every key the list returned, so an
   * index can evict what is no longer there. Never called for the first list:
   * before priming there is nothing to evict.
   */
  resynced?(seen: Set<string>): void
  /** The first list landed. */
  ready?(count: number): void
}

/** The identity used for index keys. Stable across updates; unique per object. */
export function objectKey(o: KubeObject): string {
  return o.metadata?.uid ?? `${o.metadata?.namespace ?? ''}/${o.metadata?.name ?? ''}`
}

const WATCH_TIMEOUT_SECONDS = '540'
const MAX_BACKOFF_MS = 60_000

export function resourcePath(spec: WatchSpec): string {
  const root = spec.group ? `/apis/${spec.group}/${spec.version}` : `/api/${spec.version}`
  return `${root}/${spec.resource}`
}

/**
 * Run one watch until `stopped()`. Resolves when the source is disabled or
 * stopped; never rejects.
 */
export async function runWatch(
  spec: WatchSpec,
  token: string,
  handlers: WatchHandlers,
  stopped: () => boolean,
  log: (msg: string) => void = (m) => console.log(m),
): Promise<void> {
  const path = resourcePath(spec)
  let backoff = 1_000
  let primed = false

  while (!stopped()) {
    try {
      const listQuery = new URLSearchParams({
        limit: String(spec.limit ?? 2000),
        ...(spec.search ?? {}),
      })
      const listRes = await apiServerFetch(token, path, { search: `?${listQuery}` })
      if (!listRes.ok) {
        if (listRes.status === 404) {
          log(`[watch] ${spec.id}: not installed on this cluster — source disabled`)
          return
        }
        if (listRes.status === 401 || listRes.status === 403) {
          log(
            `[watch] ${spec.id}: the console ServiceAccount may not list ${spec.resource} (${listRes.status}) — source disabled`,
          )
          return
        }
        throw new Error(`list failed (${listRes.status})`)
      }

      const list = (await listRes.json()) as {
        items?: KubeObject[]
        metadata?: { resourceVersion?: string }
      }
      const items = list.items ?? []
      const seen = new Set<string>()
      for (const obj of items) {
        seen.add(objectKey(obj))
        await handlers.upsert(obj, { priming: !primed })
      }

      if (!primed) {
        primed = true
        handlers.ready?.(items.length)
        log(`[watch] ${spec.id}: watching (${items.length} objects primed)`)
      } else {
        // Objects deleted while the watch was down produced no DELETED frame
        // anyone saw. Without this an index keeps them forever.
        handlers.resynced?.(seen)
      }

      const watchQuery = new URLSearchParams({
        watch: '1',
        resourceVersion: list.metadata?.resourceVersion ?? '',
        timeoutSeconds: WATCH_TIMEOUT_SECONDS,
        allowWatchBookmarks: 'true',
        ...(spec.search ?? {}),
      })
      const watchRes = await apiServerFetch(token, path, { search: `?${watchQuery}` })
      if (!watchRes.ok || !watchRes.body) throw new Error(`watch failed (${watchRes.status})`)

      // Only reset the backoff once a watch is actually established, so a
      // source that lists fine but cannot stream does not spin at 1s forever.
      backoff = 1_000
      const reader = watchRes.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffered = ''
      while (!stopped()) {
        const { value, done } = await reader.read()
        if (done) break
        buffered += value
        // The apiserver emits one JSON object per line.
        let nl = buffered.indexOf('\n')
        while (nl >= 0) {
          const line = buffered.slice(0, nl).trim()
          buffered = buffered.slice(nl + 1)
          nl = buffered.indexOf('\n')
          if (!line) continue
          let frame: WatchFrame
          try {
            frame = JSON.parse(line) as WatchFrame
          } catch {
            continue
          }
          if (frame.type === 'ERROR') throw new Error('watch stream reported ERROR — relisting')
          if (!frame.object || frame.type === 'BOOKMARK') continue
          if (frame.type === 'DELETED') {
            handlers.remove(frame.object)
            continue
          }
          await handlers.upsert(frame.object, { priming: false })
        }
      }
    } catch (e) {
      if (stopped()) return
      log(`[watch] ${spec.id}: ${e instanceof Error ? e.message : String(e)} — retrying in ${backoff}ms`)
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
    }
  }
}
