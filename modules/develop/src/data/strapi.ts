import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { strapi } from '@adhar/api-clients'

/**
 * Strapi (headless CMS) for the Develop phase — content types, entries,
 * media and the content API a service consumes.
 *
 * Calls go through the BFF (`/api/svc/strapi/…`), which adds the platform's
 * Strapi API token server-side. Without one (`integrations.strapi === false`)
 * the page explains how to connect instead of showing 401s.
 */
export const strapiClient = strapi.StrapiClient.auto({ tool: 'strapi' })

export type ContentType = strapi.ContentType
export type Entry = strapi.Entry
export type Attribute = strapi.Attribute

const STALE_MS = 15_000

export function useContentTypes(enabled = true) {
  return useQuery({
    queryKey: ['strapi', 'content-types'],
    queryFn: () => strapiClient.listContentTypes(),
    enabled,
    staleTime: 60_000,
  })
}

export type EntryState = 'published' | 'modified' | 'draft'

export interface EntryRow extends Entry {
  /** Only set for draft & publish types. */
  _state?: EntryState
}

/**
 * One page of entries. For draft & publish types this reads the drafts (every
 * document has one) and then asks which of them are published, so each row
 * can say Draft, Published, or Published with unpublished changes.
 */
export function useEntries(
  ct: ContentType | undefined,
  params: { page: number; pageSize: number; search: string; status: 'all' | 'published' },
) {
  return useQuery({
    queryKey: ['strapi', 'entries', ct?.uid, params],
    enabled: !!ct,
    staleTime: STALE_MS,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const type = ct!
      const search = params.search.trim()
        ? { term: params.search.trim(), fields: searchableFields(type) }
        : undefined
      const dp = Boolean(type.schema.draftAndPublish)
      const page = await strapiClient.listEntries(type, {
        page: params.page,
        pageSize: params.pageSize,
        search,
        status: dp && params.status === 'all' ? 'draft' : undefined,
      })
      if (!dp) return page as { data: EntryRow[]; pagination: strapi.Pagination }
      if (params.status === 'published') {
        return { ...page, data: page.data.map((e) => ({ ...e, _state: 'published' as const })) }
      }
      const ids = page.data.map((e) => e.documentId)
      const published = ids.length && type.schema.kind === 'collectionType'
        ? await strapiClient.listEntries(type, { documentIds: ids, pageSize: ids.length, fields: ['updatedAt', 'publishedAt'] })
        : type.schema.kind === 'singleType'
          ? await strapiClient.listEntries(type, {})
          : { data: [] as Entry[] }
      const pub = new Map(published.data.map((e) => [e.documentId, e]))
      return {
        ...page,
        data: page.data.map((e): EntryRow => ({ ...e, _state: entryState(e, pub.get(e.documentId)) })),
      }
    },
  })
}

/** A draft that was saved after its published version has unpublished changes. */
export function entryState(draft: Entry, published?: Entry): EntryState {
  if (!published) return 'draft'
  const d = Date.parse(String(draft.updatedAt ?? ''))
  const p = Date.parse(String(published.updatedAt ?? ''))
  if (Number.isFinite(d) && Number.isFinite(p) && d - p > 1_000) return 'modified'
  return 'published'
}

export function useEntry(ct: ContentType | undefined, documentId: string | null | undefined) {
  const single = ct?.schema.kind === 'singleType'
  return useQuery({
    queryKey: ['strapi', 'entry', ct?.uid, documentId ?? null],
    enabled: !!ct && (single || !!documentId),
    staleTime: STALE_MS,
    queryFn: () => strapiClient.getEntry(ct!, single ? null : documentId!, ct!.schema.draftAndPublish ? 'draft' : undefined),
  })
}

export function useSaveEntry(ct: ContentType | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ documentId, data, publish }: { documentId?: string | null; data: Record<string, unknown>; publish: boolean }) =>
      documentId || ct!.schema.kind === 'singleType'
        ? strapiClient.updateEntry(ct!, documentId ?? null, data, { publish })
        : strapiClient.createEntry(ct!, data, { publish }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['strapi', 'entries', ct?.uid] })
      qc.invalidateQueries({ queryKey: ['strapi', 'entry', ct?.uid] })
    },
  })
}

