import { assertEquals } from 'jsr:@std/assert@1'
import { bffErrorCode, classifySourceError, sourceErrorKind } from './source-error.ts'

const err = (status: number, body?: unknown) => Object.assign(new Error(`HTTP ${status}`), { status, body })

Deno.test('bffErrorCode — reads the BFF code from the JSON body only', () => {
  assertEquals(bffErrorCode(err(502, { error: 'upstream_unreachable', detail: 'fetch failed' })), 'upstream_unreachable')
  assertEquals(bffErrorCode(err(502, '<html>bad gateway</html>')), undefined)
  assertEquals(bffErrorCode(err(400, { error: 'Bad things happened' })), undefined)
  assertEquals(bffErrorCode(null), undefined)
})

Deno.test('sourceErrorKind — a BFF connect failure is unreachable, not "starting up"', () => {
  assertEquals(sourceErrorKind(err(502, { error: 'upstream_unreachable' })), 'unreachable')
  assertEquals(sourceErrorKind(err(504, { error: 'upstream_timeout' })), 'timeout')
  assertEquals(sourceErrorKind(err(503, { error: 'tool_not_configured' })), 'not-configured')
  assertEquals(sourceErrorKind(err(503, { error: 'login_credentials_missing' })), 'not-configured')
  // A gateway error from the tool's own proxy (no BFF code) is the boot window.
  assertEquals(sourceErrorKind(err(502, '<html>502 Bad Gateway</html>')), 'starting')
  assertEquals(sourceErrorKind(err(503)), 'starting')
  assertEquals(sourceErrorKind(err(502, { error: 'login_session_failed' })), 'rejected')
  assertEquals(sourceErrorKind(err(403)), 'unauthorized')
  assertEquals(sourceErrorKind(err(404)), 'not-configured')
  assertEquals(sourceErrorKind(Object.assign(new Error('x'), { name: 'NetworkError' })), 'unreachable')
  assertEquals(sourceErrorKind(new Error('boom')), 'other')
})

Deno.test('classifySourceError — titles name the real cause', () => {
  assertEquals(classifySourceError('PostHog', err(502, { error: 'upstream_unreachable' })).title, "Can't reach PostHog")
  assertEquals(classifySourceError('Grafana', err(502)).title, 'Grafana is unavailable')
  assertEquals(classifySourceError('Tempo', new Error('kaput')).description, 'kaput')
})
