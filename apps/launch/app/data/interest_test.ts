import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { submitInterest, validateInterest } from './interest.ts'

Deno.test('validateInterest accepts a minimal valid body and normalises it', () => {
  const r = validateInterest({ email: '  Ada@Example.COM ', source: 'launch', name: '  Ada  ' })
  assertEquals(r.ok, true)
  if (r.ok) {
    assertEquals(r.value.email, 'ada@example.com')
    assertEquals(r.value.name, 'Ada')
    assertEquals(r.value.company, undefined)
  }
})

Deno.test('validateInterest rejects a bad email, a bad role and an unknown source', () => {
  const r = validateInterest({ email: 'nope', role: 'wizard', source: 'elsewhere' })
  assertEquals(r.ok, false)
  if (!r.ok) {
    assertEquals(r.errors.map((e) => e.field).sort(), ['email', 'role', 'source'])
  }
})

Deno.test('validateInterest flags a filled honeypot', () => {
  const r = validateInterest({ email: 'a@b.co', source: 'launch', website: 'http://spam' })
  assertEquals(r.ok, false)
  if (!r.ok) assertEquals(r.errors[0].field, 'website')
})

Deno.test('validateInterest truncates oversized free text instead of rejecting it', () => {
  const r = validateInterest({ email: 'a@b.co', source: 'launch', building: 'x'.repeat(1000) })
  assertEquals(r.ok, true)
  if (r.ok) assertEquals(r.value.building?.length, 600)
})

Deno.test('submitInterest maps transport outcomes to form-friendly reasons', async () => {
  const input = { email: 'a@b.co', source: 'launch' as const }
  const okFetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ position: 42 }), { status: 200 }),
    )) as typeof fetch
  assertEquals(await submitInterest(input, okFetch), {
    ok: true,
    position: 42,
    alreadyRegistered: false,
  })

  const downFetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch
  assertEquals(await submitInterest(input, downFetch), { ok: false, reason: 'offline' })

  const errFetch = (() => Promise.resolve(new Response('boom', { status: 500 }))) as typeof fetch
  assertEquals(await submitInterest(input, errFetch), { ok: false, reason: 'server' })

  const invalid = await submitInterest({ email: 'bad', source: 'launch' }, okFetch)
  assertEquals(invalid.ok, false)
  if (!invalid.ok) assertEquals(invalid.reason, 'invalid')
})
