import { assertEquals } from 'jsr:@std/assert@1'
import { LABEL_APPLICATION, targetApplication } from './perf-format.ts'
import { gateEnv } from './perf-gate.ts'
import { recordFromConfigMap, resultConfigMap } from './perf-results.ts'
import { artefactConfigMap, RUN_SCRIPT } from './perf-runner.ts'
import { DEFAULT_CONFIG } from './perf-format.ts'

// A Performance Center result counts towards an application's scorecard only
// when it says which application it measured. The scorer joins on
// `adhar.io/application` — the key the delivery chain already uses — so every
// path that writes a result must carry it, and nothing may guess one.

Deno.test('the target application comes from the selector, else the service, never a guess', () => {
  assertEquals(targetApplication({ target: { selector: 'app=checkout,tier=web' } }), 'checkout')
  assertEquals(targetApplication({ target: { selector: 'app.kubernetes.io/name=cart' } }), 'cart')
  assertEquals(targetApplication({ target: { service: 'shop.test.svc.cluster.local' } }), 'shop')
  assertEquals(targetApplication({ target: { selector: 'tier=web' } }), undefined)
  assertEquals(targetApplication({ target: { selector: 'app=Not_A_Label' } }), undefined)
  assertEquals(targetApplication({}), undefined)
})

Deno.test('scheduled and CI runs label their result with the application', () => {
  const config = { ...DEFAULT_CONFIG, namespace: 'test', target: { selector: 'app=checkout' } }
  const cm = artefactConfigMap({ test: 'checkout-load', config, script: 'export default function () {}' })
  assertEquals(cm.data['gate.env'].includes("TARGET_APP='checkout'"), true)
  const run = JSON.parse(cm.data['testrun.json'])
  assertEquals(run.metadata.labels[LABEL_APPLICATION], 'checkout')
  // The adhar-controlplane runner stamps it on the result it creates.
  assertEquals(RUN_SCRIPT.includes('${TARGET_APP:+"adhar.io/application=$TARGET_APP"}'), true)
  // And sets it empty before sourcing, so an older gate.env cannot leak one.
  assertEquals(RUN_SCRIPT.includes("TARGET_APP=''"), true)
  assertEquals(gateEnv({ test: 't', namespace: 'n' }).includes("TARGET_APP=''"), true)
})

Deno.test('console-launched runs keep the application through the harvest round-trip', () => {
  const cm = resultConfigMap({
    run: 'checkout-load-abc', test: 'checkout-load', namespace: 'test', summaryText: '', trigger: 'console',
    application: 'checkout',
  })
  assertEquals(cm.metadata.labels[LABEL_APPLICATION], 'checkout')
  assertEquals(recordFromConfigMap(cm)?.application, 'checkout')
  const none = resultConfigMap({ run: 'r', test: 't', namespace: 'n', summaryText: '', trigger: 'console' })
  assertEquals(LABEL_APPLICATION in none.metadata.labels, false)
})

Deno.test('a test that lives in an app repo is labelled with that app, whatever its selector says', () => {
  const config = { ...DEFAULT_CONFIG, namespace: 'test', target: { selector: 'app=checkout-api' } }
  const cm = artefactConfigMap({ test: 'checkout-load', config, script: '', commit: 'abc', application: 'checkout' })
  assertEquals(JSON.parse(cm.data['testrun.json']).metadata.labels[LABEL_APPLICATION], 'checkout')
  assertEquals(cm.data['gate.env'].includes("TARGET_APP='checkout'"), true)
  // No repo (an artefact from before tests lived with their app): the selector still decides.
  const legacy = artefactConfigMap({ test: 'checkout-load', config, script: '' })
  assertEquals(JSON.parse(legacy.data['testrun.json']).metadata.labels[LABEL_APPLICATION], 'checkout-api')
})
