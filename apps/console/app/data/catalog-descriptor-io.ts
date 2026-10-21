import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { gitea } from '@adhar/api-clients'
import { useToolPublicUrl } from '@adhar/shell-ui'
import type { Entity } from './catalog.ts'
import { resolveRepoSource } from './catalog-docs.ts'
import {
  catalogInfoPath,
  createLimiter,
  type Descriptor,
  descriptorKey,
  type DescriptorTarget,
  withDescriptor,
} from './catalog-descriptor.ts'

/**
 * Reading `catalog-info.yaml` descriptors from Gitea (through the console's
 * `/api/svc/gitea` proxy) for the catalog overlay — the I/O half of
 * catalog-descriptor.ts.
 *
 * One React Query entry per descriptor (`descriptorKey`), shared by every
 * consumer: the catalog (`useCatalog` → `useDescriptorOverlay`), Scorecards
 * (which grade the enriched catalog) and the scorecard fix dialog
 * (`useDescriptor`, whose Re-evaluate invalidates that one key).
 *
 *   • bounded: at most 4 reads in flight; the one entity a person has open
 *     jumps the queue;
 *   • cached: 5 min fresh, 30 min kept — a repository WITHOUT a descriptor is
 *     cached too (`exists: false`), so it costs one 404 per 5 minutes;
 *   • never blocking: entities render as the live sources describe them and
 *     are enriched in place as each descriptor arrives. A failed read leaves
 *     the entity as it was.
 */

const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' })

/** At most this many descriptor reads in flight across the whole console. */
export const DESCRIPTOR_CONCURRENCY = 4
const limiter = createLimiter(DESCRIPTOR_CONCURRENCY)

export const DESCRIPTOR_STALE_MS = 5 * 60_000

export type { Descriptor, DescriptorTarget }
export { descriptorKey }

function unb64(s: string): string {
  const bin = atob(s.replace(/\s/g, ''))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

/** Where a Gitea-backed entity's descriptor lives; null when it has no Gitea repo. */
export function descriptorTarget(entity: Entity, giteaPublicUrl: string): DescriptorTarget | null {
  if (entity.origin === 'registered') return null
  const src = resolveRepoSource(entity, giteaPublicUrl)
  if (!src || src.kind !== 'gitea' || !src.org || !src.repo) return null
  return { org: src.org, repo: src.repo, ref: src.refExplicit ? src.ref : '', path: catalogInfoPath(entity, src.dir) }
}

async function readDescriptor(t: DescriptorTarget, signal?: AbortSignal): Promise<Descriptor> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  try {
    const f = await giteaClient.getFile(t.org, t.repo, t.ref, t.path)
    const text = f.encoding === 'base64' ? unb64(f.content) : f.content
    return { ...t, exists: true, text, sha: f.sha ?? null }
  } catch (e) {
    if ((e as { status?: number } | null)?.status === 404) return { ...t, exists: false, text: null, sha: null }
    throw e
  }
}

export function descriptorQuery(t: DescriptorTarget, urgent = false) {
  return {
    queryKey: descriptorKey(t),
    queryFn: ({ signal }: { signal?: AbortSignal }) => limiter.run(() => readDescriptor(t, signal), urgent),
    staleTime: DESCRIPTOR_STALE_MS,
    gcTime: 30 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  }
}

/**
 * Descriptors of the given entities, keyed by `keyOf(entity)`. Unread and
 * failed reads are simply absent.
 */
export function useDescriptors(entities: readonly Entity[], keyOf: (e: Entity) => string): Map<string, Descriptor> {
  const giteaUrl = useToolPublicUrl('gitea') ?? ''
  const targets = useMemo(() => {
    const out: Array<{ key: string; t: DescriptorTarget }> = []
    if (!giteaUrl) return out
    for (const e of entities) {
      const t = descriptorTarget(e, giteaUrl)
      if (t) out.push({ key: keyOf(e), t })
    }
    return out
  }, [entities, giteaUrl, keyOf])
  const results = useQueries({ queries: targets.map(({ t }) => descriptorQuery(t)) })
  const datas = results.map((r) => r.data)
  // useQueries hands back a new array every render; re-key only on a real change.
  const sig = datas.map((d) => (d ? `${d.exists ? 1 : 0}${d.sha ?? '-'}` : '')).join('|')
  return useMemo(() => {
    const out = new Map<string, Descriptor>()
    targets.forEach(({ key }, i) => {
      const d = datas[i]
      if (d) out.set(key, d)
    })
    return out
    // `datas` is captured through `sig`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, sig])
}

/**
 * The entities with their descriptors overlaid. Returns the input array itself
 * until at least one descriptor applies, so nothing re-renders for repositories
 * without one.
 */
export function useDescriptorOverlay(entities: Entity[], keyOf: (e: Entity) => string): Entity[] {
  const descriptors = useDescriptors(entities, keyOf)
  return useMemo(() => {
    let changed = false
    const out = entities.map((e) => {
      const d = descriptors.get(keyOf(e))
      if (!d?.exists) return e
      changed = true
      return withDescriptor(e, d)
    })
    return changed ? out : entities
  }, [entities, descriptors, keyOf])
}

/**
 * The descriptor of one entity (shares the cache with the catalog overlay).
 * Pass the entity as the catalog shows it — the overlay never changes where
 * the descriptor lives, so the key is the same either way.
 */
export function useDescriptor(entity: Entity | undefined) {
  const giteaUrl = useToolPublicUrl('gitea') ?? ''
  const raw = entity ? descriptorTarget(entity, giteaUrl) : null
  const key = raw ? descriptorKey(raw).join('\u0000') : ''
  // Stable identity across renders (the entity object is rebuilt on every refresh).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const t = useMemo(() => raw, [key])
  const q = useQuery({
    ...descriptorQuery(t ?? { org: '', repo: '', ref: '', path: '' }, true),
    enabled: !!t,
  })
  return { target: t, descriptor: t ? q.data : undefined, isLoading: !!t && q.isLoading, error: q.error }
}
