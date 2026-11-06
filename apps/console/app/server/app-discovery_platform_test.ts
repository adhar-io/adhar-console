import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1'
import { APP_CONFIG_SETTLE_MS } from '../../../../packages/shell-ui/src/app-config.ts'
import { browserUiFromProbe, type HttpRoute, isPlatformRoute, routedApps, routeOwner, TTL_MS } from './app-discovery.ts'

const NOW = Date.parse('2026-11-06T12:00:00Z')
const ago = (mins: number) => new Date(NOW - mins * 60_000).toISOString()

/** A route the way Argo CD leaves it on the cluster. */
function route(name: string, host: string, owner?: string, namespace = 'adhar-system'): HttpRoute {
  return {
    metadata: {
      name,
      namespace,
      annotations: owner ? { 'argocd.argoproj.io/tracking-id': `${owner}:gateway.networking.k8s.io/HTTPRoute:${namespace}/${name}` } : undefined,
    },
    spec: { hostnames: [host] },
  }
}

/** An Application as Argo CD reports it. */
function application(name: string, over: { health?: string; sync?: string; ageMins?: number; history?: boolean; deleting?: boolean; category?: string } = {}) {
  const { health = 'Healthy', sync = 'Synced', ageMins = 600, history = true, deleting = false, category } = over
  return {
    metadata: {
      name,
      creationTimestamp: ago(ageMins),
      ...(deleting ? { deletionTimestamp: ago(1) } : {}),
      ...(category ? { labels: { 'adhar.io/category': category } } : {}),
    },
    status: { health: { status: health }, sync: { status: sync }, history: history ? [{}] : [] },
  }
}

const discover = (routes: HttpRoute[], apps: ReturnType<typeof application>[] | null) =>
  routedApps(routes, apps, 'platform.adhar.io', '', 'https:', NOW).map((a) => a.id)

// The app drawer lists PLATFORM apps only. Teams' routes live in their
// environment namespaces and, when the environment repeats the host's first
// label, are one label deep (`my-service-dev.dev.adhar.io`) — the hostname rule
// alone turned them into drawer tiles (2026-10-24).
Deno.test('only routes in the platform namespace become launcher tiles', () => {
  assert(isPlatformRoute({ metadata: { namespace: 'adhar-system', name: 'tolgee' } }))
  for (const ns of ['dev', 'test', 'prod', 'adhar-environments', undefined]) {
    assertFalse(isPlatformRoute({ metadata: { namespace: ns, name: 'my-service' } }), `namespace ${ns}`)
  }
})

Deno.test('discovery applies the platform-route filter to every HTTPRoute', () => {
  assertEquals(
    discover([route('reactapp', 'reactapp-dev.platform.adhar.io', 'adhar-reactapp-dev', 'dev')], [application('adhar-reactapp-dev')]),
    [],
  )
})

Deno.test('a new package appears from its route, with no console change', () => {
  const [app] = routedApps(
    [route('argo-workflows', 'argo-workflows.platform.adhar.io', 'argo-workflows')],
    [application('argo-workflows', { category: 'application' })],
    'platform.adhar.io',
    '',
    'https:',
    NOW,
  )
  assertEquals(app, {
    id: 'argo-workflows',
    host: 'argo-workflows.platform.adhar.io',
    url: 'https://argo-workflows.platform.adhar.io',
    route: 'adhar-system/argo-workflows',
    category: 'application',
  })
})

Deno.test('the URL comes from the route, carrying the port the platform is served on', () => {
  const [app] = routedApps([route('x', 'x.adhar.localtest.me', 'x')], [application('x')], 'adhar.localtest.me', '8443', 'https:', NOW)
  assertEquals(app.url, 'https://x.adhar.localtest.me:8443')
})

Deno.test('a backend-only package has no route, so nothing is offered for it', () => {
  // pr-agent on the live cluster: an Application and no HTTPRoute.
  assertEquals(discover([], [application('pr-agent')]), [])
})

