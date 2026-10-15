import { assertEquals } from 'jsr:@std/assert@1'
import { parseCustomHostnames, platformRouteHost, routeHostnames, SCAFFOLD_ENVIRONMENT } from './scaffold-hosts.ts'

Deno.test('the platform route carries the environment and never a port', () => {
  assertEquals(platformRouteHost('shop', SCAFFOLD_ENVIRONMENT, 'platform.adhar.io'), 'shop.dev.platform.adhar.io')
  assertEquals(platformRouteHost('shop', 'test', 'adhar.localtest.me:8443'), 'shop.test.adhar.localtest.me')
})

Deno.test('custom hostnames are appended after the platform route, cleaned and de-duplicated', () => {
  assertEquals(
    routeHostnames('shop.dev.platform.adhar.io', 'Shop.Example.org, https://www.example.org/, shop.example.org'),
    ['shop.dev.platform.adhar.io', 'shop.example.org', 'www.example.org'],
  )
  assertEquals(routeHostnames('a.dev.x.io', ['b.x.io', 'a.dev.x.io']), ['a.dev.x.io', 'b.x.io'])
  assertEquals(routeHostnames('a.dev.x.io', undefined), ['a.dev.x.io'])
  assertEquals(routeHostnames('a.dev.x.io', ''), ['a.dev.x.io'])
})

Deno.test('a value that is not a hostname is dropped rather than put into the route', () => {
  assertEquals(parseCustomHostnames('not a host, -bad.example.org, ok.example.org, *.wild.example.org'), [
    'ok.example.org',
    '*.wild.example.org',
  ])
  assertEquals(parseCustomHostnames(42), [])
})
