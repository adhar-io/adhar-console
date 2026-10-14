import { assert, assertEquals } from 'jsr:@std/assert@1'

const SRC = new URL('./organizations.ts', import.meta.url)
const src = await Deno.readTextFile(SRC)

/**
 * The console's placeholder organisation must never reach the control plane.
 *
 * `readRegistry` invents a "Default Organization" with the bare slug `default`
 * whenever this console has no registry of its own yet. The Organisation
 * composition owns its home namespace through a provider-kubernetes Object
 * with the default deletionPolicy, so an organisation called `default` ADOPTS
 * the Kubernetes default namespace and deleting it would delete that namespace.
 *
 * Live on 2026-10-13, with the console database freshly restored and empty,
 * the backfill promoted the placeholder into a real XR and the cluster held:
 *
 *   Object default-4b2adbac9cdf | manages ns: default
 *     | deletionPolicy: <default=Delete> | mgmtPolicies: ['*'] | owner XR: ['default']
 */
Deno.test('the seeded placeholder organisation is never back-filled', () => {
  assert(
    /seeded:\s*true/.test(src),
    'readRegistry no longer marks its invented registry as seeded, so nothing downstream can tell a ' +
      'placeholder from a real organisation',
  )
  const call = src.indexOf('backfillXrs(')
  assert(call > 0, 'organizations.ts no longer back-fills at all; this guard needs updating')
  const guardAt = src.indexOf('if (!reg.seeded)')
  assert(
    guardAt > 0 && guardAt < call,
    'the backfill is reached without first checking reg.seeded — a console with no registry ' +
      'would publish its placeholder as a real Organisation XR',
  )
})

Deno.test('reserved namespace names are never published as organisations', () => {
  for (const ns of ['default', 'kube-system', 'kube-public', 'kube-node-lease', 'adhar-system']) {
    assert(
      src.includes(`'${ns}'`),
      `${ns} is missing from RESERVED_ORG_SLUGS; an organisation of that name would adopt the namespace`,
    )
  }
  assert(
    /RESERVED_ORG_SLUGS\.has\(o\.slug\)/.test(src),
    'the backfill does not filter reserved slugs, so a registry carrying one would still publish it',
  )
})

// The seed is the only path that can produce a bare slug: a created
// organisation always carries a random suffix, so it can never collide with a
// namespace name by accident.
Deno.test('a created organisation always carries a random suffix', () => {
  assertEquals(/const id = `\$\{slugify\(name\)\}-\$\{randomSuffix\(\)\}`/.test(src), true)
})
