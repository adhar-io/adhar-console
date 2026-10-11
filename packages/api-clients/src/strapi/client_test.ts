import { assertEquals } from 'jsr:@std/assert@1'
import { type ContentType, encodeQuery, entryPath, StrapiClient } from './index.ts'

const ARTICLE: ContentType = {
  uid: 'api::article.article',
  apiID: 'article',
  schema: {
    displayName: 'Article', singularName: 'article', pluralName: 'articles', kind: 'collectionType',
    draftAndPublish: true, attributes: { title: { type: 'string' } },
  },
}
const HOME: ContentType = {
  uid: 'api::homepage.homepage',
  apiID: 'homepage',
  schema: { displayName: 'Homepage', singularName: 'homepage', pluralName: 'homepages', kind: 'singleType', attributes: {} },
}

function fake(answer: (method: string, path: string, body: unknown) => unknown) {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = decodeURIComponent(String(input).replace('http://strapi.test', ''))
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, body })
    const out = answer(method, path, body)
    return Promise.resolve(out === null ? new Response(null, { status: 204 }) : Response.json(out))
  }) as typeof fetch
  return { client: StrapiClient.create({ baseUrl: 'http://strapi.test', fetchImpl }), calls }
}

Deno.test('entryPath uses the plural for collections and the singular for single types', () => {
  assertEquals(entryPath(ARTICLE), '/api/articles')
  assertEquals(entryPath(ARTICLE, 'abc'), '/api/articles/abc')
  assertEquals(entryPath(HOME, 'ignored'), '/api/homepage')
})

Deno.test('encodeQuery produces Strapi bracket notation', () => {
  assertEquals(
    decodeURIComponent(encodeQuery({ pagination: { page: 2, pageSize: 10 }, filters: { $or: [{ title: { $containsi: 'a b' } }] }, skip: undefined })),
    '?pagination[page]=2&pagination[pageSize]=10&filters[$or][0][title][$containsi]=a b',
  )
  assertEquals(encodeQuery({}), '')
})

Deno.test('listContentTypes keeps only the app\'s own visible types, sorted', async () => {
  const { client } = fake(() => ({
    data: [
      { ...ARTICLE, schema: { ...ARTICLE.schema, displayName: 'Zebra' } },
      { uid: 'plugin::users-permissions.user', apiID: 'user', schema: { ...ARTICLE.schema, displayName: 'User' } },
      { uid: 'api::hidden.hidden', apiID: 'hidden', schema: { ...ARTICLE.schema, displayName: 'Hidden', visible: false } },
      HOME,
    ],
  }))
  const types = await client.listContentTypes()
  assertEquals(types.map((t) => t.schema.displayName), ['Homepage', 'Zebra'])
})

Deno.test('listEntries pages, sorts, searches and reads drafts', async () => {
  const { client, calls } = fake(() => ({ data: [{ id: 1, documentId: 'd1' }], meta: { pagination: { page: 2, pageSize: 10, pageCount: 3, total: 21 } } }))
  const page = await client.listEntries(ARTICLE, { page: 2, pageSize: 10, status: 'draft', search: { term: 'adhar', fields: ['title'] } })
  assertEquals(page.pagination.total, 21)
  assertEquals(
    calls[0].path,
    '/api/articles?pagination[page]=2&pagination[pageSize]=10&sort=updatedAt:desc&status=draft&filters[$or][0][title][$containsi]=adhar',
  )
})

Deno.test('writes publish unless asked for a draft; single types are written with PUT', async () => {
  const { client, calls } = fake((_m, _p, body) => ({ data: { id: 1, documentId: 'd1', ...(body as { data: object }).data } }))
  await client.createEntry(ARTICLE, { title: 'x' }, { publish: false })
  await client.updateEntry(ARTICLE, 'd1', {}, { publish: true })
  await client.createEntry(HOME, { headline: 'h' })
  assertEquals(calls.map((c) => `${c.method} ${c.path}`), [
    'POST /api/articles?status=draft',
    'PUT /api/articles/d1',
    'PUT /api/homepage',
  ])
  assertEquals(calls[0].body, { data: { title: 'x' } })
})

Deno.test('a missing single-type document reads as null, not an error', async () => {
  const fetchImpl = (() => Promise.resolve(Response.json({ data: null, error: { status: 404 } }, { status: 404 }))) as typeof fetch
  const client = StrapiClient.create({ baseUrl: 'http://strapi.test', fetchImpl })
  assertEquals(await client.getEntry(HOME, null), null)
})
