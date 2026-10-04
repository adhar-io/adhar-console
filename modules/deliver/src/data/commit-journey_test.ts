import { assert, assertEquals } from 'jsr:@std/assert'
import {
  buildJourneys,
  furthestStep,
  looksLikeSha,
  revisionOf,
  runState,
  shaEq,
  type JourneyInput,
} from './commit-journey.ts'
import type { gitea, kargo } from '@adhar-console/api-clients'
import type { CRDObject } from './flow.ts'

const SHA = 'e4ea34bd11c2405bf6218403d4a1a3e9d5235565'

function commit(sha = SHA, message = 'Add the thing\n\nbody'): gitea.Commit {
  return {
    sha,
    short_sha: sha.slice(0, 10),
    message,
    author: { login: 'tapas' },
    created: '2026-10-04T08:00:00Z',
  } as gitea.Commit
}

/* ── sha matching ── */

/**
 * Gitea gives a 40-character sha and a 10-character short one, Tekton results
 * carry the full sha, a tag might embed only the first seven. Comparing with
 * `===` missed every one of those pairings.
 */
Deno.test('revisions compare across abbreviation lengths', () => {
  assert(shaEq(SHA, SHA.slice(0, 10)))
  assert(shaEq(SHA.slice(0, 7), SHA))
  assert(shaEq(SHA.toUpperCase(), SHA))
  assert(!shaEq(SHA, 'f'.repeat(40)))
})

/** Six characters is a coincidence waiting to happen. */
Deno.test('an abbreviation shorter than git\'s own minimum is not a match', () => {
  assert(!shaEq(SHA.slice(0, 6), SHA))
  assert(!shaEq('', SHA))
  assert(!shaEq(undefined, SHA))
})

Deno.test('a branch name is never a revision match', () => {
  assert(!looksLikeSha('main'))
  assert(!looksLikeSha('release/1.2'))
  assert(!shaEq('main', 'main'))
  assert(looksLikeSha(SHA))
  assert(looksLikeSha('abc1234'))
})

/* ── where each tool records the commit ── */

/**
 * The real shape: this platform's release pipelines pass `revision: main` as a
 * parameter and publish the resolved sha as a pipeline result. Reading the
 * parameter would have compared a commit against the word "main".
 */
Deno.test('a Tekton run reports the commit it resolved, not the branch it was given', () => {
  const run = {
    metadata: { name: 'release-adhar-kit-td9bc' },
    spec: { params: [{ name: 'revision', value: 'main' }] },
    status: { results: [{ name: 'commit', value: SHA }] },
  } as unknown as CRDObject
  assertEquals(revisionOf(run), SHA)
})

Deno.test('a parameter is used only when it is actually a sha', () => {
  const branchOnly = {
    spec: { params: [{ name: 'revision', value: 'main' }] },
  } as unknown as CRDObject
  assertEquals(revisionOf(branchOnly), undefined)

  const pinned = {
    spec: { params: [{ name: 'git-revision', value: SHA }] },
  } as unknown as CRDObject
  assertEquals(revisionOf(pinned), SHA)
})

Deno.test('kpack records its revision on the build source', () => {
  const build = { spec: { source: { git: { revision: SHA, url: 'x' } } } } as unknown as CRDObject
  assertEquals(revisionOf(build), SHA)
})

Deno.test('a label is the last resort', () => {
  const run = { metadata: { labels: { 'tekton.dev/git-revision': SHA } } } as unknown as CRDObject
  assertEquals(revisionOf(run), SHA)
})

Deno.test('a run that records no commit says so rather than guessing', () => {
  assertEquals(revisionOf({} as CRDObject), undefined)
  assertEquals(revisionOf({ status: { results: [{ name: 'url', value: 'http://x' }] } } as unknown as CRDObject), undefined)
})

Deno.test('run state comes from the standard condition', () => {
  const withCond = (status: string) =>
    ({ status: { conditions: [{ type: 'Succeeded', status }] } }) as unknown as CRDObject
  assertEquals(runState(withCond('True')), 'done')
  assertEquals(runState(withCond('False')), 'failed')
  assertEquals(runState(withCond('Unknown')), 'running')
  assertEquals(runState({} as CRDObject), 'unknown')
})

/* ── the journey ── */

function input(over: Partial<JourneyInput> = {}): JourneyInput {
  return {
    commits: [commit()],
    pulls: [],
    builds: [],
    freight: [],
    stages: [],
    ...over,
  }
}

Deno.test('a commit nothing has picked up still has a journey', () => {
  const [j] = buildJourneys(input())
  assertEquals(j.short, SHA.slice(0, 10))
  assertEquals(j.subject, 'Add the thing')
  assertEquals(j.steps.map((s) => s.id), [
    'commit',
    'pull-request',
    'build',
    'freight',
    'promotion',
    'deployed',
  ])
  assertEquals(j.steps[0].state, 'done')
  assertEquals(j.live, false)
})

/** Pushing straight to the branch is a normal thing to do, not a gap. */
Deno.test('a commit with no pull request is skipped, not failed', () => {
  const [j] = buildJourneys(input())
  const pr = j.steps.find((s) => s.id === 'pull-request')!
  assertEquals(pr.state, 'skipped')
  assert(pr.detail!.includes('directly'))
})

