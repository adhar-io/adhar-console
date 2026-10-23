import { assert, assertFalse } from 'jsr:@std/assert'
import { isPlatformRoute } from './app-discovery.ts'

// The app drawer lists PLATFORM apps only. Teams' routes live in their
// environment namespaces and, when the environment repeats the host's first
// label, are one label deep (`my-service-dev.dev.adhar.io`) — the hostname rule
// alone turned them into drawer tiles (2026-10-24).
Deno.test('only routes in the platform namespace become launcher tiles', () => {
  assert(isPlatformRoute({ metadata: { namespace: 'adhar-system', name: 'tolgee' } }))
  for (const ns of ['dev', 'test', 'prod', 'adhar-environments', undefined]) {
    assertFalse(isPlatformRoute({ metadata: { namespace: ns, name: 'my-service' } }), `namespace ${ns}`)
  }
})

Deno.test('discovery applies the platform-route filter to every HTTPRoute', async () => {
  const src = await Deno.readTextFile(new URL('./app-discovery.ts', import.meta.url))
  assert(/for \(const it of body\.items \?\? \[\]\) \{\s*if \(!isPlatformRoute\(it\)\) continue/.test(src),
    'discoverRoutedApps must skip routes outside the platform namespace before reading hostnames')
})
