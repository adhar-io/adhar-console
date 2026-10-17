import { applicationEntities, customAppNames, isCustomWorkload } from './catalog-custom-apps.ts'

Deno.test('the catalog lists custom applications only: composed dependencies are not apps', () => {
  const repo = (name: string) => ({ apiVersion: 'backstage.io/v1alpha1', kind: 'Component', metadata: { name, namespace: 'default' }, spec: {} }) as never
  const xr = (name: string, extra: Record<string, unknown> = {}) =>
    ({ metadata: { name, creationTimestamp: '2026-10-17T00:00:00Z' }, spec: { parameters: { project: 'adhar', source: { repoURL: `https://github.com/acme/${name}.git` }, ...extra } } }) as never
  const custom = customAppNames([repo('my-service'), repo('ngapp')], [xr('my-service'), xr('ledger')])
  const wl = (name: string, labels: Record<string, string> = {}) => ({ metadata: { name, namespace: 'dev', labels } })
  for (const app of ['my-service', 'ngapp', 'ledger']) {
    if (!isCustomWorkload(wl(app), custom)) throw new Error(`${app} should be a custom app`)
  }
  for (const dep of ['my-service-db', 'my-service-cache', 'my-service-events-kafka-exporter', 'my-service-events-entity-operator']) {
    if (isCustomWorkload(wl(dep), custom)) throw new Error(`${dep} is a composed dependency, not an app`)
  }
  if (!isCustomWorkload(wl('orders', { 'adhar.io/application': 'orders' }), custom)) throw new Error('a labelled app workload is custom')
  if (isCustomWorkload(wl('orders-db', { 'adhar.io/application': 'orders' }), custom)) throw new Error("an app's dependency carrying its label is not an app")

  // An XR whose repo is already a Gitea entity is not listed twice; one with an external repo is.
  const fromXrs = applicationEntities([xr('my-service'), xr('ledger', { description: 'Ledger API' })], [repo('my-service')])
  if (fromXrs.length !== 1 || fromXrs[0].metadata.name !== 'ledger') throw new Error(`unexpected XR entities: ${fromXrs.map((e) => e.metadata.name)}`)
  if (fromXrs[0].metadata.links?.[0]?.url !== 'https://github.com/acme/ledger') throw new Error('the external repository is not linked')
})
