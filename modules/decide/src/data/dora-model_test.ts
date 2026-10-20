import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import {
  bandChangeFailure,
  bandDeployFrequency,
  bandLeadTime,
  bandRestore,
  breakdown,
  computeKeys,
  type DeployEvent,
  deployRestores,
  envFromNamespace,
  firingIntervals,
  histogram,
  historyToDeploys,
  keySeries,
  mergeDeploys,
  overallBand,
  percentile,
  projectFromNamespace,
  shippedCommits,
} from './dora-model.ts'

const H = 3_600_000
const D = 24 * H
const T0 = Date.UTC(2026, 9, 1)

function dep(over: Partial<DeployEvent>): DeployEvent {
  return {
    id: Math.random().toString(36),
    name: 'x',
    app: 'api',
    project: 'adhar',
    env: 'prod',
    at: T0,
    outcome: 'succeeded',
    source: 'kargo',
    ...over,
  }
}

Deno.test('bands follow the DORA 2023 clusters', () => {
  assertEquals(bandDeployFrequency(2), 'elite')
  assertEquals(bandDeployFrequency(1 / 7), 'high')
  assertEquals(bandDeployFrequency(1 / 20), 'medium')
  assertEquals(bandDeployFrequency(1 / 60), 'low')
  assertEquals(bandLeadTime(3), 'elite')
  assertEquals(bandLeadTime(48), 'high')
  assertEquals(bandLeadTime(24 * 10), 'medium')
  assertEquals(bandLeadTime(24 * 40), 'low')
  assertEquals(bandChangeFailure(0.05), 'elite')
  assertEquals(bandChangeFailure(0.08), 'high')
  assertEquals(bandChangeFailure(0.15), 'medium')
  assertEquals(bandChangeFailure(0.3), 'low')
  assertEquals(bandRestore(0.5), 'elite')
  assertEquals(bandRestore(5), 'high')
  assertEquals(bandRestore(48), 'medium')
  assertEquals(bandRestore(24 * 8), 'low')
  assertEquals(overallBand(['elite', 'low', null]), 'high')
  assertEquals(overallBand(['high', 'low']), 'medium')
  assertEquals(overallBand([null]), null)
})

Deno.test('namespaces map to project and environment', () => {
  assertEquals(envFromNamespace('adhar-prod', 'adhar'), 'prod')
  assertEquals(envFromNamespace('shop-test'), 'test')
  assertEquals(envFromNamespace('adhar-system'), '')
  assertEquals(envFromNamespace('web-production'), 'prod')
  assertEquals(projectFromNamespace('shop-dev'), 'shop')
  assertEquals(projectFromNamespace('adhar-system'), '')
})

Deno.test('percentile interpolates and ignores non-finite', () => {
  assertEquals(percentile([], 0.5), null)
  assertEquals(percentile([4], 0.9), 4)
  assertEquals(percentile([1, 2, 3, 4], 0.5), 2.5)
  assertAlmostEquals(percentile([1, 2, 3, 4, NaN], 0.9)!, 3.7)
})

Deno.test('argo history: a re-deployed older revision marks a rollback', () => {
  const ev = historyToDeploys(
    [
      { id: 1, revision: 'aaa', deployedAt: '2026-10-01T00:00:00Z' },
      { id: 2, revision: 'bbb', deployedAt: '2026-10-02T00:00:00Z' },
      { id: 3, revision: 'aaa', deployedAt: '2026-10-02T01:00:00Z' },
      { id: 4, revision: 'ccc', deployedAt: '2026-10-03T00:00:00Z' },
    ],
    { name: 'adhar-api-prod', app: 'api', project: 'adhar', env: 'prod' },
  )
  assertEquals(ev.map((e) => e.outcome), ['succeeded', 'rolled-back', 'succeeded', 'succeeded'])
  assertEquals(ev[2].rollback, true)
})

Deno.test('kargo wins over argo for the same app+env; others keep argo', () => {
  const merged = mergeDeploys(
    [dep({ source: 'argocd', app: 'api' }), dep({ source: 'argocd', app: 'web' })],
    [dep({ source: 'kargo', app: 'api' })],
  )
  assertEquals(merged.map((e) => `${e.source}:${e.app}`).sort(), ['argocd:web', 'kargo:api'])
})

