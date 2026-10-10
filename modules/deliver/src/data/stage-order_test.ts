import { assertEquals } from 'jsr:@std/assert'
import { orderStages, shortFreight, stageStatus } from './stage-order.ts'
import type { kargo } from '@adhar/api-clients'

/**
 * The API returns stages alphabetically, so a `dev → test → prod` pipeline
 * rendered as `dev → prod → test` — with arrows between the cards, which reads
 * as a claim that prod promotes into test.
 */

function stage(name: string, upstream: string[] = []): kargo.Stage {
  return { name, project: 'p', upstream } as unknown as kargo.Stage
}
const names = (s: kargo.Stage[]) => s.map((x) => x.name)

Deno.test('stages follow the promotion graph, not the alphabet', () => {
  // Exactly what the cluster returns: dev, prod, test.
  const alphabetical = [stage('dev'), stage('prod', ['test']), stage('test', ['dev'])]
  assertEquals(names(orderStages(alphabetical)), ['dev', 'test', 'prod'])
})

Deno.test('a longer chain orders end to end', () => {
  const list = [
    stage('prod', ['uat']),
    stage('uat', ['qa']),
    stage('qa', ['dev']),
    stage('dev'),
  ]
  assertEquals(names(orderStages(list)), ['dev', 'qa', 'uat', 'prod'])
})

/**
 * Two stages fed by the same upstream are equally ready. Their incoming order
 * decides, so the card does not reshuffle between polls.
 */
Deno.test('parallel stages keep their incoming order', () => {
  const list = [stage('dev'), stage('eu', ['dev']), stage('us', ['dev'])]
  assertEquals(names(orderStages(list)), ['dev', 'eu', 'us'])
  const swapped = [stage('dev'), stage('us', ['dev']), stage('eu', ['dev'])]
  assertEquals(names(orderStages(swapped)), ['dev', 'us', 'eu'])
})

/** A stage in another project, or one the viewer cannot read, is not an anchor. */
Deno.test('an upstream outside the list does not strand its stage', () => {
  const list = [stage('prod', ['somewhere-else']), stage('dev')]
  assertEquals(names(orderStages(list)).sort(), ['dev', 'prod'])
  assertEquals(orderStages(list).length, 2)
})

Deno.test('a cycle still shows every stage', () => {
  const list = [stage('a', ['b']), stage('b', ['a'])]
  assertEquals(orderStages(list).length, 2)
})

Deno.test('a stage listing itself upstream does not deadlock', () => {
  const list = [stage('solo', ['solo'])]
  assertEquals(names(orderStages(list)), ['solo'])
})

Deno.test('no stages is not an error', () => {
  assertEquals(orderStages([]), [])
})

/**
 * Kargo deprecated `status.phase`; a current cluster reports `NotApplicable`
 * for every stage, which the card was printing as the status of a stage that
 * was in fact healthy and carrying verified freight.
 */
Deno.test('health wins over the deprecated phase', () => {
  assertEquals(stageStatus({ phase: 'NotApplicable', health: 'Healthy' } as kargo.Stage), {
    label: 'Healthy',
    kind: 'healthy',
  })
})

Deno.test('NotApplicable with no health reads as what it means', () => {
  assertEquals(stageStatus({ phase: 'NotApplicable' } as kargo.Stage), {
    label: 'No freight',
    kind: 'unknown',
  })
})

Deno.test('an older cluster still reports its phase', () => {
  assertEquals(stageStatus({ phase: 'Promoting' } as kargo.Stage).kind, 'progressing')
  assertEquals(stageStatus({ phase: 'Failed' } as kargo.Stage).kind, 'failed')
})

Deno.test('a freight id is shortened like a commit, and absence is a dash', () => {
  assertEquals(shortFreight('010fb768b2266b3803fdd87974a7c9348e4253dc'), '010fb768b226')
  assertEquals(shortFreight('short'), 'short')
  assertEquals(shortFreight(undefined), '—')
})
