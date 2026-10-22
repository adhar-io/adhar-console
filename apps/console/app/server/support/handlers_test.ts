import { assertEquals } from 'jsr:@std/assert'
import { accessCheckFor } from './handlers.ts'
import { parseRef } from './classify.ts'

Deno.test('manual tickets require read access to what the ticket would carry', () => {
  const argo = parseRef({ key: 'argocd:adhar-system/adhar-gateway-service-dev:Degraded/Synced', title: 't' })
  assertEquals(accessCheckFor(argo), { verb: 'get', group: 'argoproj.io', resource: 'applications', namespace: 'adhar-system', name: 'adhar-gateway-service-dev' })
  const ev = parseRef({ key: 'event:dev/Pod/gateway-service-689ffd8cf6-7kj2j:OOMKilling:1', title: 't' })
  assertEquals(accessCheckFor(ev), { verb: 'get', group: '', resource: 'pods', subresource: 'log', namespace: 'dev' })
  const xr = parseRef({ key: 'xr:Database:dev/qua-service-db:u1:failed', title: 't' })
  assertEquals(accessCheckFor(xr), { verb: 'get', group: 'platform.adhar.io', resource: 'databases', namespace: 'dev' })
  // Anything unrecognised needs pod-log access in the platform namespace — operators only.
  assertEquals(accessCheckFor(null), { verb: 'get', group: '', resource: 'pods', subresource: 'log', namespace: 'adhar-system' })
})
