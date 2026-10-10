import { assertEquals } from 'jsr:@std/assert'
import { chainDrift, promotesFrom, promotionChain } from './promotion-chain.ts'
import type { kargo } from '@adhar/api-clients'

function stage(name: string, upstream: string[] = [], extra: Partial<kargo.Stage> = {}): kargo.Stage {
  return { name, project: 'adhar-environments', upstream, ...extra } as unknown as kargo.Stage
}

/** Exactly what this cluster runs: dev → test → prod, returned alphabetically. */
const REAL = [
  stage('dev', [], { warehouse: 'environments', currentFreight: 'abc123' }),
  stage('prod', ['test']),
  stage('test', ['dev'], { currentFreight: 'abc123' }),
]

Deno.test('the chain is in promotion order, not the order the API returned', () => {
  assertEquals(promotionChain(REAL).map((l) => l.stage.name), ['dev', 'test', 'prod'])
  assertEquals(promotionChain(REAL).map((l) => l.index), [0, 1, 2])
})

Deno.test('each stage knows both what feeds it and what it feeds', () => {
  const [dev, test, prod] = promotionChain(REAL)
  assertEquals(dev.upstream, [])
  assertEquals(dev.downstream, ['test'])
  assertEquals(test.upstream, ['dev'])
  assertEquals(test.downstream, ['prod'])
  assertEquals(prod.upstream, ['test'])
  assertEquals(prod.downstream, [])
})

Deno.test('the ends of the chain are identified', () => {
  const [dev, test, prod] = promotionChain(REAL)
  assertEquals([dev.isEntry, dev.isTerminal], [true, false])
  assertEquals([test.isEntry, test.isTerminal], [false, false])
  assertEquals([prod.isEntry, prod.isTerminal], [false, true])
})

Deno.test('a fan-out feeds several stages from one', () => {
  const links = promotionChain([stage('dev'), stage('eu', ['dev']), stage('us', ['dev'])])
  assertEquals(links[0].downstream, ['eu', 'us'])
  assertEquals(links[1].isTerminal, true)
  assertEquals(links[2].isTerminal, true)
})

/**
 * A stage in another Kargo project is not part of this chain. Showing it as a
 * neighbour would claim a promotion path the viewer cannot see or act on.
 */
Deno.test('an upstream outside the list is not a phantom neighbour', () => {
  const links = promotionChain([stage('prod', ['somewhere-else'])])
  assertEquals(links[0].upstream, [])
  assertEquals(links[0].isEntry, true)
})

Deno.test('a stage listing itself upstream is not its own neighbour', () => {
  const links = promotionChain([stage('solo', ['solo'])])
  assertEquals(links[0].upstream, [])
  assertEquals(links[0].downstream, [])
})

Deno.test('no stages is an empty chain, not an error', () => {
  assertEquals(promotionChain([]), [])
  assertEquals(chainDrift([]), { behind: [], empty: [], leading: undefined })
})

Deno.test('how a stage is fed reads as a warehouse or as its upstreams', () => {
  const [dev, test] = promotionChain(REAL)
  assertEquals(promotesFrom(dev), 'warehouse environments')
  assertEquals(promotesFrom(test), 'dev')
  // A warehouse Kargo did not name is still a warehouse.
  assertEquals(promotesFrom(promotionChain([stage('x')])[0]), 'a warehouse')
})

/**
 * The question the page exists to answer: is the same change everywhere, and
 * if not, where has it stopped?
 */
Deno.test('drift reports which stages are behind and which are empty', () => {
  const d = chainDrift(promotionChain(REAL))
  assertEquals(d.leading, 'abc123')
  assertEquals(d.behind, [])
  assertEquals(d.empty, ['prod'])
})

Deno.test('a stage holding older freight is behind, not empty', () => {
  const links = promotionChain([
    stage('dev', [], { currentFreight: 'new' }),
    stage('test', ['dev'], { currentFreight: 'old' }),
    stage('prod', ['test'], { currentFreight: 'new' }),
  ])
  const d = chainDrift(links)
  assertEquals(d.leading, 'new')
  assertEquals(d.behind, ['test'])
  assertEquals(d.empty, [])
})

/** With nothing at the head of the chain there is no "newest" to compare to. */
Deno.test('an empty entry stage does not make every other stage look behind', () => {
  const links = promotionChain([stage('dev'), stage('test', ['dev'], { currentFreight: 'x' })])
  const d = chainDrift(links)
  assertEquals(d.leading, undefined)
  assertEquals(d.behind, [])
  assertEquals(d.empty, ['dev'])
})
