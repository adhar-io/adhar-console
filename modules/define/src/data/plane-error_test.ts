import { assertEquals } from 'jsr:@std/assert@1'
import { planeError } from './plane-error.ts'

Deno.test('429 names the wait DRF reports, else falls back to a minute', () => {
  assertEquals(
    planeError({ status: 429, body: { detail: 'Request was throttled. Expected available in 42 seconds.' } }),
    'Plane is rate-limiting the console right now. Try again in 42 seconds.',
  )
  assertEquals(planeError({ status: 429, body: {} }), 'Plane is rate-limiting the console right now. Try again in a minute.')
})

Deno.test('auth failures, BFF codes and DRF field errors read as sentences', () => {
  assertEquals(planeError({ status: 403 }).startsWith('Plane rejected the console'), true)
  assertEquals(planeError({ status: 502, body: { error: 'upstream_unreachable' } }), 'The console could not reach Plane. It may be restarting.')
  assertEquals(planeError({ status: 400, body: { name: ['This field is required.'] } }), 'name: This field is required.')
  assertEquals(planeError(undefined, 'fallback'), 'fallback')
})

Deno.test('the console\'s own Plane refusals say why, not "the API key was rejected"', () => {
  const detail = 'Only admins of the organisation "adhar" (or platform admins) can change who is in its Plane workspace and projects.'
  assertEquals(planeError({ status: 403, body: { error: 'plane_membership_requires_admin', detail } }), detail)
  // Plane's own 403 still reads as the key problem it usually is.
  assertEquals(planeError({ status: 403, body: { detail: 'You do not have permission to perform this action.' } }).includes('API key'), true)
})
