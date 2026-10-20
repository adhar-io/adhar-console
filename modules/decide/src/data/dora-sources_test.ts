import { assertEquals } from 'jsr:@std/assert@1'
import { toBuildRun } from './builds-model.ts'
import {
  argoEvents,
  changeRefFor,
  isConfigRepo,
  kargoEvents,
  repoPath,
  resolveLeads,
  shaInTag,
} from './dora-sources.ts'

Deno.test('argo apps resolve project / env / app from labels or conventions', () => {
  const ev = argoEvents(
    [
      {
        metadata: { name: 'adhar-api-prod' },
        spec: { project: 'adhar', destination: { namespace: 'adhar-prod' } },
        status: {
          history: [{ id: 1, revision: 'abc1234', deployedAt: '2026-10-01T00:00:00Z' }],
          operationState: { phase: 'Failed', finishedAt: '2026-10-02T00:00:00Z', message: 'boom' },
        },
      },
    ],
    [{ slug: 'adhar', argoProject: 'adhar', teams: ['core'] }],
  )
  assertEquals(ev.length, 2)
  assertEquals(ev.map((e) => [e.project, e.env, e.app, e.outcome]), [
    ['adhar', 'prod', 'api', 'failed'],
    ['adhar', 'prod', 'api', 'succeeded'],
  ])
})

Deno.test('kargo promotions map to env via shared stage name', () => {
  const ev = kargoEvents(
    [
      { name: 'p1', project: 'adhar', stage: 'prod', freight: 'f1', phase: 'Succeeded', created: '2026-10-01T00:00:00Z', finished: '2026-10-01T00:05:00Z' },
      { name: 'p2', project: 'adhar', stage: 'api-test', freight: 'f1', phase: 'Running', created: '2026-10-01T00:00:00Z' },
      { name: 'p3', project: 'adhar', stage: 'api-test', freight: 'f1', phase: 'Errored', created: '2026-10-01T00:00:00Z' },
    ],
    [
      { name: 'prod', project: 'adhar', labels: { 'adhar.io/stage-scope': 'project' } },
      { name: 'api-test', project: 'adhar', labels: { 'adhar.io/environment': 'test', 'adhar.io/application': 'api' } },
    ],
    [{ id: 'f1', warehouse: 'api', images: [] }],
  )
  assertEquals(ev.map((e) => [e.name, e.env, e.app, e.outcome]), [
    ['p1', 'prod', 'api', 'succeeded'],
    ['p3', 'test', 'api', 'failed'],
  ])
})

Deno.test('repo helpers', () => {
  assertEquals(repoPath('https://gitea.example/adhar/API.git'), 'adhar/api')
  assertEquals(repoPath('git@gitea:adhar/api.git'), 'adhar/api')
  assertEquals(isConfigRepo('adhar/adhar-gitops'), true)
  assertEquals(isConfigRepo('adhar/configurator'), false)
  assertEquals(shaInTag('sha-1a2b3c4d'), '1a2b3c4d')
  assertEquals(shaInTag('1.2.0'), undefined)
  assertEquals(shaInTag('20261001'), undefined)
})

Deno.test('change refs: freight commit, then image tag via the Tekton run', () => {
  const run = toBuildRun({
    metadata: { name: 'app-ci-api-x', creationTimestamp: '2026-10-01T00:00:00Z' },
    spec: { params: [{ name: 'repo-name', value: 'api' }, { name: 'revision', value: 'abcdef1234' }] },
    status: { conditions: [{ type: 'Succeeded', status: 'True' }] },
  })
  const freightById = new Map([
    ['f1', { id: 'f1', images: [], commits: [{ repoURL: 'https://g/adhar/api.git', id: 'deadbeef1' }] }],
    ['f2', { id: 'f2', images: [{ repoURL: 'reg/api', tag: 'abcdef1' }] }],
  ])
  const base = { id: 'd', name: 'p', app: 'api', project: 'adhar', env: 'prod', at: 0, outcome: 'succeeded' as const, source: 'kargo' as const }
  assertEquals(changeRefFor({ ...base, freight: 'f1' }, { freightById, runs: [run], org: 'adhar' })?.via, 'freight-commit')
  const r2 = changeRefFor({ ...base, freight: 'f2' }, { freightById, runs: [run], org: 'adhar' })
  assertEquals([r2?.via, r2?.repo, r2?.sha], ['image-tag', 'adhar/api', 'abcdef1234'])
  const argo = changeRefFor({ ...base, source: 'argocd', revision: 'abcdef1234' }, { freightById, runs: [], org: 'adhar', argoRepo: 'https://g/adhar/adhar-gitops' })
  assertEquals(argo, null)
})

Deno.test('lead times per shipped commit; re-deploys add nothing', () => {
  const H = 3_600_000
  const d = (id: string, at: number) => ({ id, name: id, app: 'api', project: 'adhar', env: 'prod', at, outcome: 'succeeded' as const, source: 'kargo' as const })
  const refs = new Map([
    ['d1', { repo: 'adhar/api', sha: 'aaaaaaa', via: 'freight-commit' as const }],
    ['d2', { repo: 'adhar/api', sha: 'ccccccc', via: 'freight-commit' as const }],
    ['d3', { repo: 'adhar/api', sha: 'ccccccc', via: 'freight-commit' as const }],
  ])
  const commits = new Map([[
    'adhar/api',
    [
      { sha: 'ccccccc9', at: 9 * H },
      { sha: 'bbbbbbb9', at: 8 * H },
      { sha: 'aaaaaaa9', at: 1 * H },
    ],
  ]])
  const leads = resolveLeads([d('d1', 2 * H), d('d2', 10 * H), d('d3', 11 * H)], refs, commits)
  assertEquals(leads.map((l) => [l.sha, l.hours]), [['aaaaaaa9', 1], ['ccccccc9', 1], ['bbbbbbb9', 2]])
})
