import { assertEquals } from 'jsr:@std/assert'
import { routeTarget } from './notification-route.ts'

/**
 * Notification hrefs are stored as plain strings (`/settings?section=teams`)
 * because that is what a server writing a notification can produce. The router
 * wants them split. Getting that wrong 404s every notification in the product,
 * silently, which is what happened.
 */

Deno.test('a query string becomes search, never part of the path', () => {
  // The bug: `to: '/settings?section=teams'` matches no route.
  assertEquals(routeTarget('/settings?section=teams'), {
    to: '/settings',
    search: { section: 'teams' },
  })
  assertEquals(routeTarget('/platform?section=events&namespace=payments'), {
    to: '/platform',
    search: { section: 'events', namespace: 'payments' },
  })
})

Deno.test('a path with no query still routes', () => {
  assertEquals(routeTarget('/settings'), { to: '/settings', search: {} })
  assertEquals(routeTarget('/'), { to: '/', search: {} })
})

Deno.test('encoded values are decoded, as the router expects them', () => {
  assertEquals(routeTarget('/deliver?section=apps&app=my%20app').search.app, 'my app')
})

Deno.test('a trailing slash does not make a second route', () => {
  assertEquals(routeTarget('/settings/').to, '/settings')
  // The root is a path in its own right.
  assertEquals(routeTarget('/').to, '/')
})

Deno.test('anything that is not an internal path is refused', () => {
  // The caller renders unlinked text rather than a link that cannot work.
  assertEquals(routeTarget('https://example.com/x'), null)
  assertEquals(routeTarget('settings?section=teams'), null)
  assertEquals(routeTarget(''), null)
})

Deno.test('an empty query is not mistaken for a value', () => {
  assertEquals(routeTarget('/settings?'), { to: '/settings', search: {} })
})
