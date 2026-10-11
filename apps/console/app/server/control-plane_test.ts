import { assertEquals, assertThrows } from 'jsr:@std/assert@^1.0.0'
import { applyXr, organisationManifest, teamManifest, xrPath } from './control-plane.ts'

// What the switcher's "New organization" sends to the control plane: the XR
// the platform's own example (examples/organisation.yaml) describes, named by
// the slug, in the tenancy namespace, with the Gitea organisation requested.
Deno.test('an organisation becomes the Organisation XR the platform expects', () => {
  const m = organisationManifest({ slug: 'acme', name: 'ACME Corporation', description: ' The tenant ' })
  assertEquals(m.apiVersion, 'platform.adhar.io/v1alpha1')
  assertEquals(m.kind, 'Organisation')
  assertEquals(m.metadata.name, 'acme')
  assertEquals(m.metadata.namespace, 'adhar-system')
  assertEquals(m.spec.parameters, {
    name: 'acme',
    displayName: 'ACME Corporation',
    createGiteaOrganisation: true,
    description: 'The tenant',
  })
  assertEquals(xrPath(m), '/apis/platform.adhar.io/v1alpha1/namespaces/adhar-system/organisations/acme')
})

Deno.test('a team names its organisation and is unique across organisations', () => {
  const m = teamManifest({ slug: 'payments', name: 'Payments' }, 'acme')
  assertEquals(m.kind, 'Team')
  assertEquals(m.metadata.name, 'acme-payments')
  assertEquals(m.spec.parameters, { name: 'payments', organisation: 'acme', displayName: 'Payments' })
  assertEquals(m.metadata.labels['adhar.io/organisation'], 'acme')
  assertEquals(xrPath(m), '/apis/platform.adhar.io/v1alpha1/namespaces/adhar-system/teams/acme-payments')
})

// The slug is the object name AND a path segment; anything else is refused
// before it reaches the apiserver.
Deno.test('a name that is not a DNS-1123 label is refused', () => {
  assertThrows(() => organisationManifest({ slug: 'ACME Corp', name: 'x' }))
  assertThrows(() => teamManifest({ slug: 'ok', name: 'x' }, 'bad/slug'))
})

Deno.test('applying without a ServiceAccount token reports, never throws', async () => {
  const out = await applyXr(organisationManifest({ slug: 'acme', name: 'ACME' }), undefined)
  assertEquals(out.ok, false)
  assertEquals(out.status, 0)
})

/* ── an XR is identified by what it composes, not by its object name ── */

Deno.env.set('K8S_API_URL', 'https://apiserver.test')

interface Call {
  url: string
  method: string
}

/** Stub the apiserver: one listing, then record every write. */
function stubApiServer(list: { status: number; items?: unknown[] }): { calls: Call[]; restore: () => void } {
  const calls: Call[] = []
  const real = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url, method })
    if (method === 'GET') {
      return Promise.resolve(
        new Response(list.status === 200 ? JSON.stringify({ items: list.items ?? [] }) : 'denied', {
          status: list.status,
        }),
      )
    }
    return Promise.resolve(new Response('{}', { status: 200 }))
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}

const platformsOwnTeam = {
  metadata: { name: 'platform' },
  spec: { parameters: { name: 'platform', organisation: 'adhar' } },
}

// The platform's own tenancy (the adhar-supply-chain package) seeds
// `Team/platform` by the BARE slug, and the Team composition derives the
// Keycloak group and the Gitea team from spec.parameters — so applying a
// second XR named `adhar-platform` with the same parameters would stand up a
// duplicate owner for `ws-team-platform`. Nothing may be written.
Deno.test('a team the platform already declares is never written again', async () => {
  const { calls, restore } = stubApiServer({ status: 200, items: [platformsOwnTeam] })
  try {
    const out = await applyXr(teamManifest({ slug: 'platform', name: 'Platform team' }, 'adhar'), 'tok')
    assertEquals(out.ok, true)
    assertEquals(calls.filter((c) => c.method !== 'GET').length, 0)
  } finally {
    restore()
  }
})

// Same subject, but this one is the console's own: re-apply it under the name
// it already has rather than creating a second object.
Deno.test('a console-declared team is adopted under the name it already has', async () => {
  const mine = {
    metadata: { name: 'platform', labels: { 'adhar.io/managed-by': 'adhar-console' } },
    spec: { parameters: { name: 'platform', organisation: 'adhar' } },
  }
  const { calls, restore } = stubApiServer({ status: 200, items: [mine] })
  try {
    const out = await applyXr(teamManifest({ slug: 'platform', name: 'Platform team' }, 'adhar'), 'tok')
    assertEquals(out.ok, true)
    const writes = calls.filter((c) => c.method === 'PATCH')
    assertEquals(writes.length, 1)
    assertEquals(writes[0].url.includes('/teams/platform?'), true)
    assertEquals(writes[0].url.includes('adhar-platform'), false)
  } finally {
    restore()
  }
})

// A team of the same name in ANOTHER organisation composes a different group,
// so it is a different subject and gets its own object.
Deno.test('the same team name in another organisation is a different subject', async () => {
  const { calls, restore } = stubApiServer({ status: 200, items: [platformsOwnTeam] })
  try {
    await applyXr(teamManifest({ slug: 'platform', name: 'Platform' }, 'acme'), 'tok')
    const writes = calls.filter((c) => c.method === 'PATCH')
    assertEquals(writes.length, 1)
    assertEquals(writes[0].url.includes('/teams/acme-platform?'), true)
  } finally {
    restore()
  }
})

// No CRD, no permission, no cluster: fall back to applying the console's own
// name, which is what it did before the lookup existed.
Deno.test('a lookup the console may not make still applies its own name', async () => {
  const { calls, restore } = stubApiServer({ status: 403 })
  try {
    await applyXr(organisationManifest({ slug: 'acme', name: 'ACME' }), 'tok')
    const writes = calls.filter((c) => c.method === 'PATCH')
    assertEquals(writes.length, 1)
    assertEquals(writes[0].url.includes('/organisations/acme?'), true)
  } finally {
    restore()
  }
})
