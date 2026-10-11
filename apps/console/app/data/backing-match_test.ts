import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { foldHealth, imageVersion, matchWorkloads, type Workload } from './backing-match.ts'

const w = (name: string, ready: number, desired: number): Workload => ({ name, kind: 'Deployment', ready, desired })

Deno.test('imageVersion reads tags and leaves untagged images alone', () => {
  assertEquals(imageVersion('ghcr.io/adhar-io/adhar:0.1.38'), '0.1.38')
  assertEquals(imageVersion('localhost:5000/adhar-console:v0.1.118'), 'v0.1.118')
  assertEquals(imageVersion('localhost:5000/adhar-console'), undefined)
  assertEquals(imageVersion('quay.io/argoproj/argocd:v2.13.3@sha256:abcdef0123456789'), 'v2.13.3')
  assertEquals(imageVersion(undefined), undefined)
})

Deno.test('matchWorkloads keeps plane away from crossplane', () => {
  const all = [w('plane-api', 1, 1), w('crossplane', 1, 1), w('control-plane-x', 1, 1)]
  assertEquals(matchWorkloads(all, 'plane').map((x) => x.name), ['plane-api'])
})

Deno.test('foldHealth grades operational, degraded, outage and unknown', () => {
  assertEquals(foldHealth([w('a', 2, 2)]).health, 'operational')
  assertEquals(foldHealth([w('a', 1, 2)]).health, 'degraded')
  assertEquals(foldHealth([w('a', 0, 2)]).health, 'outage')
  assertEquals(foldHealth([]).health, 'unknown')
})
