import { assert, assertEquals } from 'jsr:@std/assert@^1'
import {
  canUndoInConsole,
  deriveHistory,
  formatDuration,
  imageDiff,
  type KubeLike,
  matchTrigger,
  readAnalysisRun,
  type RolloutLike,
  undoCommand,
  undoPatch,
} from './rollout-history.ts'
import { parseImage } from './rollout-apps.ts'

const OWNER = [{ kind: 'Rollout', name: 'checkout', uid: 'ro-1' }]

function rs(rev: number, hash: string, tag: string, created: string, extra: Record<string, string> = {}): KubeLike {
  return {
    metadata: {
      name: `checkout-${hash}`,
      namespace: 'adhar-prod',
      creationTimestamp: created,
      labels: { 'rollouts-pod-template-hash': hash },
      annotations: { 'rollout.argoproj.io/revision': String(rev), ...extra },
      ownerReferences: OWNER,
    },
    spec: {
      replicas: 3,
      template: {
        metadata: { labels: { app: 'checkout', 'rollouts-pod-template-hash': hash } },
        spec: { containers: [{ name: 'app', image: `r/checkout:${tag}` }] },
      },
    },
    status: { readyReplicas: 3, availableReplicas: 3 },
  }
}

function run(name: string, hash: string, phase: string, finishedAt = '2026-10-05T10:20:00Z'): KubeLike {
  return {
    metadata: {
      name,
      creationTimestamp: '2026-10-05T10:10:00Z',
      labels: { 'rollouts-pod-template-hash': hash, 'rollout-type': 'Step', 'step-index': '1' },
      ownerReferences: OWNER,
    },
    status: {
      phase,
      startedAt: '2026-10-05T10:10:00Z',
      metricResults: [{
        name: 'success-rate',
        phase,
        count: 3,
        successful: phase === 'Successful' ? 3 : 1,
        failed: phase === 'Failed' ? 2 : 0,
        measurements: [{ value: '[0.97]', finishedAt }],
      }],
    },
  }
}

/** Five revisions: 1-2 superseded, 3 aborted (analysis failed), 4 stable, 5 the paused canary. */
function fixture(over: Partial<RolloutLike['status']> = {}) {
  const replicaSets = [
    rs(1, 'h1', '1.0.0', '2026-10-01T10:00:00Z', { 'scale-down-deadline': '2026-10-02T10:08:30Z' }),
    rs(2, 'h2', '1.1.0', '2026-10-02T10:00:00Z', { 'scale-down-deadline': '2026-10-04T10:12:30Z' }),
    rs(3, 'h3', '1.2.0', '2026-10-03T10:00:00Z'),
    rs(4, 'h4', '1.2.1', '2026-10-04T10:00:00Z'),
    rs(5, 'h5', '1.3.0', '2026-10-05T10:00:00Z'),
    // Another rollout's ReplicaSet in the same namespace — not ours.
    { ...rs(9, 'zz', '9', '2026-10-05T10:00:00Z'), metadata: { ...rs(9, 'zz', '9', '2026-10-05T10:00:00Z').metadata, ownerReferences: [{ kind: 'Rollout', name: 'other', uid: 'ro-2' }] } },
  ]
  const rollout: RolloutLike = {
    metadata: { name: 'checkout', namespace: 'adhar-prod', uid: 'ro-1' },
    spec: { template: { spec: { containers: [{ name: 'app', image: 'r/checkout:1.3.0' }] } } },
    status: { currentPodHash: 'h5', stableRS: 'h4', phase: 'Paused', ...over },
  }
  const analysisRuns = [
    run('checkout-h3-1', 'h3', 'Failed'),
    run('checkout-h5-1', 'h5', 'Running'),
    run('checkout-h4-1', 'h4', 'Successful'),
  ]
  return { rollout, replicaSets, analysisRuns }
}

Deno.test('deriveHistory: newest first, only this rollout’s ReplicaSets', () => {
  const h = deriveHistory(fixture())
  assertEquals(h.map((e) => e.revision), [5, 4, 3, 2, 1])
  assertEquals(h.map((e) => e.images[0].tag), ['1.3.0', '1.2.1', '1.2.0', '1.1.0', '1.0.0'])
})

Deno.test('deriveHistory: outcome classification', () => {
  const h = deriveHistory(fixture())
  assertEquals(h.map((e) => e.outcome), ['in-flight', 'stable', 'aborted', 'superseded', 'superseded'])
  assert(h[0].current)
  assert(h[2].outcomeReason.includes('checkout-h3-1'))
})

Deno.test('deriveHistory: a newer revision that is no longer current was never promoted', () => {
  // rev 5 replaced mid-rollout by rev 6; stable is still rev 4.
  const f = fixture({ currentPodHash: 'h6', stableRS: 'h4', phase: 'Progressing' })
  f.replicaSets.push(rs(6, 'h6', '1.3.1', '2026-10-06T10:00:00Z'))
  f.analysisRuns = []
  const h = deriveHistory(f)
  assertEquals(h.find((e) => e.revision === 5)?.outcome, 'aborted')
  assertEquals(h.find((e) => e.revision === 5)?.outcomeReason, 'Never promoted — replaced before the rollout finished.')
})