export function useDeleteEntry(ct: ContentType | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (documentId: string | null) => strapiClient.deleteEntry(ct!, documentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['strapi', 'entries', ct?.uid] })
      qc.invalidateQueries({ queryKey: ['strapi', 'entry', ct?.uid] })
    },
  })
}

export function useMediaFiles(enabled: boolean) {
  return useQuery({
    queryKey: ['strapi', 'files'],
    queryFn: () => strapiClient.listFiles(),
    enabled,
    staleTime: STALE_MS,
  })
}

export function useLocales(enabled: boolean) {
  return useQuery({
    queryKey: ['strapi', 'locales'],
    queryFn: () => strapiClient.listLocales(),
    enabled,
    staleTime: 5 * 60_000,
  })
}

/* ───── schema helpers ───── */

const TEXTUAL = new Set(['string', 'text', 'email', 'uid', 'richtext'])
const TITLE_HINTS = ['title', 'name', 'headline', 'label', 'heading', 'slug']

/** String-like fields the search box matches against. */
export function searchableFields(ct: ContentType): string[] {
  return Object.entries(ct.schema.attributes)
    .filter(([, a]) => TEXTUAL.has(a.type) && !a.private)
    .map(([k]) => k)
    .slice(0, 6)
}

/** The field that best names an entry. */
export function titleField(ct: ContentType): string | undefined {
  const attrs = ct.schema.attributes
  for (const hint of TITLE_HINTS) if (attrs[hint] && TEXTUAL.has(attrs[hint].type)) return hint
  return Object.entries(attrs).find(([, a]) => a.type === 'string')?.[0]
}

/** Attribute types the console can edit in a plain form. */
export const EDITABLE = new Set([
  'string', 'text', 'richtext', 'email', 'uid',
  'integer', 'biginteger', 'decimal', 'float',
  'boolean', 'date', 'datetime', 'time', 'enumeration', 'json',
])

export function isEditable(a: Attribute): boolean {
  return EDITABLE.has(a.type) && !a.private
}

/** A few scalar columns worth showing in the list, after the title. */
export function summaryFields(ct: ContentType, limit = 2): string[] {
  const title = titleField(ct)
  return Object.entries(ct.schema.attributes)
    .filter(([k, a]) => k !== title && !a.private && ['string', 'enumeration', 'boolean', 'integer', 'decimal', 'float', 'date', 'uid', 'email'].includes(a.type))
    .map(([k]) => k)
    .slice(0, limit)
}

/** Convert form input back to the JSON Strapi expects for an attribute. */
export function coerce(a: Attribute, raw: unknown): unknown {
  if (raw === '' || raw === undefined) return a.type === 'boolean' ? false : null
  switch (a.type) {
    case 'integer':
    case 'biginteger':
      return Number.parseInt(String(raw), 10)
    case 'decimal':
    case 'float':
      return Number(raw)
    case 'boolean':
      return Boolean(raw)
    case 'json':
      return typeof raw === 'string' ? JSON.parse(raw) : raw
    default:
      return raw
  }
}

export function prettyLabel(field: string): string {
  return field
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())
}

/**
 * Whatever a Strapi call threw, as a sentence. Strapi errors are
 * `{ error: { status, name, message, details } }`; validation errors list the
 * failing paths in `details.errors`.
 */
export function strapiError(e: unknown, fallback = 'Strapi request failed.'): string {
  const err = e as { status?: number; body?: unknown; message?: string } | undefined
  const b = err?.body as { error?: { message?: string; details?: { errors?: Array<{ path?: string[]; message?: string }> } } } | undefined
  if (err?.status === 401 || err?.status === 403) {
    return 'Strapi rejected the console\'s API token. If Strapi has just started, it registers the platform token within a minute; otherwise the token needs full access (Settings → API Tokens).'
  }
  const details = b?.error?.details?.errors
  if (details?.length) return details.map((d) => `${(d.path ?? []).join('.')}: ${d.message}`).join(' · ')
  if (b?.error?.message) return b.error.message
  return e instanceof Error && e.message ? e.message : fallback
}