Deno.test('restores: failure opens, next good deploy closes; unresolved stays open', () => {
  const { restores, open } = deployRestores([
    dep({ at: T0, outcome: 'failed' }),
    dep({ at: T0 + H, outcome: 'failed' }),
    dep({ at: T0 + 3 * H }),
    dep({ app: 'web', at: T0, outcome: 'rolled-back' }),
  ])
  assertEquals(restores.length, 1)
  assertEquals(restores[0].hours, 3)
  assertEquals(open.length, 1)
  assertEquals(open[0].app, 'web')
})

Deno.test('firing intervals split on gaps and flag the open one', () => {
  const step = 60_000
  const v: Array<[number, number]> = [[0, 1], [60_000, 1], [120_000, 1], [600_000, 1], [660_000, 1]]
  const out = firingIntervals(v, step, 660_000)
  assertEquals(out, [
    { start: 0, end: 180_000, open: false },
    { start: 600_000, end: 720_000, open: true },
  ])
})

Deno.test('shipped commits run from head back to the previous head', () => {
  const commits = [
    { sha: 'eeeeeee1', at: 5 },
    { sha: 'ddddddd1', at: 4 },
    { sha: 'ccccccc1', at: 3 },
    { sha: 'bbbbbbb1', at: 2 },
  ]
  assertEquals(shippedCommits(commits, 'ddddddd', 'bbbbbbb1').map((c) => c.at), [4, 3])
  assertEquals(shippedCommits(commits, 'eeeeeee1', undefined).length, 1)
  assertEquals(shippedCommits(commits, 'eeeeeee1', 'fffffff').length, 1)
  assertEquals(shippedCommits(commits, '0000000', undefined).length, 0)
})

Deno.test('four keys over a window', () => {
  const deploys = [
    dep({ at: T0 + 1 * D }),
    dep({ at: T0 + 2 * D }),
    dep({ at: T0 + 3 * D, outcome: 'failed' }),
    dep({ at: T0 + 4 * D }),
    dep({ at: T0 + 40 * D }), // outside
  ]
  const leads = [2, 4, 30].map((h, i) => ({
    sha: `s${i}`,
    repo: 'o/r',
    app: 'api',
    project: 'adhar',
    committedAt: T0 + D - h * H,
    deployedAt: T0 + D,
    hours: h,
    via: 'freight-commit' as const,
    deployId: 'x',
  }))
  const restores = [{ app: 'api', project: 'adhar', env: 'prod', start: T0 + 3 * D, end: T0 + 3 * D + 2 * H, hours: 2, source: 'deploy' as const, label: '' }]
  const k = computeKeys({ deploys, leads, restores }, T0, T0 + 30 * D)
  assertEquals(k.deploys, 4)
  assertEquals(k.failed, 1)
  assertAlmostEquals(k.perDay, 3 / 30)
  assertEquals(k.deployBand, 'medium')
  assertEquals(k.changeFailureRate, 0.25)
  assertEquals(k.changeFailureBand, 'low')
  assertEquals(k.leadP50, 4)
  assertEquals(k.leadBand, 'elite')
  assertEquals(k.restoreP50, 2)
  assertEquals(k.restoreBand, 'high')
  const empty = computeKeys({ deploys: [], leads: [], restores: [] }, T0, T0 + D)
  assertEquals(empty.deployBand, null)
  assertEquals(empty.changeFailureRate, null)
  assertEquals(empty.overall, null)
})

Deno.test('series and breakdown', () => {
  const deploys = [dep({ at: T0 + 1000 }), dep({ at: T0 + D + 1000, outcome: 'failed', app: 'web' })]
  const s = keySeries({ deploys, leads: [], restores: [] }, T0, T0 + 3 * D, D)
  assertEquals(s.deploys.map(([, v]) => v), [1, 0, 0])
  assertEquals(s.failures.map(([, v]) => v), [0, 1, 0])
  assertEquals(s.changeFailure, [[T0, 0], [T0 + D, 100]])
  const rows = breakdown({ deploys, leads: [], restores: [] }, T0, T0 + 3 * D, (x) => [x.app])
  assertEquals(rows.map((r) => [r.key, r.deploys, r.failed]), [['api', 1, 0], ['web', 1, 1]])
})

Deno.test('lead-time histogram', () => {
  const h = histogram([0.5, 3, 30, 100, 2000])
  assertEquals(h.map((b) => b.count), [1, 1, 0, 1, 1, 0, 1])
})
