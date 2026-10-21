/**
 * Every service a template creates arrives with a performance test.
 *
 * Templates ship `perf/load.js` (a k6 smoke-load script) and `perf/test.json`
 * (its Performance Center configuration: runs in `test`, targets
 * `app=<name>`, gates on the template's latency target). The Performance
 * Center does not read application repositories — its tests live in one suite
 * repository, `tests/<test>/{script.js,test.json}` — so the scaffolder copies
 * the pair there as `tests/<name>-load`. From then on the test shows up in the
 * Performance Center, runs from it, and its gate verdicts count towards the
 * service's scorecard (the result carries `adhar.io/application=<name>`).
 *
 * Pure: picks and renames files; the scaffolder does the writing.
 */

export const PERF_SUITE_REPO = 'performance-tests'

export interface SuiteFile {
  path: string
  base64: string
}

/** The suite files for a scaffolded service, or null when its template ships no test. */
export function perfSuiteFiles(rendered: readonly SuiteFile[], name: string): { test: string; files: SuiteFile[] } | null {
  const script = rendered.find((f) => f.path === 'perf/load.js')
  const config = rendered.find((f) => f.path === 'perf/test.json')
  if (!script || !config) return null
  const test = `${name}-load`.slice(0, 63).replace(/-+$/, '')
  return {
    test,
    files: [
      { path: `tests/${test}/script.js`, base64: script.base64 },
      { path: `tests/${test}/test.json`, base64: config.base64 },
    ],
  }
}
