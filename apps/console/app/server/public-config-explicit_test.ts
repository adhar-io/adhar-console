import { assertEquals } from 'jsr:@std/assert@1'
import { isExplicitToolUrl } from './public-config.ts'

Deno.test('a URL derived on the platform base domain is not evidence a tool exists', () => {
  // toolUrl() falls back to https://<tool>.<base> for every registry tool.
  assertEquals(isExplicitToolUrl('https://mlflow.dev.adhar.io', 'dev.adhar.io'), false)
  assertEquals(isExplicitToolUrl('https://dev.adhar.io', 'dev.adhar.io'), false)
  assertEquals(isExplicitToolUrl('', 'dev.adhar.io'), false)
})

Deno.test('a URL on another host is an operator-set external service', () => {
  assertEquals(isExplicitToolUrl('https://mlflow.example.com', 'dev.adhar.io'), true)
  assertEquals(isExplicitToolUrl('https://notdev.adhar.io', 'dev.adhar.io'), true)
  assertEquals(isExplicitToolUrl('not a url', 'dev.adhar.io'), false)
})

Deno.test('a local base domain carries a port, and a derived URL is still not explicit', () => {
  // On Kind the base is adhar.localtest.me:8443. Comparing it to a port-less hostname
  // marked every derived URL explicit, so Plane and MLflow kept tiles with nothing installed.
  assertEquals(isExplicitToolUrl('https://plane.adhar.localtest.me:8443', 'adhar.localtest.me:8443'), false)
  assertEquals(isExplicitToolUrl('https://adhar.localtest.me:8443', 'adhar.localtest.me:8443'), false)
  assertEquals(isExplicitToolUrl('https://mlflow.example.com', 'adhar.localtest.me:8443'), true)
})
