import { defineClient, type HttpClient } from '../base/index.ts'

/**
 * Strapi 5 client — the Content API (`/api/…`) with an API token.
 *
 * Verified against strapi/strapi v5.57.0:
 *   • `GET /api/content-type-builder/content-types` lists every content type
 *     with its schema (the content-type-builder plugin's content-api routes;
 *     a full-access API token is allowed to call them);
 *   • collection types live at `/api/<pluralName>` and single types at
 *     `/api/<singularName>`, addressed by `documentId`;
 *   • reads default to the PUBLISHED version — `?status=draft` reads drafts;
 *     writes publish by default — `?status=draft` saves a draft only;
 *   • `/api/upload/files` lists media and `/api/i18n/locales` the locales.
 *
 * There is no REST "unpublish": that is an admin-panel action.
 */

export type AttributeType =
  | 'string' | 'text' | 'richtext' | 'blocks' | 'email' | 'password' | 'uid'
  | 'integer' | 'biginteger' | 'decimal' | 'float'
  | 'boolean' | 'date' | 'datetime' | 'time' | 'timestamp'
  | 'enumeration' | 'json' | 'media' | 'relation' | 'component' | 'dynamiczone'
  // Plugins can add their own types.
  | `plugin::${string}`

export interface Attribute {
  type: AttributeType
  required?: boolean
  unique?: boolean
  private?: boolean
  default?: unknown
  enum?: string[]
  multiple?: boolean
  relation?: string
  target?: string
  component?: string
  repeatable?: boolean
  minLength?: number
  maxLength?: number
  min?: number
  max?: number
}

export interface ContentType {
  uid: string
  plugin?: string
  apiID: string
  schema: {
    displayName: string
    singularName: string
    pluralName: string
    description?: string
    kind: 'collectionType' | 'singleType'
    draftAndPublish?: boolean
    visible?: boolean
    collectionName?: string
    pluginOptions?: { i18n?: { localized?: boolean } } & Record<string, unknown>
    attributes: Record<string, Attribute>
  }
}

export interface Entry {
  id: number
  documentId: string
  createdAt?: string
  updatedAt?: string
  publishedAt?: string | null
  locale?: string | null
  [field: string]: unknown
}

export interface Pagination {
  page: number
  pageSize: number
  pageCount: number
  total: number
}

export interface EntryPage {
  data: Entry[]
  pagination: Pagination
}

export interface MediaFile {
  id: number
  documentId?: string
  name: string
  alternativeText?: string | null
  caption?: string | null
  width?: number | null
  height?: number | null
  formats?: Record<string, { url: string; width?: number; height?: number }> | null
  ext?: string
  mime: string
  size: number
  url: string
  createdAt?: string
  updatedAt?: string
}

export interface Locale {
  id: number
  name: string
  code: string
  isDefault?: boolean
}

export interface ListEntriesParams {
  page?: number
  pageSize?: number
  /** `draft` reads the latest draft of every document; the default is published. */
  status?: 'draft' | 'published'
  /** e.g. `updatedAt:desc`. */
  sort?: string
  /** Case-insensitive match against these fields (string-like attributes). */
  search?: { term: string; fields: string[] }
  locale?: string
  /** Restrict to these document ids. */
  documentIds?: string[]
  /** Only return these fields (plus id/documentId). */
  fields?: string[]
}

export interface StrapiClient {
  listContentTypes(): Promise<ContentType[]>
  listEntries(ct: ContentType, params?: ListEntriesParams): Promise<EntryPage>
  getEntry(ct: ContentType, documentId: string | null, status?: 'draft' | 'published', locale?: string): Promise<Entry | null>
  /** `publish: false` saves a draft (types with draft & publish). */
  createEntry(ct: ContentType, data: Record<string, unknown>, opts?: { publish?: boolean; locale?: string }): Promise<Entry>
  updateEntry(
    ct: ContentType,
    documentId: string | null,
    data: Record<string, unknown>,
    opts?: { publish?: boolean; locale?: string },
  ): Promise<Entry>
  deleteEntry(ct: ContentType, documentId: string | null, locale?: string): Promise<void>
  listFiles(): Promise<MediaFile[]>
  listLocales(): Promise<Locale[]>
}

