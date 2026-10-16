import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { discoverWorkspaceId } from './index.ts'

type Call = { method: 'get' | 'post'; path: string }

function stub(routes: Record<string, unknown | Error>, calls: Call[]) {
  const answer = (method: 'get' | 'post', path: string) => {
    calls.push({ method, path })
    const r = routes[`${method} ${path}`]
    if (r instanceof Error) return Promise.reject(r)
    if (r === undefined) return Promise.reject(new Error(`403 at ${path}`))
    return Promise.resolve(r)
  }
  return {
    get: <T>(path: string) => answer('get', path) as Promise<T>,
    post: <T>(path: string) => answer('post', path) as Promise<T>,
  }
}

// The instance-admin APPLICATION token is 403 on `workspaces/list` but may read
// the public API; discovery must prefer the call the token is allowed to make.
Deno.test('the workspace comes from the public API, which the application token may read', async () => {
  const calls: Call[] = []
  const http = stub({ 'get /api/public/v1/workspaces': { data: [{ workspaceId: 'ws-public' }] } }, calls)
  assertEquals(await discoverWorkspaceId(http), 'ws-public')
  assertEquals(calls.map((c) => c.path), ['/api/public/v1/workspaces'])
})

Deno.test('an older server without the public API still answers through workspaces/list', async () => {
  const calls: Call[] = []
  const http = stub({
    'get /api/public/v1/workspaces': new Error('404'),
    'post /api/v1/workspaces/list': { workspaces: [{ workspaceId: 'ws-legacy' }] },
  }, calls)
  assertEquals(await discoverWorkspaceId(http), 'ws-legacy')
})

Deno.test('no workspace anywhere is reported as Airbyte setup, not as a transport error', async () => {
  const http = stub({ 'get /api/public/v1/workspaces': { data: [] }, 'post /api/v1/workspaces/list': { workspaces: [] } }, [])
  await assertRejects(() => discoverWorkspaceId(http), Error, 'no workspace yet')
})
