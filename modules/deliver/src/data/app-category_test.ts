import { assert, assertEquals } from 'jsr:@std/assert@^1'
import {
  appCategory,
  categoryTally,
  categoryTitle,
  CUSTOM,
  isCustomApp,
  isPlatformApp,
  matchesCategory,
  packageName,
} from './app-category.ts'
import type { argocd } from '@adhar/api-clients'

function app(name: string, labels?: Record<string, string>): argocd.Application {
  return {
    metadata: { name, namespace: 'adhar-system', labels: labels ?? {} },
    spec: { project: 'default' },
    status: {},
  } as unknown as argocd.Application
}

/** The labels this platform actually puts on everything it installs. */
const HARBOR = app('harbor', {
  'adhar.io/category': 'security',
  'adhar.io/package-name': 'harbor',
  environment: 'production',
})
const TEAM_APP = app('test-service')

Deno.test('a platform package is read from its category label', () => {
  assertEquals(appCategory(HARBOR), 'security')
  assert(isPlatformApp(HARBOR))
  assert(!isCustomApp(HARBOR))
  assertEquals(packageName(HARBOR), 'harbor')
})

/**
 * The distinction the page exists to offer: an Application without the
 * platform's labels was deployed by a team, not installed by the platform.
 */
Deno.test('an application with no platform labels is a custom app', () => {
  assertEquals(appCategory(TEAM_APP), CUSTOM)
  assert(isCustomApp(TEAM_APP))
  assert(!isPlatformApp(TEAM_APP))
  assertEquals(packageName(TEAM_APP), undefined)
})

/**
 * The platform's GitOps root (`adhar-platform-applicationset`) carries
 * `adhar.io/component: platform-stack` and, on platforms released before it
 * was given a category, nothing else of ours. It is the platform's, not a
 * team's — and only that component value says so.
 */
Deno.test('the platform-stack root application is a core platform app', () => {
  const root = app('adhar-platform-applicationset', {
    'app.kubernetes.io/part-of': 'adhar',
    'adhar.io/component': 'platform-stack',
  })
  assertEquals(appCategory(root), 'core')
  assert(isPlatformApp(root))
  assertEquals(appCategory(app('svc', { 'adhar.io/component': 'api' })), CUSTOM)
  // An explicit category still wins.
  assertEquals(
    appCategory(app('r', { 'adhar.io/component': 'platform-stack', 'adhar.io/category': 'infrastructure' })),
    'infrastructure',
  )
})

Deno.test('a blank or whitespace label is not a category', () => {
  assertEquals(appCategory(app('x', { 'adhar.io/category': '' })), CUSTOM)
  assertEquals(appCategory(app('y', { 'adhar.io/category': '   ' })), CUSTOM)
  assertEquals(packageName(app('z', { 'adhar.io/package-name': ' ' })), undefined)
})

/** An Application fetched without labels must not crash the page. */
Deno.test('an application with no labels at all is handled', () => {
  const bare = { metadata: { name: 'bare' }, spec: {}, status: {} } as unknown as argocd.Application
  assertEquals(appCategory(bare), CUSTOM)
})

Deno.test('categories present are tallied in display order', () => {
  const list = [
    HARBOR,
    app('falco', { 'adhar.io/category': 'security' }),
    app('loki', { 'adhar.io/category': 'observability' }),
    app('gitea', { 'adhar.io/category': 'application' }),
    TEAM_APP,
  ]
  assertEquals(categoryTally(list).map((c) => [c.id, c.count]), [
    // Custom first — it is the one people look for.
    ['custom', 1],
    ['application', 1],
    ['security', 2],
    ['observability', 1],
  ])
})

/**
 * Offering a filter that can only produce an empty list is exactly how the
 * page ended up showing 0 of 75.
 */
Deno.test('a category with no applications is not offered as a filter', () => {
  const ids = categoryTally([HARBOR]).map((c) => c.id)
  assertEquals(ids, ['security'])
  assert(!ids.includes('custom'))
})

Deno.test('a category this console has never seen is kept, not dropped', () => {
  const tally = categoryTally([app('new', { 'adhar.io/category': 'quantum' })])
  assertEquals(tally.map((c) => c.id), ['quantum'])
  assertEquals(tally[0].title, 'Quantum')
  assert(tally[0].platform)
})

Deno.test('custom is marked as not a platform category', () => {
  const tally = categoryTally([TEAM_APP, HARBOR])
  assertEquals(tally.find((c) => c.id === 'custom')?.platform, false)
  assertEquals(tally.find((c) => c.id === 'security')?.platform, true)
})

Deno.test('titles are given for the platform categories and derived otherwise', () => {
  assertEquals(categoryTitle('observability'), 'Observability')
  assertEquals(categoryTitle(CUSTOM), 'Custom apps')
  assertEquals(categoryTitle('somethingelse'), 'Somethingelse')
})

/* ── filtering ── */

Deno.test('no filter shows everything', () => {
  assert(matchesCategory(HARBOR, {}))
  assert(matchesCategory(TEAM_APP, {}))
  assert(matchesCategory(HARBOR, { categories: [] }))
})

Deno.test('platform and custom are filterable as a pair', () => {
  assert(matchesCategory(HARBOR, { kind: 'platform' }))
  assert(!matchesCategory(HARBOR, { kind: 'custom' }))
  assert(matchesCategory(TEAM_APP, { kind: 'custom' }))
  assert(!matchesCategory(TEAM_APP, { kind: 'platform' }))
})

Deno.test('individual categories filter, and combine with the kind', () => {
  assert(matchesCategory(HARBOR, { categories: ['security'] }))
  assert(!matchesCategory(HARBOR, { categories: ['data'] }))
  assert(matchesCategory(HARBOR, { kind: 'platform', categories: ['security'] }))
  assert(!matchesCategory(HARBOR, { kind: 'custom', categories: ['security'] }))
})

Deno.test('custom apps are selectable as a category as well as a kind', () => {
  assert(matchesCategory(TEAM_APP, { categories: [CUSTOM] }))
  assert(!matchesCategory(HARBOR, { categories: [CUSTOM] }))
})
