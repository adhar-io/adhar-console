import { assertEquals } from 'jsr:@std/assert'
import { panelsFor } from './perf-metrics.ts'

/**
 * These queries are the report. A subtly wrong one does not fail — it draws a
 * confident chart of the wrong pods, which is worse than drawing nothing,
 * because someone will size a cluster from it.
 */

const RUNNERS = { runnerNamespace: 'payments', runnerSelector: 'checkout-load-.*' }

Deno.test('without a target selector, no workload panels are guessed', () => {
  // Charting the wrong pods looks authoritative. Better to show none.
  const panels = panelsFor(RUNNERS)
  assertEquals(panels.some((p) => p.group === 'workload'), false)
  assertEquals(panels.some((p) => p.group === 'runners'), true)
  assertEquals(panels.some((p) => p.group === 'infrastructure'), true)
})

Deno.test('a namespace without a selector is still not enough', () => {
  const panels = panelsFor({ ...RUNNERS, target: { namespace: 'payments' } })
  assertEquals(panels.some((p) => p.group === 'workload'), false)
})

Deno.test('a selector is applied by joining kube_pod_labels, not by guessing pod names', () => {
  // cAdvisor series carry namespace and pod but not `app`, so the selector has
  // to come from kube-state-metrics via a join.
  const panels = panelsFor({ ...RUNNERS, target: { namespace: 'payments', selector: 'app=checkout' } })
  const cpu = panels.find((p) => p.id === 'target-cpu')!
  assertEquals(cpu.query.includes('container_cpu_usage_seconds_total'), true)
  assertEquals(cpu.query.includes('on (namespace, pod) group_left'), true)
  assertEquals(cpu.query.includes('kube_pod_labels{namespace="payments",label_app="checkout"}'), true)
})

Deno.test('multi-label selectors become multiple matchers', () => {
  const panels = panelsFor({ ...RUNNERS, target: { namespace: 'payments', selector: 'app=checkout, tier=web' } })
  const cpu = panels.find((p) => p.id === 'target-cpu')!
  assertEquals(cpu.query.includes('label_app="checkout",label_tier="web"'), true)
})

Deno.test('label keys are folded the way kube-state-metrics folds them', () => {
  // `app.kubernetes.io/name` is exported as `label_app_kubernetes_io_name`.
  const panels = panelsFor({
    ...RUNNERS,
    target: { namespace: 'payments', selector: 'app.kubernetes.io/name=checkout' },
  })
  const cpu = panels.find((p) => p.id === 'target-cpu')!
  assertEquals(cpu.query.includes('label_app_kubernetes_io_name="checkout"'), true)
})

Deno.test('throttling is a ratio that cannot divide by zero', () => {
  const panels = panelsFor({ ...RUNNERS, target: { namespace: 'payments', selector: 'app=checkout' } })
  const t = panels.find((p) => p.id === 'target-throttle')!
  // An idle container reports zero periods; without the clamp this panel
  // would render NaN exactly when the system was quiet.
  assertEquals(t.query.includes('clamp_min('), true)
})

Deno.test('container filters exclude the pause container', () => {
  // `container="POD"` is the pause container; counting it double-counts
  // nothing useful and inflates pod-level memory.
  const panels = panelsFor({ ...RUNNERS, target: { namespace: 'payments', selector: 'app=checkout' } })
  for (const id of ['target-cpu', 'target-memory']) {
    const q = panels.find((p) => p.id === id)!.query
    assertEquals(q.includes('container!="POD"'), true, `${id} must exclude the pause container`)
    assertEquals(q.includes('container!=""'), true, `${id} must exclude pod-level rollups`)
  }
})

Deno.test('runner panels are scoped to the run, not the whole namespace', () => {
  const panels = panelsFor(RUNNERS)
  const cpu = panels.find((p) => p.id === 'runner-cpu')!
  assertEquals(cpu.query.includes('namespace="payments"'), true)
  assertEquals(cpu.query.includes('pod=~"checkout-load-.*"'), true)
})

Deno.test('node network excludes virtual interfaces', () => {
  // lo/veth/cali/cilium would double-count every pod-to-pod byte and swamp
  // the real number.
  const q = panelsFor(RUNNERS).find((p) => p.id === 'node-network')!.query
  assertEquals(q.includes('device!~"lo|veth.*|cali.*|cilium.*"'), true)
})

Deno.test('quotes and backslashes in a selector cannot break out of the matcher', () => {
  const panels = panelsFor({
    ...RUNNERS,
    target: { namespace: 'payments', selector: 'app=we"ird\\value' },
  })
  const q = panels.find((p) => p.id === 'target-cpu')!.query
  assertEquals(q.includes('label_app="we\\"ird\\\\value"'), true)
})

Deno.test('every panel declares a unit and an explanation', () => {
  // A chart without a unit misleads, and one without a hint is a shape.
  for (const p of panelsFor({ ...RUNNERS, target: { namespace: 'n', selector: 'app=x' } })) {
    assertEquals(p.unit.length > 0, true, `${p.id} needs a unit`)
    assertEquals(p.hint.length > 10, true, `${p.id} needs an explanation`)
    assertEquals(p.title.length > 0, true, `${p.id} needs a title`)
  }
})

Deno.test('panel ids are unique — they key the query cache', () => {
  const panels = panelsFor({ ...RUNNERS, target: { namespace: 'n', selector: 'app=x' } })
  assertEquals(new Set(panels.map((p) => p.id)).size, panels.length)
})