Deno.test('a package mid-install is not offered until it has been applied', () => {
  const r = route('n8n', 'n8n.platform.adhar.io', 'n8n')
  assertEquals(discover([r], [application('n8n', { ageMins: 1, health: 'Progressing', sync: 'OutOfSync', history: false })]), [])
  // First sync done, pods still starting: the door would answer 503.
  assertEquals(discover([r], [application('n8n', { ageMins: 2, health: 'Progressing' })]), [])
  assertEquals(discover([r], [application('n8n', { ageMins: 3 })]), ['n8n'])
})

Deno.test('a disabled package disappears the moment its Application is going or gone', () => {
  const r = route('n8n', 'n8n.platform.adhar.io', 'n8n')
  assertEquals(discover([r], [application('n8n')]), ['n8n'])
  // Argo CD pruning it: the route is still there for a while.
  assertEquals(discover([r], [application('n8n', { deleting: true })]), [])
  // Application gone, route left behind.
  assertEquals(discover([r], []), [])
})

Deno.test('an established app stays offered through a rollout or a degraded spell', () => {
  const r = route('grafana', 'grafana.platform.adhar.io', 'kube-prometheus')
  assertEquals(discover([r], [application('kube-prometheus', { health: 'Progressing' })]), ['grafana'])
  assertEquals(discover([r], [application('kube-prometheus', { health: 'Degraded' })]), ['grafana'])
  assertEquals(discover([r], [application('kube-prometheus', { sync: 'OutOfSync' })]), ['grafana'])
})

Deno.test('bootstrap routes have no owner and are always offered', () => {
  const r = route('argocd-server', 'argocd.platform.adhar.io')
  assertEquals(routeOwner(r), undefined)
  assertEquals(discover([r], []), ['argocd'])
})

Deno.test('when Applications cannot be read, ownership is unknown and routes still count', () => {
  assertEquals(discover([route('n8n', 'n8n.platform.adhar.io', 'n8n')], null), ['n8n'])
})

Deno.test('the owner is read from the tracking id', () => {
  assertEquals(routeOwner(route('grafana', 'grafana.platform.adhar.io', 'kube-prometheus')), 'kube-prometheus')
})

// What every route on the live cluster answered, signed out, asking for HTML
// (2026-11-06). These are the responses the classification was written against.
Deno.test('a probe tells a UI from an API by what a signed-out browser receives', () => {
  // argo-workflows, harbor, headlamp
  assertEquals(browserUiFromProbe(200, 'text/html; charset=utf-8'), true)
  // Keycloak via oauth2-proxy, an app's own login, an empty-bodied redirect
  assertEquals(browserUiFromProbe(302, 'text/html; charset=utf-8'), true)
  assertEquals(browserUiFromProbe(303, ''), true)
  assertEquals(browserUiFromProbe(307, ''), true)
  // ai and mcp: agentgateway refusing with no bearer
  assertEquals(browserUiFromProbe(401, 'text/plain'), false)
  // faro's collector
  assertEquals(browserUiFromProbe(404, 'text/plain; charset=utf-8'), false)
  // A JSON API, a 404 page styled in HTML, an HTML sign-in served as a 401
  assertEquals(browserUiFromProbe(200, 'application/json'), false)
  assertEquals(browserUiFromProbe(404, 'text/html'), false)
  assertEquals(browserUiFromProbe(401, 'text/html'), true)
  // A 5xx is an app restarting, not evidence about what it is
  assertEquals(browserUiFromProbe(503, 'text/html'), undefined)
  assertEquals(browserUiFromProbe(502, 'text/plain'), undefined)
})

Deno.test('the drawer waits out the list cache before re-reading after a watch event', () => {
  // Otherwise the refetch for "this app just turned Healthy" is answered from a
  // list taken before it did, and no further event ever corrects the drawer.
  assert(APP_CONFIG_SETTLE_MS > TTL_MS, `settle ${APP_CONFIG_SETTLE_MS} must exceed TTL ${TTL_MS}`)
})
