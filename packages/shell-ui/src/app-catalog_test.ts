import { assertEquals } from 'jsr:@std/assert@1'
import { type AppDescriptor, resolveApps, titleize } from './app-catalog.ts'
import { toolLogoKey } from './tool-logos.ts'

const PAGE = { protocol: 'https:', host: 'console.platform.adhar.io' }
const BASE = 'platform.adhar.io'

const CURATED: AppDescriptor[] = [
  { id: 'grafana', name: 'Grafana', description: 'Dashboards', url: 'https://grafana.adhar.localtest.me:8443', category: 'Observe' },
  { id: 'n8n', name: 'n8n', description: 'Automation', url: 'https://n8n.adhar.localtest.me:8443', category: 'Platform' },
  { id: 'vault', name: 'OpenBao', description: 'Secrets', sub: 'openbao', url: 'https://openbao.adhar.localtest.me:8443', category: 'Security' },
  {
    id: 'loki',
    name: 'Loki',
    description: 'Logs',
    url: 'https://grafana.adhar.localtest.me:8443/explore',
    category: 'Observe',
    tools: ['grafana', 'loki'],
    via: { tool: 'grafana', path: '/explore' },
  },
]

const route = (id: string, over: Record<string, unknown> = {}) => ({ id, url: `https://${id}.${BASE}`, ...over })

const resolve = (discoveredApps: Array<ReturnType<typeof route>>, apps = CURATED) =>
  resolveApps(apps, { tools: {}, discoveredApps, publicBaseDomain: BASE }, PAGE, (t) => t)

const ids = (rows: Array<{ id: string }>) => rows.map((a) => a.id).sort()

Deno.test('a package the launcher has never heard of appears, with a generic name', () => {
  const rows = resolve([route('grafana'), route('argo-workflows')])
  const tile = rows.find((a) => a.id === 'argo-workflows')!
  assertEquals(tile.name, 'Argo Workflows')
  assertEquals(tile.url, `https://argo-workflows.${BASE}`)
  assertEquals(tile.configured, true)
  assertEquals(tile.category, 'Platform')
})

Deno.test('the tile takes its section from the package category', () => {
  const rows = resolve([route('grafana'), route('new-db', { category: 'data' }), route('new-sec', { category: 'security' }), route('new-obs', { category: 'observability' }), route('new-app', { category: 'application' })])
  const section = (id: string) => rows.find((a) => a.id === id)!.category
  assertEquals([section('new-db'), section('new-sec'), section('new-obs'), section('new-app')], ['Data', 'Security', 'Observe', 'Platform'])
})

Deno.test('an unknown id still gets a name and falls back to a generic icon', () => {
  assertEquals(titleize('some_new-tool'), 'Some New Tool')
  // No bundled logo: the launcher draws the generic mark rather than nothing.
  assertEquals(toolLogoKey('some-new-tool'), undefined)
  // A family it does know resolves to the family mark.
  assertEquals(toolLogoKey('argo-workflows'), 'argo')
})

Deno.test('a backend-only package has no dead link', () => {
  // pr-agent has an Application and no route, so it is not in discoveredApps.
  assertEquals(ids(resolve([route('grafana')])).includes('pr-agent'), false)
  // A route that answers as an API gets no tile either...
  assertEquals(ids(resolve([route('grafana'), route('new-api', { ui: false })])).includes('new-api'), false)
  // ...while "don't know" (the probe could not reach it) keeps the tile.
  assertEquals(ids(resolve([route('grafana'), route('new-ui')])).includes('new-ui'), true)
  assertEquals(ids(resolve([route('grafana'), route('new-ui', { ui: true })])).includes('new-ui'), true)
})

Deno.test('the known API routes never become tiles', () => {
  const rows = resolve([route('grafana'), route('agent'), route('ai'), route('mcp'), route('faro'), route('mimir')])
  assertEquals(ids(rows), ['grafana', 'loki'])
})

Deno.test('a disabled package disappears when its route leaves the list', () => {
  const before = resolve([route('grafana'), route('n8n'), route('argo-workflows')])
  assertEquals(ids(before), ['argo-workflows', 'grafana', 'loki', 'n8n'])
  // Whether curated (n8n) or discovered (argo-workflows): both go.
  assertEquals(ids(resolve([route('grafana')])), ['grafana', 'loki'])
})

Deno.test('a curated entry keeps its name and is only a door when routed', () => {
  const [grafana] = resolve([route('grafana')])
  assertEquals(grafana.name, 'Grafana')
  // Tools the BFF only derived a URL for do not count as evidence.
  const rows = resolveApps(
    CURATED,
    { tools: { n8n: { configured: true, url: `https://n8n.${BASE}`, explicit: false } }, discoveredApps: [route('grafana')], publicBaseDomain: BASE },
    PAGE,
    (t) => t,
  )
  assertEquals(ids(rows), ['grafana', 'loki'])
})

Deno.test('an operator-set URL off the base domain keeps a curated tile with no route', () => {
  const rows = resolveApps(
    CURATED,
    { tools: { n8n: { configured: true, url: 'https://n8n.example.com', explicit: true } }, discoveredApps: [route('grafana')], publicBaseDomain: BASE },
    PAGE,
    (t) => t,
  )
  assertEquals(rows.find((a) => a.id === 'n8n')?.url, 'https://n8n.example.com')
})

Deno.test('nothing is hidden when the cluster reports no routes at all', () => {
  const rows = resolve([])
  assertEquals(ids(rows), ['grafana', 'loki', 'n8n', 'vault'])
})

Deno.test('no tile ever carries the dev hostname when the cluster is known', () => {
  const rows = resolveApps(CURATED, { tools: {}, discoveredApps: [route('grafana'), route('openbao')], publicBaseDomain: BASE }, PAGE, (t) => t)
  for (const a of rows) assertEquals(a.url.includes('localtest.me'), false, a.id)
  // And the OpenBao route counts for the curated `vault` tile, not a second one.
  assertEquals(ids(rows), ['grafana', 'loki', 'vault'])
})

Deno.test('tile URLs are derived from the page when the BFF reports no base', () => {
  const rows = resolveApps(CURATED, { tools: {}, discoveredApps: [{ id: 'grafana', url: '' }, { id: 'new-ui', url: '' }] }, PAGE, (t) => t)
  assertEquals(rows.find((a) => a.id === 'new-ui')?.url, `https://new-ui.${BASE}`)
  assertEquals(rows.find((a) => a.id === 'grafana')?.url, `https://grafana.${BASE}`)
})

// The bug the user saw: `/api/config` was fetched once when the launcher mounted
// (in the top bar, so once per page load), and a package enabled after that never
// appeared until a reload. No React under the Deno runner, so this reads the source.
Deno.test('the launcher re-reads the app list on open and watches while open', async () => {
  const src = await Deno.readTextFile(new URL('./app-launcher.tsx', import.meta.url))
  assertEquals(src.includes(`fetch('/api/config'`), false, 'must use the shared query, not a one-shot fetch')
  assertEquals(/useResolvedApps\(apps, open\)/.test(src), true, 'the watch must follow the panel')
  assertEquals(/if \(open\) void qc\.invalidateQueries\(\{ queryKey: APP_CONFIG_QUERY_KEY \}/.test(src), true, 'opening must refetch')
  assertEquals(/useLiveAppConfig\(live\)/.test(src), true)
})