Deno.test('a merged pull request is matched by its head commit', () => {
  const pulls = [{
    number: 42,
    title: 'Add the thing',
    state: 'closed',
    merged: true,
    merged_at: '2026-10-04T08:05:00Z',
    created_at: '2026-10-04T07:00:00Z',
    head: { ref: 'feat', sha: SHA },
    user: { login: 'tapas', avatar_url: 'http://x' },
    id: 1,
  }] as unknown as gitea.PullRequest[]
  const pr = buildJourneys(input({ pulls }))[0].steps.find((s) => s.id === 'pull-request')!
  assertEquals(pr.state, 'done')
  assert(pr.detail!.startsWith('#42'))
})

Deno.test('an open pull request is still running', () => {
  const pulls = [{
    number: 7, title: 'wip', state: 'open', merged: false,
    created_at: '2026-10-04T07:00:00Z', head: { ref: 'f', sha: SHA },
    user: { login: 'x', avatar_url: 'http://x' }, id: 2,
  }] as unknown as gitea.PullRequest[]
  assertEquals(buildJourneys(input({ pulls }))[0].steps[1].state, 'running')
})

Deno.test('the build step finds the run that resolved this commit', () => {
  const builds = [
    { metadata: { name: 'other' }, status: { results: [{ name: 'commit', value: 'b'.repeat(40) }] } },
    {
      metadata: { name: 'release-adhar-kit-td9bc' },
      status: { results: [{ name: 'commit', value: SHA }], conditions: [{ type: 'Succeeded', status: 'True' }] },
    },
  ] as unknown as CRDObject[]
  const step = buildJourneys(input({ builds }))[0].steps.find((s) => s.id === 'build')!
  assertEquals(step.state, 'done')
  assertEquals(step.detail, 'release-adhar-kit-td9bc')
})

/**
 * No build system at all, versus a build system that never built this commit.
 * Reporting both as "pending" would send someone looking for a stuck run.
 */
Deno.test('an unreachable build system is unknown, not pending', () => {
  assertEquals(buildJourneys(input({ buildsAvailable: false }))[0].steps[2].state, 'unknown')
  assertEquals(buildJourneys(input({ buildsAvailable: true }))[0].steps[2].state, 'pending')
})

Deno.test('freight is matched by the commit it carries', () => {
  const freight = [{
    id: 'f1',
    alias: 'killjoy-greyhound',
    project: 'p',
    images: [],
    created: '2026-10-04T08:10:00Z',
    commits: [{ repoURL: 'http://gitea/adhar/x', id: SHA }],
  }] as unknown as kargo.Freight[]
  const step = buildJourneys(input({ freight }))[0].steps.find((s) => s.id === 'freight')!
  assertEquals(step.state, 'done')
  assertEquals(step.detail, 'killjoy-greyhound')
})

Deno.test('the stages holding that freight are listed in promotion order', () => {
  const freight = [{
    id: 'f1', project: 'p', images: [], created: 'x',
    commits: [{ repoURL: 'r', id: SHA }],
  }] as unknown as kargo.Freight[]
  // Returned alphabetically, as the API does.
  const stages = [
    { name: 'dev', project: 'p', upstream: [], currentFreight: 'f1' },
    { name: 'prod', project: 'p', upstream: ['test'] },
    { name: 'test', project: 'p', upstream: ['dev'], currentFreight: 'f1' },
  ] as unknown as kargo.Stage[]
  const j = buildJourneys(input({ freight, stages }))[0]
  assertEquals(j.inStages, ['dev', 'test'])
  assertEquals(j.steps.find((s) => s.id === 'promotion')!.detail, 'dev → test')
})

Deno.test('a commit that is the synced revision is live', () => {
  const j = buildJourneys(input({ syncedRevision: SHA }))[0]
  assert(j.live)
  assertEquals(j.steps.find((s) => s.id === 'deployed')!.state, 'done')
})

Deno.test('a short synced revision still matches the full commit', () => {
  assert(buildJourneys(input({ syncedRevision: SHA.slice(0, 8) }))[0].live)
})

Deno.test('an application reporting no revision is unknown, not undeployed', () => {
  const step = buildJourneys(input())[0].steps.find((s) => s.id === 'deployed')!
  assertEquals(step.state, 'unknown')
})

Deno.test('a different running revision is named so the gap is visible', () => {
  const other = 'c'.repeat(40)
  const step = buildJourneys(input({ syncedRevision: other }))[0].steps.find((s) => s.id === 'deployed')!
  assertEquals(step.state, 'pending')
  assert(step.detail!.includes(other.slice(0, 12)))
})

Deno.test('the furthest cleared step is what the row summarises', () => {
  const freight = [{
    id: 'f1', project: 'p', images: [], created: 'x',
    commits: [{ repoURL: 'r', id: SHA }],
  }] as unknown as kargo.Freight[]
  assertEquals(furthestStep(buildJourneys(input({ freight }))[0]).id, 'freight')
  assertEquals(furthestStep(buildJourneys(input())[0]).id, 'commit')
})

Deno.test('the list is bounded and an empty history is not an error', () => {
  const many = Array.from({ length: 50 }, (_, i) => commit(i.toString(16).padStart(40, '0')))
  assertEquals(buildJourneys(input({ commits: many }), 5).length, 5)
  assertEquals(buildJourneys(input({ commits: [] })), [])
})
