import { assert, assertMatch } from 'jsr:@std/assert@^1.0.0'

/**
 * W1 acceptance 1 (design 0026 §14): a team member sees their namespaces' runs
 * LIVE — by apiserver watch, not the 60 s poll. React hooks cannot run under
 * `deno test`, so this holds the wiring in the source: every view that lists
 * runs opens the per-namespace (or cluster-wide) watches for the Workflow
 * kind; the run list's only timer is the one that runs while the live socket
 * is down; and one run is watched by name at 2 Hz.
 */

const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url))

Deno.test('every view that lists runs opens watches on the Workflow kind for its scope', async () => {
  for (const view of ['views/runs.tsx', 'views/overview.tsx', 'views/catalog.tsx']) {
    const src = await read(view)
    assertMatch(src, /<ScopeWatches gvr=\{WORKFLOWS\} mode=\{runs?\.data\?\.mode\}|<ScopeWatches gvr=\{WORKFLOWS\} mode=\{q\.data\?\.mode\}/, `${view} lists runs without watching them`)
    assert(/queryKeys=\{\[(q|runs)\.queryKey\]\}/.test(src), `${view}'s watches must invalidate the list they keep live`)
  }
})

Deno.test('the run list polls only while the socket is down; one run is watched by name, throttled to 2 Hz', async () => {
  const src = await read('data/hooks.ts')
  const useRuns = src.slice(src.indexOf('export function useRuns'), src.indexOf('export function useRun('))
  assertMatch(useRuns, /refetchInterval: fallback/)
  assertMatch(src, /export function useFallbackInterval\(\): number \| false \{\n\s+return useLiveStatus\(\) === 'live' \? false : POLL_FLOOR_MS/)
  const useRun = src.slice(src.indexOf('export function useRun('), src.indexOf('export function useRunEvents'))
  assertMatch(useRun, /watchOf\(WORKFLOWS, \{ namespace, fieldSelector: `metadata\.name=\$\{name\}`/)
  assertMatch(useRun, /throttleMs: 500/)
  // A namespace list opens one watch per namespace — the one shape a team member's RBAC allows.
  assertMatch(src, /const targets = mode === 'cluster' \? \[undefined\] : namespaces/)
})

Deno.test('the run view is never another run: no placeholder across runs, nodes keyed by run', async () => {
  const src = await read('data/hooks.ts')
  const useRun = src.slice(src.indexOf('export function useRun('), src.indexOf('export function useRunEvents'))
  // keepPreviousData across query keys shows run A (and its Stop/Delete) under run B's title.
  assert(!/placeholderData: keepPreviousData/.test(useRun), 'useRun must not keep the previous run as a placeholder')
  assertMatch(useRun, /const run = isRun\(q\.data, namespace, name\) \? q\.data : null/)
  assertMatch(useRun, /nodes: mine \? nodes\.nodes : null/)
})

Deno.test('the Logs tab derives its step every render (pods appear after it opens)', async () => {
  const src = await read('views/run-view.tsx')
  const logs = src.slice(src.indexOf('function RunLogs('), src.indexOf('/* ─────────────────────────── inputs & outputs'))
  assertMatch(logs, /const nodeId = logNodeFor\(nodes, picked, initialNode\)/)
  assert(!/useState<string \| undefined>\(initial\)/.test(logs), 'a step fixed when the tab opened never follows the first pod')
})

Deno.test('History keeps a page on screen only within one namespace', async () => {
  const src = await read('data/hooks.ts')
  const useArchive = src.slice(src.indexOf('export function useArchive('), src.indexOf('export function useArchivedRun('))
  assert(!/placeholderData: keepPreviousData/.test(useArchive), 'another namespace\'s archived runs would read as this one\'s')
  assertMatch(useArchive, /prevQuery\?\.queryKey\[3\] === namespace \? prev : undefined/)
})

Deno.test('a keyboard user can open a step: the canvas turns React Flow\'s select change into a selection', async () => {
  const src = await read('canvas/workflow-canvas.tsx')
  assertMatch(src, /onNodesChange=\{\(changes\) => \{\n\s+const picked = changes\.find\(\(c\) => c\.type === 'select' && c\.selected\)/)
  assertMatch(src, /if \(picked && 'id' in picked && picked\.id !== selected\) onSelect\?\.\(picked\.id\)/)
  assertMatch(src, /nodesFocusable\n/)
})

Deno.test('the run canvas re-renders only running cards when the clock ticks', async () => {
  const src = await read('canvas/workflow-canvas.tsx')
  assertMatch(src, /const tick = clockFor\(n, now\)/)
  assertMatch(src, /hit\.src === n && hit\.tick === tick/)
  assertMatch(src, /data: \{ node: n, now: tick,/)
})
