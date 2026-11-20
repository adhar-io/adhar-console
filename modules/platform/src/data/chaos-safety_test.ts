import { assert, assertEquals } from 'jsr:@std/assert@1'
import { fieldErrors, isProductionNamespace, isProtectedNamespace, launchAllowed, MAX_FAULT_SECONDS, reviewLaunch, type LaunchReview } from './chaos-safety.ts'

const base: LaunchReview = { name: 'cart-pod-delete', namespace: 'shop-test', label: 'app=cart', mode: 'one', blast: 'low', seconds: 30, hasProbe: true }

Deno.test('a bounded, probed, labelled run in an app namespace has no rails', () => {
  assertEquals(reviewLaunch(base), [])
  assert(launchAllowed([], '', base.name))
})

Deno.test('platform namespaces, over-long runs, bad names and bad shares are blocked outright', () => {
  for (const ns of ['kube-system', 'adhar-system', 'argocd', 'kube-flannel']) {
    const g = reviewLaunch({ ...base, namespace: ns })
    assertEquals(g[0].level, 'block')
    assert(!launchAllowed(g, base.name, base.name), ns)
  }
  assertEquals(reviewLaunch({ ...base, seconds: MAX_FAULT_SECONDS + 1 })[0].level, 'block')
  assertEquals(reviewLaunch({ ...base, seconds: 0 })[0].level, 'block')
  assertEquals(reviewLaunch({ ...base, name: 'Cart_Run' })[0].level, 'block')
  assertEquals(reviewLaunch({ ...base, mode: 'percent', percent: '150' })[0].level, 'block')
  assertEquals(reviewLaunch({ ...base, namespace: undefined })[0].level, 'block')
  // Applying an existing name would silently rewrite that run.
  assertEquals(reviewLaunch({ ...base, taken: ['cart-pod-delete'] })[0].level, 'block')
  // A game day has its own, larger cap.
  assertEquals(reviewLaunch({ ...base, seconds: 1800, maxSeconds: 3600 }), [])
})

Deno.test('high blast, every pod, nodes and production need the name typed back', () => {
  for (const over of [{ blast: 'high' as const }, { mode: 'all' as const }, { namespace: 'shop-prod' }, { node: true, namespace: undefined }]) {
    const g = reviewLaunch({ ...base, ...over })
    assert(g.some((x) => x.level === 'confirm'), JSON.stringify(over))
    assert(!launchAllowed(g, '', base.name))
    assert(!launchAllowed(g, 'cart', base.name))
    assert(launchAllowed(g, ` ${base.name} `, base.name))
  }
})

Deno.test('a missing probe or label is said, not refused — and blocks sort first', () => {
  const g = reviewLaunch({ ...base, hasProbe: false, label: '', blast: 'high', seconds: 9999 })
  assertEquals(g.map((x) => x.level), ['block', 'confirm', 'warn', 'warn'])
  assert(launchAllowed(reviewLaunch({ ...base, hasProbe: false }), '', base.name))
})

Deno.test('namespace classification', () => {
  assert(isProtectedNamespace('kube-anything'))
  assert(!isProtectedNamespace('shop-test'))
  assert(isProductionNamespace('prod'))
  assert(isProductionNamespace('payments-production'))
  assert(isProductionNamespace('shop', { 'adhar.io/environment': 'prod' }))
  assert(!isProductionNamespace('product-catalog'))
})

Deno.test('fieldErrors names the field that is wrong, and nothing for a valid form', () => {
  assertEquals(fieldErrors({ seconds: '30', mode: 'one', label: 'app=cart', probeUrl: 'http://cart.shop.svc/health', probeCode: '200' }), {})
  assertEquals(fieldErrors({ seconds: '' }).seconds, 'A positive number of seconds.')
  assertEquals(fieldErrors({ seconds: 'abc' }).seconds, 'A positive number of seconds.')
  assertEquals(fieldErrors({ seconds: String(MAX_FAULT_SECONDS + 1) }).seconds, `At most ${MAX_FAULT_SECONDS}s.`)
  assertEquals(fieldErrors({ seconds: '900', maxSeconds: 3600 }).seconds, undefined)
  assertEquals(fieldErrors({ mode: 'percent', percent: '0' }).percent, 'Between 1 and 100.')
  assertEquals(fieldErrors({ mode: 'percent', percent: '' }).percent, 'Between 1 and 100.')
  // The percent only matters when the mode uses it.
  assertEquals(fieldErrors({ mode: 'one', percent: '' }).percent, undefined)
  assertEquals(fieldErrors({ label: 'app = cart' }).label !== undefined, true)
  assertEquals(fieldErrors({ label: 'app.kubernetes.io/name=cart' }).label, undefined)
})

Deno.test('a probe must be an http(s) URL with a real status code; no probe needs neither', () => {
  assertEquals(fieldErrors({ probeUrl: 'cart/health', probeCode: '200' }).probeUrl !== undefined, true)
  assertEquals(fieldErrors({ probeUrl: 'ftp://cart', probeCode: '200' }).probeUrl !== undefined, true)
  assertEquals(fieldErrors({ probeUrl: 'http://cart', probeCode: '20x' }).probeCode, 'A status code, 100–599.')
  assertEquals(fieldErrors({ probeUrl: 'http://cart', probeCode: '700' }).probeCode, 'A status code, 100–599.')
  assertEquals(fieldErrors({ probeUrl: '', probeCode: 'nonsense' }), {})
})

Deno.test('a game day recovery pause is whole seconds, zero allowed', () => {
  assertEquals(fieldErrors({ recovery: '0' }), {})
  assertEquals(fieldErrors({ recovery: '-5' }).recovery, 'Whole seconds, 0 or more.')
  assertEquals(fieldErrors({ recovery: '1.5' }).recovery, 'Whole seconds, 0 or more.')
  assertEquals(fieldErrors({ recovery: '' }).recovery, 'Whole seconds, 0 or more.')
})
