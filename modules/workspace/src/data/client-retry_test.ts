import { assertEquals } from 'jsr:@std/assert@1'
import { shouldRetry, WorkspaceApiError } from './client.ts'

Deno.test('shouldRetry — outages retry, unconfigured dependencies and 4xx do not', () => {
  assertEquals(shouldRetry(0, new WorkspaceApiError('down', 502)), true)
  assertEquals(shouldRetry(2, new WorkspaceApiError('down', 502)), false)
  assertEquals(shouldRetry(0, new WorkspaceApiError('no kc', 503, 'keycloak_not_configured')), false)
  assertEquals(shouldRetry(0, new WorkspaceApiError('no db', 503, 'store_unavailable')), false)
  assertEquals(shouldRetry(0, new WorkspaceApiError('nope', 403)), false)
})
