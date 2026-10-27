import { assert } from 'jsr:@std/assert@^1.0.0'

// The console went down twice with the Gateway reporting "upstream connect
// error … delayed connect error: Connection refused". The live hub appended a
// refreshed session cookie to its WebSocket upgrade response; those headers are
// immutable, the throw meant the upgrade response was never returned, and
// Deno (2.1.4, reproduced) stopped its listener while the process lived on.

const source = (path: string) => Deno.readTextFile(new URL(path, import.meta.url))

Deno.test('the live hub never touches its WebSocket upgrade response', async () => {
  const live = await source('./live.ts')
  const mutation = /\bresponse\.headers\.(append|set|delete)\s*\(/
  assert(
    !mutation.test(live),
    'live.ts mutates the upgrade response from Deno.upgradeWebSocket: its headers are immutable, the throw ' +
      'stops Deno\'s listener. Deliver anything else (a refreshed cookie) on a plain HTTP request instead.',
  )
})

Deno.test('the server exits when its listener stops without a drain', async () => {
  const server = await source('../../server.ts')
  assert(
    /server\.finished\.then\(/.test(server),
    'server.ts must watch server.finished: a listener that dies on its own otherwise leaves a live process ' +
      'answering "connection refused" until the liveness probe gives up.',
  )
})