/** The REST path for a content type: plural for collections, singular for single types. */
export function entryPath(ct: ContentType, documentId?: string | null): string {
  if (ct.schema.kind === 'singleType') return `/api/${ct.schema.singularName}`
  return `/api/${ct.schema.pluralName}${documentId ? `/${documentId}` : ''}`
}

/** Content types a person authors: the app's own (`api::`), visible ones. */
export function isAuthorable(ct: ContentType): boolean {
  return ct.uid.startsWith('api::') && ct.schema.visible !== false
}

/** Strapi's bracketed query-string encoding for nested params. */
export function encodeQuery(params: Record<string, unknown>): string {
  const parts: string[] = []
  const walk = (prefix: string, v: unknown) => {
    if (v === undefined || v === null || v === '') return
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(`${prefix}[${i}]`, item))
    } else if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(prefix ? `${prefix}[${k}]` : k, val)
    } else {
      parts.push(`${encodeURIComponent(prefix).replace(/%5B/g, '[').replace(/%5D/g, ']')}=${encodeURIComponent(String(v))}`)
    }
  }
  walk('', params)
  return parts.length ? `?${parts.join('&')}` : ''
}

function build(http: HttpClient): StrapiClient {
  return {
    listContentTypes: async () => {
      const res = await http.get<{ data: ContentType[] }>('/api/content-type-builder/content-types')
      return (res.data ?? []).filter(isAuthorable).sort((a, b) => a.schema.displayName.localeCompare(b.schema.displayName))
    },

    listEntries: async (ct, p = {}) => {
      if (ct.schema.kind === 'singleType') {
        const one = await getOne(http, ct, null, p.status, p.locale)
        return { data: one ? [one] : [], pagination: { page: 1, pageSize: 1, pageCount: 1, total: one ? 1 : 0 } }
      }
      const filters: Record<string, unknown> = {}
      if (p.search?.term && p.search.fields.length) {
        filters.$or = p.search.fields.map((f) => ({ [f]: { $containsi: p.search!.term } }))
      }
      if (p.documentIds?.length) filters.documentId = { $in: p.documentIds }
      const q = encodeQuery({
        pagination: { page: p.page ?? 1, pageSize: p.pageSize ?? 25 },
        sort: p.sort ?? 'updatedAt:desc',
        status: ct.schema.draftAndPublish ? p.status : undefined,
        locale: p.locale,
        filters: Object.keys(filters).length ? filters : undefined,
        fields: p.fields,
      })
      const res = await http.get<{ data: Entry[]; meta?: { pagination?: Pagination } }>(`${entryPath(ct)}${q}`)
      return {
        data: res.data ?? [],
        pagination: res.meta?.pagination ?? { page: 1, pageSize: res.data?.length ?? 0, pageCount: 1, total: res.data?.length ?? 0 },
      }
    },

    getEntry: (ct, documentId, status, locale) => getOne(http, ct, documentId, status, locale),

    createEntry: async (ct, data, opts = {}) => {
      const q = encodeQuery({ status: ct.schema.draftAndPublish && opts.publish === false ? 'draft' : undefined, locale: opts.locale })
      // A single type has no POST: its one document is created by PUT.
      const method = ct.schema.kind === 'singleType' ? 'put' : 'post'
      const res = await http[method]<{ data: Entry }>(`${entryPath(ct)}${q}`, { data })
      return res.data
    },

    updateEntry: async (ct, documentId, data, opts = {}) => {
      const q = encodeQuery({ status: ct.schema.draftAndPublish && opts.publish === false ? 'draft' : undefined, locale: opts.locale })
      const res = await http.put<{ data: Entry }>(`${entryPath(ct, documentId)}${q}`, { data })
      return res.data
    },

    deleteEntry: async (ct, documentId, locale) => {
      await http.delete<void>(`${entryPath(ct, documentId)}${encodeQuery({ locale })}`)
    },

    listFiles: async () => {
      const res = await http.get<MediaFile[] | { data?: MediaFile[] }>(`/api/upload/files${encodeQuery({ sort: 'updatedAt:desc' })}`)
      return Array.isArray(res) ? res : res.data ?? []
    },

    listLocales: async () => {
      try {
        const res = await http.get<Locale[] | { data?: Locale[] }>('/api/i18n/locales')
        return Array.isArray(res) ? res : res.data ?? []
      } catch {
        return [] // i18n not installed
      }
    },
  }
}

