import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { dependsEdges, inflateNodes, isRun, logNodeFor, nodeStatus, readNodes, runGraph, runStatus, type WfNode, type Workflow } from './nodes.ts'

/**
 * The run graph and node status of design 0026 §6.3: `compressedNodes`
 * inflated in the browser (F-8), phases → StatusKind, and the graph's mapping
 * of retries, fan-outs, `depends` conditions and the exit handler.
 *
 * The node maps below are shaped as Argo v4.1 writes them (ids
 * `<wf>-<hash>`, `boundaryID` the DAG node, retries as `Retry` nodes whose
 * children are `<task>(n)` attempts, fan-outs as `TaskGroup` nodes whose
 * children are `<task>(i:item)`, the exit handler `<wf>.onExit`).
 */

/** Argo's encoding: gzip, then standard base64 (`file.CompressEncodeString`). */
async function compress(nodes: Record<string, WfNode>): Promise<string> {
  const stream = new Blob([new TextEncoder().encode(JSON.stringify(nodes))]).stream().pipeThrough(new CompressionStream('gzip'))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

const WF = 'release-check-x7k2p'

const node = (id: string, n: Partial<WfNode>): WfNode => ({ id, name: `${WF}.${n.displayName ?? id}`, ...n })

const NODES: Record<string, WfNode> = {
  [WF]: { id: WF, name: WF, displayName: WF, type: 'DAG', phase: 'Running', children: ['n-build'], startedAt: '2026-11-25T01:00:00Z' },
  'n-build': node('n-build', { displayName: 'build', type: 'Retry', boundaryID: WF, phase: 'Succeeded', templateName: 'build', children: ['n-build-0', 'n-build-1'], startedAt: '2026-11-25T01:00:00Z', finishedAt: '2026-11-25T01:02:00Z' }),
  'n-build-0': node('n-build-0', { displayName: 'build(0)', type: 'Pod', boundaryID: WF, phase: 'Failed', templateName: 'build' }),
  'n-build-1': node('n-build-1', { displayName: 'build(1)', type: 'Pod', boundaryID: WF, phase: 'Succeeded', templateName: 'build', children: ['n-test', 'n-approve'] }),
  'n-test': node('n-test', { displayName: 'test', type: 'TaskGroup', boundaryID: WF, phase: 'Running', children: ['n-test-0', 'n-test-1', 'n-test-2'] }),
  'n-test-0': node('n-test-0', { displayName: 'test(0:a)', type: 'Pod', boundaryID: WF, phase: 'Succeeded' }),
  'n-test-1': node('n-test-1', { displayName: 'test(1:b)', type: 'Pod', boundaryID: WF, phase: 'Failed' }),
  'n-test-2': node('n-test-2', { displayName: 'test(2:c)', type: 'Pod', boundaryID: WF, phase: 'Running' }),
  'n-approve': node('n-approve', { displayName: 'approve', type: 'Suspend', boundaryID: WF, phase: 'Running', templateName: 'approve' }),
  [`${WF}.onExit`]: { id: 'n-exit', name: `${WF}.onExit`, displayName: `${WF}.onExit`, type: 'Pod', phase: 'Pending', templateName: 'notify' },
}

const RUN: Workflow = {
  metadata: { name: WF, namespace: 'shop-dev', labels: { 'workflows.argoproj.io/workflow-template': 'release-check' } },
  spec: { workflowTemplateRef: { name: 'release-check' } },
  status: {
    phase: 'Running',
    storedWorkflowTemplateSpec: {
      entrypoint: 'main',
      onExit: 'notify',
      templates: [
        {
          name: 'main',
          dag: {
            tasks: [
              { name: 'build', template: 'build' },
              { name: 'test', template: 'unit', depends: 'build', withItems: ['a', 'b', 'c'] },
              { name: 'approve', template: 'approve', depends: 'build.Succeeded' },
              { name: 'rollback', template: 'rollback', depends: 'test.Failed' },
              { name: 'ship', template: 'ship', depends: '(test || approve) && build', when: '{{workflow.parameters.ship}} == true' },
            ],
          },
        },
        { name: 'build', container: { image: 'harbor.local/shop/builder:1.2' } },
        { name: 'unit', script: { image: 'node:22' } },
        { name: 'approve', suspend: {} },
        { name: 'rollback', resource: { action: 'patch' } },
        { name: 'ship', http: { url: 'https://deploy.example/ship', method: 'POST' } },
        { name: 'notify', container: { image: 'curl' } },
      ],
    },
  },
}

Deno.test('compressedNodes is inflated in the browser exactly as Argo encodes it', async () => {
  const encoded = await compress(NODES)
  const back = await inflateNodes(encoded)
  assertEquals(back, NODES)
  const r = await readNodes({ metadata: { name: WF }, status: { compressedNodes: encoded } })
  assertEquals(r.state, 'ready')
})

Deno.test('a compression the browser cannot read, or an offloaded status, asks for the hydrated run', async () => {
  assertEquals(await inflateNodes(btoa('not gzip at all')), null)
  assertEquals((await readNodes({ metadata: { name: WF }, status: { compressedNodes: btoa('zstd?') } })).state, 'hydrate')
  assertEquals((await readNodes({ metadata: { name: WF }, status: { offloadNodeStatusVersion: 'fnv:123' } })).state, 'hydrate')
  assertEquals(await readNodes({ metadata: { name: WF } }), { state: 'ready', nodes: {} })
})

Deno.test('phases map to StatusKind as §6.3 says', () => {
  assertEquals(nodeStatus('Pending'), 'progressing')
  assertEquals(nodeStatus('Running'), 'progressing')
  assertEquals(nodeStatus('Succeeded'), 'healthy')
  assertEquals(nodeStatus('Failed'), 'failed')
  assertEquals(nodeStatus('Error'), 'failed')
  assertEquals(nodeStatus('Skipped'), 'unknown')
  assertEquals(nodeStatus('Omitted'), 'unknown')
  assertEquals(nodeStatus('Running', 'Suspend'), 'paused')
  assertEquals(runStatus({ metadata: { name: 'x' }, spec: { suspend: true }, status: { phase: 'Running' } }), 'paused')
  assertEquals(runStatus({ metadata: { name: 'x' } }), 'progressing') // not reconciled yet = Pending
})

Deno.test('depends: a pure conjunction is one edge per term with its condition; anything else is an expression', () => {
  const names = new Set(['a', 'b', 'c', 'my-task'])
  assertEquals(dependsEdges({ name: 'x', depends: 'a && b.Failed && my-task.Succeeded' }, names), [
    { source: 'a', condition: 'Succeeded' },
    { source: 'b', condition: 'Failed' },
    { source: 'my-task', condition: 'Succeeded' },
  ])
  assertEquals(dependsEdges({ name: 'x', depends: '(a || b) && !c.Failed' }, names).map((e) => e.condition), ['Expression', 'Expression', 'Expression'])
  assertEquals(dependsEdges({ name: 'x', dependencies: ['a', 'zzz'] }, names), [{ source: 'a', condition: 'Succeeded' }])
  // Unknown names (a typo, a template parameter) draw nothing rather than a dangling edge.
  assertEquals(dependsEdges({ name: 'x', depends: 'nope' }, names), [])
})

Deno.test('the run graph folds retries and fan-outs into their task, and marks a waiting approval', () => {
  const g = runGraph(RUN, NODES)
  assertEquals(g.source, 'template')
  assertEquals(g.nodes.map((n) => n.id), ['build', 'test', 'approve', 'rollback', 'ship', 'onExit'])
  const by = new Map(g.nodes.map((n) => [n.id, n]))
  assertEquals(by.get('build')!.attempts, 2)
  assertEquals(by.get('build')!.status, 'healthy')
  assertEquals(by.get('build')!.kind, 'container')
  assertEquals(by.get('build')!.subtitle, 'builder:1.2')
  assertEquals(by.get('test')!.fanOut, { total: 3, succeeded: 1, failed: 1, running: 1 })
  assertEquals(by.get('approve')!.awaitingApproval, true)
  assertEquals(by.get('approve')!.status, 'paused')
  assertEquals(by.get('rollback')!.dim, true) // not reached yet
  assertEquals(by.get('ship')!.when, '{{workflow.parameters.ship}} == true')
  assertEquals(by.get('ship')!.kind, 'http')
  assertEquals(by.get('onExit')!.lane, 'exit')
})

Deno.test('edges are green behind, indigo on the active path, grey ahead, red where it broke', () => {
  const g = runGraph(RUN, NODES)
  const e = new Map(g.edges.map((x) => [x.id, x]))
  assertEquals(e.get('build->test')!.state, 'active') // test is running
  assertEquals(e.get('build->approve')!.state, 'active') // approval waiting is the active path
  assertEquals(e.get('test->rollback')!.condition, 'Failed')
  assertEquals(e.get('test->rollback')!.state, 'ahead')
  assertEquals(e.get('test->ship')!.condition, 'Expression')
  const done = runGraph(RUN, { ...NODES, 'n-test': { ...NODES['n-test'], phase: 'Succeeded' } })
  assertEquals(done.edges.find((x) => x.id === 'build->test')!.state, 'done')
  const broke = runGraph(RUN, { ...NODES, 'n-build': { ...NODES['n-build'], phase: 'Failed' } })
  assertEquals(broke.edges.find((x) => x.id === 'build->approve')!.state, 'broken')
})

Deno.test('a steps template draws one column per parallel group', () => {
  const run: Workflow = {
    metadata: { name: 'steps-abcde' },
    spec: { entrypoint: 's', templates: [{ name: 's', steps: [[{ name: 'one', template: 't' }], [{ name: 'two', template: 't' }, { name: 'three', template: 't' }]] }, { name: 't', container: { image: 'busybox' } }] },
  }
  const g = runGraph(run, {})
  assertEquals(g.shape, 'steps')
  assertEquals(g.edges.map((e) => e.id), ['one->two', 'one->three'])
})

Deno.test('without a template, the graph comes from status alone, through retry attempts', () => {
  const g = runGraph({ metadata: { name: WF }, status: {} }, NODES)
  assertEquals(g.source, 'status')
  assert(g.nodes.some((n) => n.id === 'build'))
  assert(g.nodes.every((n) => !/\(\d/.test(n.id)), 'attempts and items are not drawn as their own nodes')
  assert(g.edges.some((e) => e.id === 'build->test'), 'the edge from a retried task goes through its last attempt')
})

/* ── verifier (WF-W1 console-ui): what the first pass let through ── */

Deno.test('a gzip bomb in compressedNodes is refused, not inflated into the tab', async () => {
  // The Workflow CRD has no status subresource: anyone who may update a run
  // can write its compressedNodes. 8 MiB of one character gzips to ~8 KiB.
  const big = { x: { id: 'x', name: 'x', message: 'a'.repeat(8 * 1024 * 1024) } }
  const encoded = await compress(big as unknown as Record<string, WfNode>)
  assert(encoded.length < 64 * 1024, 'the fixture is a bomb: small in, large out')
  assertEquals(await inflateNodes(encoded, 1024 * 1024), null)
  // Under the cap it still inflates, so the cap is what refused it.
  assertEquals(Object.keys((await inflateNodes(encoded, 16 * 1024 * 1024)) ?? {}), ['x'])
})

Deno.test('the Logs tab follows pods that appear after it opened, and the step the graph selected', () => {
  const pending: Record<string, WfNode> = { [WF]: NODES[WF], 'n-approve': NODES['n-approve'] }
  assertEquals(logNodeFor(pending, undefined, undefined), undefined) // nothing has a pod yet
  // The same tab, one watch event later: the first pod is there and is shown without a click.
  assertEquals(logNodeFor(NODES, undefined, undefined) !== undefined, true)
  // The graph's selection is a Retry node: its pod attempt is what has logs.
  assert(['n-build-0', 'n-build-1'].includes(logNodeFor(NODES, undefined, 'n-build')!))
  // A pick wins while it exists, and falls back once it does not.
  assertEquals(logNodeFor(NODES, 'n-test-1', 'n-build'), 'n-test-1')
  assertEquals(logNodeFor(pending, 'n-test-1', undefined), undefined)
})

Deno.test('the run view never shows one run under another run\'s name', () => {
  const a: Workflow = { metadata: { name: 'a-1', namespace: 'shop-dev' } }
  assertEquals(isRun(a, 'shop-dev', 'a-1'), true)
  assertEquals(isRun(a, 'shop-dev', 'b-2'), false)
  assertEquals(isRun(a, 'shop-test', 'a-1'), false)
  assertEquals(isRun(null, 'shop-dev', 'a-1'), false)
})

Deno.test('a status-only graph keeps one card per status node when display names repeat', () => {
  const nodes: Record<string, WfNode> = {
    r: { id: 'r', name: 'r', displayName: 'r', type: 'Steps', phase: 'Running', children: ['g0', 'g1'] },
    g0: { id: 'g0', name: 'r[0]', displayName: '[0]', type: 'StepGroup', boundaryID: 'r', children: ['s0'] },
    s0: { id: 's0', name: 'r[0].check', displayName: 'check', type: 'Pod', boundaryID: 'r', phase: 'Succeeded', children: ['g1'] },
    g1: { id: 'g1', name: 'r[1]', displayName: '[1]', type: 'StepGroup', boundaryID: 'r', children: ['s1'] },
    s1: { id: 's1', name: 'r[1].check', displayName: 'check', type: 'Pod', boundaryID: 'r', phase: 'Running' },
  }
  const g = runGraph({ metadata: { name: 'r' }, status: {} }, nodes)
  const ids = g.nodes.map((n) => n.id)
  assertEquals(new Set(ids).size, ids.length, `duplicate graph ids: ${ids.join(', ')}`)
  assertEquals(g.nodes.filter((n) => n.label === 'check').length, 2)
  assertEquals(g.edges.length, 1)
})

Deno.test('a run of 500 tasks builds its graph and lays out in well under a frame budget', async () => {
  const { layoutGraph } = await import('../model/layout.ts')
  const tasks = Array.from({ length: 500 }, (_, i) => ({ name: `t${i}`, template: 'c', depends: i ? `t${Math.floor((i - 1) / 2)}` : undefined }))
  const nodes: Record<string, WfNode> = { big: { id: 'big', name: 'big', displayName: 'big', type: 'DAG', phase: 'Running', children: [] } }
  tasks.forEach((t, i) => (nodes[`n${i}`] = { id: `n${i}`, name: `big.${t.name}`, displayName: t.name, type: 'Pod', boundaryID: 'big', phase: i < 250 ? 'Succeeded' : 'Pending' }))
  const run: Workflow = { metadata: { name: 'big' }, spec: { entrypoint: 'main', templates: [{ name: 'main', dag: { tasks } }, { name: 'c', container: { image: 'busybox' } }] } }
  const t0 = performance.now()
  const g = runGraph(run, nodes)
  const pos = layoutGraph(g.nodes, g.edges)
  const ms = performance.now() - t0
  assertEquals(g.nodes.length, 500)
  assertEquals(g.edges.length, 499)
  assertEquals(Object.keys(pos).length, 500)
  assert(ms < 1000, `500 tasks took ${ms.toFixed(0)} ms`)
})
