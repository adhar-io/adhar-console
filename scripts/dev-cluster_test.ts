import { assertEquals } from 'jsr:@std/assert'
import {
  assignPorts,
  containerEnv,
  parseClusterService,
  PORT_BASE,
  SSO_GATED,
  tunnelsFromEnv,
} from './dev-cluster.ts'

/**
 * `dev:env` and `dev:tunnel` run at different times and never share state, so
 * the only thing keeping them pointed at the same ports is that this mapping
 * is deterministic. If it is not, the console addresses a port nothing is
 * listening on and every panel for that tool fails with an error that names
 * neither script.
 */

Deno.test('an in-cluster Service URL is parsed into namespace, service and port', () => {
  assertEquals(
    parseClusterService('http://gitea-http.adhar-system.svc.cluster.local:3000'),
    { service: 'gitea-http', namespace: 'adhar-system', port: 3000, path: '' },
  )
})

Deno.test('the short `.svc` form works too', () => {
  assertEquals(parseClusterService('http://loki.adhar-system.svc:3100'), {
    service: 'loki',
    namespace: 'adhar-system',
    port: 3100,
    path: '',
  })
})

Deno.test('a missing port falls back to the scheme default', () => {
  assertEquals(parseClusterService('http://harbor.adhar-system.svc.cluster.local')?.port, 80)
  assertEquals(parseClusterService('https://kyverno-svc.adhar-system.svc.cluster.local')?.port, 443)
})

Deno.test('a path suffix is preserved', () => {
  // AI_BASE_URL is `…:8080/v1`; dropping the /v1 points the AI provider at the
  // gateway root and every completion 404s.
  assertEquals(
    parseClusterService('http://adhar-ai-gateway.adhar-system.svc.cluster.local:8080/v1')?.path,
    '/v1',
  )
  assertEquals(parseClusterService('http://a.b.svc:80/')?.path, '')
})

Deno.test('the tunnel carries the path through', () => {
  const t = tunnelsFromEnv(
    [{ name: 'AI_BASE_URL', value: 'http://gw.adhar-system.svc.cluster.local:8080/v1' }],
    SSO_GATED,
  )
  assertEquals(t[0].path, '/v1')
})

Deno.test('public and malformed URLs are not cluster services', () => {
  assertEquals(parseClusterService('https://gitea.cloud.adhar.io'), null)
  assertEquals(parseClusterService('http://localhost:3000'), null)
  assertEquals(parseClusterService('not a url'), null)
  assertEquals(parseClusterService(''), null)
})

Deno.test('ports are assigned by sorted var name, so both scripts agree', () => {
  // Deliberately out of order: the Deployment's env order must not decide the
  // port, or reordering a variable silently repoints every tunnel.
  const got = assignPorts([
    { varName: 'PROMETHEUS_URL', namespace: 'n', service: 'p', remotePort: 9090, path: '' },
    { varName: 'ARGOCD_URL', namespace: 'n', service: 'a', remotePort: 80, path: '' },
    { varName: 'LOKI_URL', namespace: 'n', service: 'l', remotePort: 3100, path: '' },
  ])
  assertEquals(got.map((t) => [t.varName, t.localPort]), [
    ['ARGOCD_URL', PORT_BASE],
    ['LOKI_URL', PORT_BASE + 1],
    ['PROMETHEUS_URL', PORT_BASE + 2],
  ])
})

Deno.test('the same input always produces the same ports', () => {
  const input = [
    { varName: 'B_URL', namespace: 'n', service: 'b', remotePort: 1, path: '' },
    { varName: 'A_URL', namespace: 'n', service: 'a', remotePort: 2, path: '' },
  ]
  assertEquals(assignPorts(input), assignPorts([...input].reverse()))
})

Deno.test('only SSO-gated tools are tunnelled', () => {
  // Gitea, Grafana and Harbor answer 200 on the public ingress, so tunnelling
  // them would be pointless work and an extra process to keep alive.
  const env = [
    { name: 'PROMETHEUS_URL', value: 'http://prom.adhar-system.svc.cluster.local:9090' },
    { name: 'GITEA_URL', value: 'http://gitea-http.adhar-system.svc.cluster.local:3000' },
    { name: 'GRAFANA_URL', value: 'http://prometheus-grafana.adhar-system.svc.cluster.local:80' },
  ]
  assertEquals(tunnelsFromEnv(env, SSO_GATED).map((t) => t.varName), ['PROMETHEUS_URL'])
})

Deno.test('a tool already on a public URL is not tunnelled', () => {
  // Some installs set the public URL directly; there is no Service to forward.
  const env = [{ name: 'ARGOCD_URL', value: 'https://argocd.cloud.adhar.io' }]
  assertEquals(tunnelsFromEnv(env, SSO_GATED), [])
})

Deno.test('env entries with no value are skipped', () => {
  // `valueFrom` secretKeyRef entries have no inline value.
  assertEquals(tunnelsFromEnv([{ name: 'ARGOCD_URL' }], SSO_GATED), [])
})

Deno.test('non-URL variables are ignored', () => {
  const env = [{ name: 'ARGOCD_NAMESPACE', value: 'adhar-system' }]
  assertEquals(tunnelsFromEnv(env, SSO_GATED), [])
})

Deno.test('the container env is read out of a Deployment, and bad JSON is empty', () => {
  const json = JSON.stringify({
    spec: { template: { spec: { containers: [{ env: [{ name: 'A', value: 'b' }] }] } } },
  })
  assertEquals(containerEnv(json), [{ name: 'A', value: 'b' }])
  assertEquals(containerEnv('{not json'), [])
  assertEquals(containerEnv('{}'), [])
})
