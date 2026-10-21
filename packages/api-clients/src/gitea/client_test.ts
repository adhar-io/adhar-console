import { assertEquals } from 'jsr:@std/assert@1'
import { GiteaClient } from './index.ts'

/** A fake Gitea: `total` repos, 50 a page, optional `X-Total-Count`, every call logged. */
function fake(total: number, withCount = true) {
  const calls: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    calls.push(url.pathname + url.search)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setTimeout(r, 5))
    inFlight--
    const page = Number(url.searchParams.get('page') ?? 1)
    const limit = Number(url.searchParams.get('limit') ?? 50)
    const all = Array.from({ length: total }, (_, i) => ({ id: i + 1, name: `r${i + 1}` }))
    const body = all.slice((page - 1) * limit, page * limit)
    return Response.json(body, { headers: withCount ? { 'x-total-count': String(total) } : {} })
  }) as typeof fetch
  return { client: GiteaClient.create({ baseUrl: 'http://gitea.test', fetchImpl }), calls, max: () => maxInFlight }
}

Deno.test('pages after the first are fetched together once X-Total-Count is known', async () => {
  const { client, calls, max } = fake(150)
  const repos = await client.listRepos('adhar')
  assertEquals(repos.length, 150)
  // Three pages, no trailing empty page, and pages 2–3 in parallel.
  assertEquals(calls.length, 3)
  assertEquals(max(), 2)
})

Deno.test('a single short page is one request', async () => {
  const { client, calls } = fake(12)
  assertEquals((await client.listRepos('adhar')).length, 12)
  assertEquals(calls.length, 1)
})

Deno.test('without X-Total-Count it walks pages until a short one', async () => {
  const { client, calls } = fake(120, false)
  assertEquals((await client.listRepos('adhar')).length, 120)
  assertEquals(calls.length, 3)
})

Deno.test('an exact multiple of the page size stops at the total', async () => {
  const { client, calls } = fake(100)
  assertEquals((await client.listRepos('adhar')).length, 100)
  assertEquals(calls.length, 2)
})

Deno.test('searchIssues asks for the owner and reports the total', async () => {
  const calls: string[] = []
  const fetchImpl = ((input: string | URL | Request) => {
    calls.push(String(input))
    return Promise.resolve(
      Response.json([{ id: 1, number: 3, title: 't', state: 'open', user: { login: 'a' }, labels: [], created_at: 'x', repository: { name: 'svc', owner: 'adhar' } }], {
        headers: { 'x-total-count': '61' },
      }),
    )
  }) as typeof fetch
  const client = GiteaClient.create({ baseUrl: 'http://gitea.test', fetchImpl })
  const r = await client.searchIssues({ owner: 'adhar', type: 'issues', state: 'open', page: 2 })
  assertEquals(r.total, 61)
  assertEquals(r.items[0].repository?.name, 'svc')
  const u = new URL(calls[0])
  assertEquals(u.pathname, '/api/v1/repos/issues/search')
  assertEquals(u.searchParams.get('owner'), 'adhar')
  assertEquals(u.searchParams.get('type'), 'issues')
  assertEquals(u.searchParams.get('page'), '2')
})
