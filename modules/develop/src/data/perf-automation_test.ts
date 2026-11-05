import { assertEquals } from 'jsr:@std/assert@1'
import { artefactOf } from './perf-automation.ts'
import { DEFAULT_CONFIG } from './perf-format.ts'
import { locationOf } from './perf-location.ts'

// Schedules, the CI tab's runner install and a pinned baseline all rewrite the
// artefact `k6-<test>` — the same ConfigMap "Run test" writes. Each write keeps
// exactly one script key, so they must agree on it: the extension of the
// test's file. Keyed script.js, a TypeScript load.ts fails in the initializer;
// keyed script.ts, a legacy load.js test loses (server-side apply prunes it)
// the script.js an earlier console run — and its "Run again" — still names.

Deno.test('the artefact schedules and CI run from keeps the committed extension', () => {
  const config = { ...DEFAULT_CONFIG, namespace: 'perf' }
  const cases = [
    [locationOf('adhar', { name: 'checkout' }), 'script.ts'],
    [locationOf('adhar', { name: 'checkout' }, undefined, { script: 'load.js' }), 'script.js'],
    [locationOf('adhar', { name: 'checkout' }, 'smoke', { script: 'load.ts', ignoredScript: 'load.js' }), 'script.ts'],
  ] as const
  for (const [location, key] of cases) {
    const cm = artefactOf({ name: location.name, config, script: 'export default function () {}', location }, 'abc1234')
    assertEquals(cm.metadata.name, `k6-${location.name}`)
    assertEquals(Object.keys(cm.data).filter((k) => /\.(js|ts)$/.test(k)), [key], location.script)
    const template = JSON.parse(cm.data['testrun.json'])
    assertEquals(template.spec.script.configMap.file, key, location.script)
    // The scheduled run counts on the app the repo is.
    assertEquals(template.metadata.labels['adhar.io/application'], 'checkout')
    assertEquals(cm.metadata.labels['adhar.io/perf-commit'], 'abc1234')
  }
})
