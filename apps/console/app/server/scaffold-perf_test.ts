import { assertEquals } from 'jsr:@std/assert@1'
import { perfSuiteFiles } from './scaffold-perf.ts'

Deno.test('a template\'s perf test becomes tests/<name>-load in the Performance Center suite', () => {
  const out = perfSuiteFiles([
    { path: 'deploy/base/service.yaml', base64: 'eA==' },
    { path: 'perf/load.js', base64: 'anM=' },
    { path: 'perf/test.json', base64: 'e30=' },
  ], 'checkout')
  assertEquals(out?.test, 'checkout-load')
  assertEquals(out?.files.map((f) => `${f.path}=${f.base64}`), ['tests/checkout-load/script.js=anM=', 'tests/checkout-load/test.json=e30='])
})

Deno.test('a template without a perf test registers nothing', () => {
  assertEquals(perfSuiteFiles([{ path: 'perf/load.js', base64: 'anM=' }], 'x'), null)
  assertEquals(perfSuiteFiles([], 'x'), null)
})
