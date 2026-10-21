import type { YamlValue } from '@adhar/utils'
import type { Entity, Lifecycle, Link } from './catalog.ts'
import { asArray, asRecord, getPath, parseDocs } from './scorecard-yaml-edit.ts'

/**
 * A repository's `catalog-info.yaml` (its "descriptor") overlaid on the live
 * catalog entity — the pure half. The catalog data layer (`useCatalog`) reads
 * each Gitea-backed entity's descriptor (catalog-descriptor-io.ts) and applies
 * `overlayDescriptor`, so the drawer, filters, Teams overview and Scorecards all
 * see the same, declared, entity.
 */

/* ─────────── where the descriptor lives ─────────── */

/**
 * Path of the entity's `catalog-info.yaml` inside its repository: the
 * `backstage.io/managed-by-location` (or `-origin-location`) annotation when it
 * names a file in that repo, else `<dir>/catalog-info.yaml`, else the root.
 */
export function catalogInfoPath(entity: Entity, dir = ''): string {
  const ann = entity.metadata.annotations ?? {}
  for (const key of ['backstage.io/managed-by-location', 'backstage.io/managed-by-origin-location']) {
    const raw = (ann[key] ?? '').replace(/^url:\s*/, '').trim()
    if (!raw) continue
    const m = /\/(?:src|raw)\/(?:branch|commit|tag)\/[^/]+\/(.+\.ya?ml)$/i.exec(raw)
    if (m) return decodeURIComponent(m[1])
  }
  const d = dir.replace(/^\.?\/+|\/+$/g, '')
  return d ? `${d}/catalog-info.yaml` : 'catalog-info.yaml'
}

export interface DescriptorTarget {
  org: string
  repo: string
  /** Explicit ref from the entity, else '' (the repository's default branch). */
  ref: string
  path: string
}

export interface Descriptor extends DescriptorTarget {
  exists: boolean
  text: string | null
  sha: string | null
}

/**
 * React Query key of one descriptor. Shared by the catalog overlay, the
 * scorecard fix dialog and its Re-evaluate (which invalidates exactly this).
 */
export const descriptorKey = (t: DescriptorTarget) => ['catalog', 'descriptor', t.org, t.repo, t.ref, t.path] as const

/* ─────────── which document ─────────── */

function docMatches(v: YamlValue, entity: Pick<Entity, 'kind' | 'metadata'>): boolean {
  const r = asRecord(v)
  return String(getPath(r, ['metadata', 'name']) ?? '').toLowerCase() === entity.metadata.name.toLowerCase() &&
    String(r?.kind ?? '').toLowerCase() === entity.kind.toLowerCase()
}

/** Which document of a descriptor stream describes this entity. */
export function descriptorDocIndex(text: string, entity: Pick<Entity, 'kind' | 'metadata'>): number {
  const docs = parseDocs(text)
  const exact = docs.find((d) => docMatches(d.value, entity))
  if (exact) return exact.index
  const sameKind = docs.find((d) => String(asRecord(d.value)?.kind ?? '').toLowerCase() === entity.kind.toLowerCase())
  if (sameKind) return sameKind.index
  return docs[0]?.index ?? 0
}

/** The parsed descriptor document for this entity, or undefined. */
export function descriptorDoc(text: string, entity: Pick<Entity, 'kind' | 'metadata'>): Record<string, YamlValue> | undefined {
  const idx = descriptorDocIndex(text, entity)
  return asRecord(parseDocs(text).find((d) => d.index === idx)?.value)
}

/* ─────────── the overlay ─────────── */

const LIFECYCLES = new Set(['production', 'staging', 'experimental', 'deprecated'])

/**
 * Annotations that say WHERE the entity's source and descriptor live. They
 * always come from the live entity: the descriptor was read from that
 * location, so it cannot move itself — and if it could, the enriched entity
 * would point the descriptor read at a different file than the one overlaid.
 */
export const LOCATION_ANNOTATIONS: ReadonlySet<string> = new Set([
  'backstage.io/managed-by-location',
  'backstage.io/managed-by-origin-location',
  'backstage.io/source-location',
  'adhar.io/source-repo',
  'adhar.io/git-repo',
  'adhar.io/source-path',
  'adhar.io/path',
  'adhar.io/branch',
  'adhar.io/default-branch',
])

