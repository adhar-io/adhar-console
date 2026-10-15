import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { durationSeconds, generateScript, profileStages, quickConfig, type QuickSpec, specErrors, totalSeconds } from './perf-quick.ts'

const base: QuickSpec = {
  name: 'checkout-api',
  requests: [{ name: 'list products', method: 'GET', url: 'https://shop.example.com/api/products', headers: [] }],
  profile: 'load',
  peakVus: 50,
  stages: [],
  thinkTimeS: 1,
  thresholds: { p95Ms: 500, errorRatePct: 1, checksPct: 99 },
  namespace: 'perf',
  parallelism: 2,
}

Deno.test('durations parse, including compound ones', () => {
  assertEquals(durationSeconds('30s'), 30)
  assertEquals(durationSeconds('2m'), 120)
  assertEquals(durationSeconds('1h30m'), 5400)
  assertEquals(durationSeconds('500ms'), 0.5)
  assert(Number.isNaN(durationSeconds('2 minutes')))
  assert(Number.isNaN(durationSeconds('')))
})

Deno.test('named profiles scale to the peak', () => {
  assertEquals(profileStages('load', 50).map((s) => s.target), [50, 50, 0])
  assertEquals(Math.max(...profileStages('stress', 50).map((s) => s.target)), 100)
  assertEquals(Math.max(...profileStages('spike', 50).map((s) => s.target)), 200)
  assertEquals(profileStages('smoke', 50)[0].target, 2)
  assertEquals(profileStages('custom', 5, [{ duration: '10s', target: 3 }]), [{ duration: '10s', target: 3 }])
  assertEquals(totalSeconds(profileStages('load', 10)), 480)
})

Deno.test('the script declares stages, thresholds and one check per request', () => {
  const s = generateScript(base)
  assertStringIncludes(s, `{ duration: "2m", target: 50 }`)
  assertStringIncludes(s, `http_req_duration: ["p(95)<500"]`)
  assertStringIncludes(s, `http_req_failed: ["rate<0.01"]`)
  assertStringIncludes(s, `checks: ["rate>0.99"]`)
  assertStringIncludes(s, `http.get("https://shop.example.com/api/products"`)
  assertStringIncludes(s, `"list products: 2xx"`)
  assertStringIncludes(s, 'sleep(1)')
})

Deno.test('bodies and headers are quoted safely', () => {
  const s = generateScript({
    ...base,
    requests: [{ name: 'create "order"', method: 'POST', url: 'https://x.test/o', headers: [['Content-Type', 'application/json']], body: '{"sku":"a\'b"}', expectStatus: 201 }],
  })
  assertStringIncludes(s, `http.post("https://x.test/o", "{\\"sku\\":\\"a'b\\"}"`)
  assertStringIncludes(s, `"Content-Type": "application/json"`)
  assertStringIncludes(s, `res.status === 201`)
  assertStringIncludes(s, `name: "create \\"order\\""`)
})

Deno.test('validation names the broken field', () => {
  assertEquals(specErrors(base, profileStages('load', 50)), [])
  const bad = specErrors({ ...base, requests: [{ name: '', method: 'POST', url: 'shop/api', headers: [['content-type', 'application/json']], body: '{oops' }] }, [{ duration: 'soon', target: 0 }])
  assertEquals(bad.length, 4)
})

Deno.test('config mirrors the thresholds and names the target service', () => {
  const c = quickConfig(base)
  assertEquals(c.namespace, 'perf')
  assertEquals(c.parallelism, 2)
  assertEquals(c.thresholds.map((t) => t.expression), ['p(95)<500', 'rate<0.01', 'rate>0.99'])
  assertEquals(c.target?.service, 'shop.example.com')
  assertEquals(c.title, 'Checkout Api')
})