async function getOne(
  http: HttpClient,
  ct: ContentType,
  documentId: string | null,
  status?: 'draft' | 'published',
  locale?: string,
): Promise<Entry | null> {
  const q = encodeQuery({ status: ct.schema.draftAndPublish ? status : undefined, locale, populate: '*' })
  try {
    const res = await http.get<{ data: Entry | null }>(`${entryPath(ct, documentId)}${q}`)
    return res.data ?? null
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null
    throw e
  }
}

/* ───────────────────────────── Stub ───────────────────────────── */

const STUB_TYPES: ContentType[] = [
  {
    uid: 'api::article.article',
    apiID: 'article',
    schema: {
      displayName: 'Article',
      singularName: 'article',
      pluralName: 'articles',
      description: 'Blog and changelog posts.',
      kind: 'collectionType',
      draftAndPublish: true,
      attributes: {
        title: { type: 'string', required: true },
        slug: { type: 'uid' },
        summary: { type: 'text' },
        body: { type: 'richtext' },
        featured: { type: 'boolean', default: false },
        category: { type: 'enumeration', enum: ['news', 'release', 'guide'] },
        cover: { type: 'media', multiple: false },
      },
    },
  },
  {
    uid: 'api::homepage.homepage',
    apiID: 'homepage',
    schema: {
      displayName: 'Homepage',
      singularName: 'homepage',
      pluralName: 'homepages',
      kind: 'singleType',
      draftAndPublish: false,
      attributes: { headline: { type: 'string' }, tagline: { type: 'text' } },
    },
  },
]

const STUB_ARTICLES: Entry[] = [
  { id: 1, documentId: 'a1', title: 'Adhar 0.1 is out', slug: 'adhar-0-1', summary: 'The first public release.', featured: true, category: 'release', createdAt: '2026-10-01T09:00:00Z', updatedAt: '2026-10-02T09:00:00Z', publishedAt: '2026-10-02T09:00:00Z' },
  { id: 2, documentId: 'a2', title: 'Golden paths, explained', slug: 'golden-paths', summary: 'How templates become services.', featured: false, category: 'guide', createdAt: '2026-10-05T09:00:00Z', updatedAt: '2026-10-09T09:00:00Z', publishedAt: null },
]

export const StrapiClient = defineClient<StrapiClient>(build, () => ({
  listContentTypes: () => Promise.resolve(STUB_TYPES),
  listEntries: (ct) => {
    const data = ct.uid === 'api::article.article' ? STUB_ARTICLES : [{ id: 9, documentId: 'h1', headline: 'Build on Adhar', tagline: 'One platform.' }]
    return Promise.resolve({ data, pagination: { page: 1, pageSize: 25, pageCount: 1, total: data.length } })
  },
  getEntry: (ct, id) => Promise.resolve(ct.uid === 'api::article.article' ? STUB_ARTICLES.find((a) => a.documentId === id) ?? null : null),
  createEntry: (_ct, data) => Promise.resolve({ id: Date.now(), documentId: `new-${Date.now().toString(36)}`, ...data }),
  updateEntry: (_ct, documentId, data) => Promise.resolve({ id: 1, documentId: documentId ?? 'single', ...data }),
  deleteEntry: () => Promise.resolve(),
  listFiles: () => Promise.resolve([]),
  listLocales: () => Promise.resolve([{ id: 1, name: 'English (en)', code: 'en', isDefault: true }]),
}))
