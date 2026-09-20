import { assertEquals, assertExists } from 'jsr:@std/assert'
import { routeTarget } from './notification-route.ts'

/** Route an href the test expects to be routable, narrowing away the `null`
 *  so a regression that starts returning null fails here rather than at a
 *  property read. */
function must(href: string) {
  const target = routeTarget(href)
  assertExists(target, `${href} should route`)
  return target
}

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
  assertEquals(must('/deliver?section=apps&app=my%20app').search.app, 'my app')
})

Deno.test('a trailing slash does not make a second route', () => {
  assertEquals(must('/settings/').to, '/settings')
  // The root is a path in its own right.
  assertEquals(must('/').to, '/')
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
