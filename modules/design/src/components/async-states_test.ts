import { assertEquals } from 'jsr:@std/assert@1'
import { readableError } from './async-states.tsx'

const httpErr = (body: unknown) => Object.assign(new Error('HTTP 502 Bad Gateway at GET http://x/api/svc/gitea/api/v1/orgs/adhar/repos'), { status: 502, body })

Deno.test('readableError — explains BFF codes, keeps other messages', () => {
  assertEquals(readableError(httpErr({ error: 'upstream_unreachable' })), 'The console could not connect to the service. Check that it is running, then retry.')
  assertEquals(readableError(httpErr({ error: 'tool_not_configured' })), 'The console is not configured to reach this service.')
  assertEquals(readableError(new Error('Document is too large')), 'Document is too large')
  assertEquals(readableError(httpErr('<html>')), 'HTTP 502 Bad Gateway at GET http://x/api/svc/gitea/api/v1/orgs/adhar/repos')
})
