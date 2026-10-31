import { assertEquals } from 'jsr:@std/assert@1'
import type { Entity } from './catalog.ts'
import type { PlatformService, Scorecard } from './scorecard.ts'
import { mergeScorecards } from './scorecard-merge.ts'

const entity = (name: string): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name, namespace: 'default' },
  spec: { type: 'service', owner: 'group:default/team' },
  origin: 'live',
})

// A catalog-derived card, as useScorecards() produces one.
const card = (name: string): Scorecard => ({
  entityRef: `component:default/${name}`,
  score: 70,
  grade: 'C',
  checks: [],
  byCategory: {} as Scorecard['byCategory'],
  entity: entity(name),
  source: 'catalog',
  platformOnly: false,
} as Scorecard)

const rec = (name: string, kind: PlatformService['kind'], score: number): PlatformService => ({
  name,
  namespace: 'adhar-system',
  stateful: false,
  score,
  grade: score >= 90 ? 'A' : 'F',
  health: 'Healthy',
  sync: 'Synced',
  categories: {
    reliability: score,
    security: score,
    observability: score,
    operations: score,
    performance: null,
    resilience: null,
    supply_chain: null,
    efficiency: null,
  },
  signals: [],
  kind,
})

// The page lists exactly the Service Catalog's applications. Before
// 2026-10-22 every scorer record without a catalog entity became a card of
// its own, and the scorer graded every Argo CD Application — so 78 platform
// packages (keycloak, gitea, …) buried the 3 applications a team owns.
Deno.test('scorecards are exactly the catalog entities; no scorer-only cards', () => {
  const catalog = [card('shop'), card('cart')]
  const { scorecards, matched, graded } = mergeScorecards(catalog, [
    rec('shop', 'application', 95),
    rec('keycloak', 'package', 100),
    rec('gitea', 'package', 88),
    rec('orphan-app', 'application', 40),
  ])
  assertEquals(scorecards.map((s) => s.entity.metadata.name).sort(), ['cart', 'shop'])
  assertEquals(scorecards.some((s) => s.platformOnly), false)
  assertEquals(matched, 1)
  // Packages are not counted as graded services either.
  assertEquals(graded, 2)
  const shop = scorecards.find((s) => s.entity.metadata.name === 'shop')!
  assertEquals([shop.source, shop.score], ['platform', 95])
  assertEquals(scorecards.find((s) => s.entity.metadata.name === 'cart')!.source, 'catalog')
})

// A package that happens to share a catalog entity's name must not lend it a
// platform score: package records from an older scorer are ignored outright.
Deno.test('a package record never grades a catalog entity of the same name', () => {
  const { scorecards } = mergeScorecards([card('grafana')], [rec('grafana', 'package', 100)])
  assertEquals(scorecards[0].source, 'catalog')
})