Deno.test('deriveHistory: current revision states — live, aborted, degraded', () => {
  const live = deriveHistory({
    ...fixture({
      currentPodHash: 'h5',
      stableRS: 'h5',
      phase: 'Healthy',
      conditions: [{ type: 'Completed', status: 'True', lastTransitionTime: '2026-10-05T10:30:00Z' }],
    }),
  })
  assertEquals(live[0].outcome, 'live')
  assertEquals(live[0].rolledOutMs, 30 * 60_000)
  // Rev 4 was stable before; now it is simply superseded.
  assertEquals(live[1].outcome, 'superseded')

  assertEquals(deriveHistory(fixture({ abort: true, phase: 'Degraded' }))[0].outcome, 'aborted')
  assertEquals(deriveHistory({ ...fixture({ phase: 'Degraded' }), analysisRuns: [] })[0].outcome, 'degraded')
})

Deno.test('deriveHistory: durations from scale-down deadlines', () => {
  const h = deriveHistory(fixture())
  const at = (rev: number) => h.find((e) => e.revision === rev)!
  // rev 1 was marked for scale-down at 10:08:30 → rev 2 went stable at 10:08.
  assertEquals(at(2).rolledOutMs, 8 * 60_000)
  // rev 3 was aborted, so rev 4 dates from rev 2's deadline (12 minutes in).
  assertEquals(at(4).rolledOutMs, 12 * 60_000)
  // rev 2 served from 2 Oct 10:08 until rev 4 took over on 4 Oct 10:12.
  assertEquals(at(2).replacedAt, '2026-10-04T10:12:00.000Z')
  assertEquals(at(2).servedMs, 48 * 3600_000 + 4 * 60_000)
  // Nothing dates rev 1's own switch, and an aborted revision never served.
  assertEquals(at(1).rolledOutMs, undefined)
  assertEquals(at(3).rolledOutMs, undefined)
  assertEquals(at(3).servedMs, undefined)
})

Deno.test('deriveHistory: analysis runs attach to their revision with metric results', () => {
  const h = deriveHistory(fixture())
  assertEquals(h[0].analyses.map((a) => a.name), ['checkout-h5-1'])
  const failed = h.find((e) => e.revision === 3)!.analyses[0]
  assertEquals(failed.phase, 'Failed')
  assertEquals(failed.step, 1)
  assertEquals(failed.type, 'Step')
  assertEquals(failed.metrics[0], {
    name: 'success-rate',
    phase: 'Failed',
    successful: 1,
    failed: 2,
    inconclusive: 0,
    error: 0,
    count: 3,
    lastValue: '[0.97]',
    message: undefined,
  })
  assertEquals(failed.finishedAt, '2026-10-05T10:20:00Z')
  // A running analysis has not finished.
  assertEquals(readAnalysisRun(run('x', 'h', 'Running')).finishedAt, undefined)
})

Deno.test('deriveHistory: image diff vs current', () => {
  const h = deriveHistory(fixture())
  assertEquals(h[0].diff, [])
  assertEquals(h[1].diff.map((d) => [d.container, d.entry?.tag, d.current?.tag]), [['app', '1.2.1', '1.3.0']])
  assertEquals(
    imageDiff([parseImage('a', 'r/a:1')], [parseImage('a', 'r/a:1'), parseImage('sidecar', 'r/s:2')]).map((d) => d.container),
    ['sidecar'],
  )
})

Deno.test('matchTrigger: the Argo CD sync that created the ReplicaSet', () => {
  const sha = 'a'.repeat(40)
  const history = [
    { id: 1, revision: 'b'.repeat(40), deployStartedAt: '2026-10-05T08:00:00Z', deployedAt: '2026-10-05T08:00:30Z' },
    { id: 2, revisions: [sha], deployStartedAt: '2026-10-05T09:59:50Z', deployedAt: '2026-10-05T10:00:20Z', initiatedBy: { automated: true } },
  ]
  assertEquals(matchTrigger('2026-10-05T10:00:00Z', history), {
    revision: sha,
    shortRevision: 'aaaaaaa',
    by: undefined,
    automated: true,
    at: '2026-10-05T10:00:20Z',
  })
  // Nothing within 15 minutes before it.
  assertEquals(matchTrigger('2026-10-05T12:00:00Z', history), undefined)
})

Deno.test('undo: template without the hash label, JSON patch, command fallback', () => {
  const h = deriveHistory(fixture())
  const rev2 = h.find((e) => e.revision === 2)!
  const [op] = undoPatch(rev2.template!)
  assertEquals(op.op, 'replace')
  assertEquals(op.path, '/spec/template')
  const labels = ((op.value as Record<string, unknown>).metadata as { labels: Record<string, string> }).labels
  assertEquals(labels, { app: 'checkout' })
  // The source template is untouched.
  assertEquals((rev2.template!.metadata as { labels: Record<string, string> }).labels['rollouts-pod-template-hash'], 'h2')

  const f = fixture()
  assert(canUndoInConsole(f.rollout, rev2))
  assert(!canUndoInConsole(f.rollout, h[0]), 'the current revision is not a rollback target')
  assert(!canUndoInConsole({ ...f.rollout, spec: { workloadRef: { kind: 'Deployment', name: 'x' } } }, rev2))
  assertEquals(undoCommand('adhar-prod', 'checkout', 2), 'kubectl argo rollouts undo checkout -n adhar-prod --to-revision=2')
})

Deno.test('formatDuration', () => {
  assertEquals(formatDuration(undefined), undefined)
  assertEquals(formatDuration(45_000), '45s')
  assertEquals(formatDuration(5 * 60_000 + 30_000), '5m 30s')
  assertEquals(formatDuration(30 * 60_000), '30m')
  assertEquals(formatDuration(26 * 3600_000), '26h')
  assertEquals(formatDuration(3 * 86400_000 + 2 * 3600_000), '3d 2h')
})
