import { assert, assertEquals } from 'jsr:@std/assert'
import { buildReleases, readContents, summariseReleases } from './releases.ts'
import type { kargo } from '@adhar-console/api-clients'

function freight(over: Partial<kargo.Freight> = {}): kargo.Freight {
  return {
    id: '010fb768b2266b3803fdd87974a7c9348e4253dc',
    project: 'adhar-environments',
    images: [],
    created: '2026-10-04T08:14:00Z',
    ...over,
  } as kargo.Freight
}

function stage(name: string, upstream: string[] = [], currentFreight?: string): kargo.Stage {
  return { name, project: 'adhar-environments', upstream, currentFreight } as unknown as kargo.Stage
}

/** Exactly what this platform produces: a warehouse watching a git repository. */
const GIT_FREIGHT = freight({
  alias: 'killjoy-greyhound',
  warehouse: 'environments',
  commits: [{
    repoURL: 'http://gitea-http.adhar-system.svc.cluster.local:3000/adhar/environments',
    id: '7f5983a0960c432b6ac43a1b1c7a4069ee8ff9b0',
    message: 'Update: Add environments config\n\nlonger body text',
    branch: 'main',
  }],
})

/**
 * The bug this replaces: the page built a row per image, so freight carrying
 * commits produced no rows and the page said releases appear once freight is
 * promoted — which had already happened twice.
 */
Deno.test('freight carrying only commits is still a release', () => {
  const list = buildReleases([GIT_FREIGHT], [stage('dev')])
  assertEquals(list.length, 1)
  assertEquals(list[0].alias, 'killjoy-greyhound')
  assertEquals(list[0].short, '010fb768b226')
  assertEquals(list[0].contents.length, 1)
  assertEquals(list[0].contents[0].kind, 'commit')
})

Deno.test('a commit is named by its short sha, repository and subject line', () => {
  const [c] = readContents(GIT_FREIGHT)
  assertEquals(c.title, '7f5983a0960c')
  assertEquals(c.source, 'adhar/environments')
  // The subject only — a commit body in a list cell is noise.
  assertEquals(c.detail, 'Update: Add environments config')
  assertEquals(c.branch, 'main')
})

Deno.test('images and charts are contents too, alongside commits', () => {
  const mixed = freight({
    images: [{ repoURL: 'harbor.adhar.io/library/api', tag: 'v1.2.3', digest: 'sha256:abc' }],
    charts: [{ repoURL: 'oci://harbor.adhar.io/charts', name: 'api', version: '0.4.1' }],
    commits: [{ repoURL: 'https://gitea/adhar/api', id: 'deadbeefcafebabe' }],
  })
  const kinds = readContents(mixed).map((c) => c.kind)
  assertEquals(kinds, ['commit', 'image', 'chart'])
  const [, img, chart] = readContents(mixed)
  assertEquals([img.title, img.source], ['v1.2.3', 'library/api'])
  assertEquals([chart.title, chart.source], ['0.4.1', 'harbor.adhar.io/charts/api'])
})

Deno.test('freight carrying nothing yet is a release with no contents, not a crash', () => {
  const list = buildReleases([freight()], [stage('dev')])
  assertEquals(list[0].contents, [])
})

/* ── where a release has reached ── */

const CHAIN = [stage('dev', [], 'f1'), stage('prod', ['test']), stage('test', ['dev'], 'f1')]

Deno.test('the stages holding a release are reported in promotion order', () => {
  const [r] = buildReleases([freight({ id: 'f1' })], CHAIN)
  assertEquals(r.stages.map((s) => s.name), ['dev', 'test', 'prod'])
  assertEquals(r.stages.map((s) => s.current), [true, true, false])
  // The furthest is by promotion order, not by the order the API returned.
  assertEquals(r.furthest, 'test')
  assertEquals(r.atEnd, false)
  assertEquals(r.unpromoted, false)
})

Deno.test('a release in the last stage has reached the end of the chain', () => {
  const [r] = buildReleases([freight({ id: 'f1' })], [
    stage('dev', []),
    stage('prod', ['test'], 'f1'),
    stage('test', ['dev']),
  ])
  assertEquals(r.furthest, 'prod')
  assertEquals(r.atEnd, true)
})