/**
 * Overlay a repository's `catalog-info.yaml` onto the live entity.
 *
 * The descriptor is the declared source of truth for owner, description,
 * title, links, tags and annotations (it wins a conflict). Lifecycle follows
 * the catalog's existing rule (catalog-lifecycle.ts): a lifecycle derived from
 * where the app runs stands, except that a declared `production` or
 * `deprecated` is a decision and wins; a declared value fills a gap.
 *
 * Two things are deliberately NOT taken from the descriptor: the location
 * annotations above, and `repo`-icon links — both decide which repository and
 * file the descriptor is read from (`resolveRepoSource`, `catalogInfoPath`).
 *
 * Idempotent: overlaying the same document twice gives the same entity.
 */
export function overlayDescriptor(entity: Entity, doc: Record<string, YamlValue> | undefined): Entity {
  if (!doc) return entity
  const meta = asRecord(doc.metadata) ?? {}
  const spec = asRecord(doc.spec) ?? {}
  const str = (v: YamlValue | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const owner = str(spec.owner)
  const lifecycle = str(spec.lifecycle)?.toLowerCase()
  const declared = lifecycle && LIFECYCLES.has(lifecycle) ? (lifecycle as Lifecycle) : undefined

  const links: Link[] = [...(entity.metadata.links ?? [])]
  for (const raw of asArray(meta.links)) {
    const l = asRecord(raw)
    const url = str(l?.url)
    if (!url || links.some((x) => x.url === url)) continue
    const icon = str(l?.icon) as Link['icon'] | undefined
    if (icon === 'repo') continue
    links.push({ url, title: str(l?.title) ?? url, ...(icon ? { icon } : {}) })
  }

  const live = entity.metadata.annotations ?? {}
  const annotations: Record<string, string> = { ...live }
  for (const [k, v] of Object.entries(asRecord(meta.annotations) ?? {})) {
    if (LOCATION_ANNOTATIONS.has(k)) continue
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') annotations[k] = String(v)
  }

  const tags = new Set([...(entity.metadata.tags ?? []), ...asArray(meta.tags).map((t) => String(t).toLowerCase())])
  const liveLc = entity.spec.lifecycle
  const mergedLc = declared === 'production' || declared === 'deprecated' ? declared : liveLc ?? declared
  return {
    ...entity,
    metadata: {
      ...entity.metadata,
      ...(str(meta.title) ? { title: str(meta.title) } : {}),
      ...(str(meta.description) ? { description: str(meta.description) } : {}),
      links,
      tags: [...tags],
      annotations,
    },
    spec: {
      ...entity.spec,
      ...(owner ? { owner: owner.includes(':') ? owner : `group:${owner}` } : {}),
      ...(mergedLc ? { lifecycle: mergedLc } : {}),
    },
  }
}

/**
 * The entity with its descriptor applied, or the entity unchanged when the
 * repository has none, it was not read yet, or it is not YAML.
 */
export function withDescriptor(entity: Entity, d: Pick<Descriptor, 'exists' | 'text'> | undefined): Entity {
  if (!d?.exists || !d.text) return entity
  try {
    return overlayDescriptor(entity, descriptorDoc(d.text, entity))
  } catch {
    return entity
  }
}

/* ─────────── bounded concurrency ─────────── */

/**
 * A tiny FIFO limiter: at most `max` tasks run at once. `urgent` tasks (the one
 * entity a person is looking at) jump the queue ahead of the catalog-wide
 * background reads.
 */
export function createLimiter(max: number) {
  let running = 0
  const queue: Array<() => void> = []
  const next = () => {
    if (running >= max) return
    const start = queue.shift()
    if (start) start()
  }
  return {
    run<T>(task: () => Promise<T>, urgent = false): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const start = () => {
          running++
          task().then(resolve, reject).finally(() => {
            running--
            next()
          })
        }
        if (urgent) queue.unshift(start)
        else queue.push(start)
        next()
      })
    },
    get active() {
      return running
    },
    get pending() {
      return queue.length
    },
  }
}