Deno.test('freight no stage is holding is built but unpromoted', () => {
  const [r] = buildReleases([freight({ id: 'other' })], CHAIN)
  assertEquals(r.furthest, undefined)
  assertEquals(r.unpromoted, true)
  assertEquals(r.atEnd, false)
})

Deno.test('verification and approval are read per stage', () => {
  const [r] = buildReleases(
    [freight({ id: 'f1', verifiedIn: ['dev'], approvedFor: ['prod'] })],
    CHAIN,
  )
  assertEquals(r.stages.map((s) => s.verified), [true, false, false])
  assertEquals(r.stages.map((s) => s.approved), [false, false, true])
})

/* ── promotion times ── */

function promo(stageName: string, freightId: string, phase: string, finished?: string): kargo.Promotion {
  return {
    name: `${stageName}-${finished ?? 'x'}`,
    project: 'adhar-environments',
    stage: stageName,
    freight: freightId,
    phase,
    created: '2026-10-04T08:00:00Z',
    finished,
  } as kargo.Promotion
}

Deno.test('a stage records when it actually took the freight', () => {
  const [r] = buildReleases([freight({ id: 'f1' })], CHAIN, [
    promo('dev', 'f1', 'Succeeded', '2026-10-04T08:10:00Z'),
    promo('test', 'f1', 'Succeeded', '2026-10-04T08:20:00Z'),
  ])
  assertEquals(r.stages[0].promotedAt, '2026-10-04T08:10:00Z')
  assertEquals(r.stages[1].promotedAt, '2026-10-04T08:20:00Z')
  assertEquals(r.lastPromotedAt, '2026-10-04T08:20:00Z')
})

/** A promotion that failed did not promote anything. */
Deno.test('only successful promotions count as having promoted', () => {
  const [r] = buildReleases([freight({ id: 'f1' })], CHAIN, [
    promo('dev', 'f1', 'Failed', '2026-10-04T08:10:00Z'),
  ])
  assertEquals(r.stages[0].promotedAt, undefined)
  assertEquals(r.lastPromotedAt, undefined)
})

Deno.test('a retried promotion reports the latest success, not the first', () => {
  const [r] = buildReleases([freight({ id: 'f1' })], CHAIN, [
    promo('dev', 'f1', 'Succeeded', '2026-10-04T08:10:00Z'),
    promo('dev', 'f1', 'Succeeded', '2026-10-04T09:30:00Z'),
  ])
  assertEquals(r.stages[0].promotedAt, '2026-10-04T09:30:00Z')
})

Deno.test('releases list newest first and do not shuffle on equal timestamps', () => {
  const list = buildReleases([
    freight({ id: 'b', created: '2026-10-04T08:00:00Z' }),
    freight({ id: 'c', created: '2026-10-04T09:00:00Z' }),
    freight({ id: 'a', created: '2026-10-04T08:00:00Z' }),
  ], [])
  assertEquals(list.map((r) => r.id), ['c', 'a', 'b'])
})

Deno.test('the summary separates arrived, travelling and never promoted', () => {
  const s = summariseReleases(buildReleases([
    freight({ id: 'f1' }),
    freight({ id: 'f2' }),
  ], [stage('dev', [], 'f1'), stage('test', ['dev'])]))
  assertEquals(s.total, 2)
  // `dev` is not the end of this chain, so f1 is still travelling.
  assertEquals([s.atEnd, s.inFlight, s.unpromoted], [0, 1, 1])
})

Deno.test('no freight is no releases, not an error', () => {
  assertEquals(buildReleases([], []), [])
  assertEquals(summariseReleases([]), { total: 0, atEnd: 0, inFlight: 0, unpromoted: 0 })
})

/** A single-stage chain: whatever that stage holds has arrived. */
Deno.test('one stage is both the start and the end of the chain', () => {
  const [r] = buildReleases([freight({ id: 'f1' })], [stage('only', [], 'f1')])
  assert(r.atEnd)
})
