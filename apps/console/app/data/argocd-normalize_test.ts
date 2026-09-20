import { assertEquals } from 'jsr:@std/assert'
import { argocd } from '@adhar-console/api-clients'

/**
 * `normalizeApplication` is the boundary the Overview's DORA panels read
 * through, and it silently dropped two things they depend on:
 *
 *   • `status.history` — reduced to a `deployments` COUNT, so deploy
 *     frequency and lead time derived nothing from a cluster with hundreds
 *     of deploys.
 *   • per-resource names — `status.resources` became a `{total, outOfSync,
 *     unhealthy}` summary, and a caller that iterated it with `for...of`
 *     threw "object is not iterable" and took the whole Overview down.
 *
 * Both are pinned here because the failure mode is a wrong number or a blank
 * page, neither of which points back at this function.
 */

const raw = {
  metadata: { name: 'adhar-ai', namespace: 'argocd' },
  spec: {
    project: 'default',
    destination: { server: 'https://kubernetes.default.svc', namespace: 'adhar-system' },
    sources: [{ repoURL: 'http://gitea/adhar/packages', path: 'ai/manifests' }],
  },
  status: {
    sync: { status: 'Synced' },
    health: { status: 'Healthy' },
    history: [
      {
        id: 0,
        deployedAt: '2026-09-20T05:15:36Z',
        revisions: ['2aaa783a5560d6e97d5f6c5e27bdbfeec85ef543'],
        sources: [{ repoURL: 'http://gitea/adhar/packages' }],
      },
    ],
    resources: [
      { kind: 'Deployment', name: 'adhar-ai', namespace: 'adhar-system', status: 'Synced' },
      { kind: 'ConfigMap', name: 'adhar-ai-config', namespace: 'adhar-system', status: 'OutOfSync' },
    ],
  },
}

Deno.test('the sync history survives normalization', () => {
  const app = argocd.normalizeApplication(raw as never)
  assertEquals(app.status.history.length, 1)
  assertEquals(app.status.history[0].deployedAt, '2026-09-20T05:15:36Z')
})

Deno.test('a multi-source revision and repo survive, not just the singular fields', () => {
  // Every application on a real cluster is multi-source; parsing only
  // `revision`/`source` made every deploy look like it had no commit.
  const h = argocd.normalizeApplication(raw as never).status.history[0]
  assertEquals(h.revisions?.[0], '2aaa783a5560d6e97d5f6c5e27bdbfeec85ef543')
  assertEquals(h.sources?.[0]?.repoURL, 'http://gitea/adhar/packages')
})

Deno.test('resourceList keeps names; resources stays a count summary', () => {
  const app = argocd.normalizeApplication(raw as never)
  assertEquals(app.status.resourceList.map((r) => r.name), ['adhar-ai', 'adhar-ai-config'])
  assertEquals(app.status.resourceList[0].kind, 'Deployment')
  assertEquals(app.status.resources, { total: 2, outOfSync: 1, unhealthy: 0 })
})

Deno.test('resourceList is an ARRAY, which the count summary is not', () => {
  // The exact distinction that crashed the Overview: `for (const r of
  // status.resources)` over `{total, outOfSync, unhealthy}` throws
  // "object is not iterable (cannot read property Symbol(Symbol.iterator))".
  const app = argocd.normalizeApplication(raw as never)
  assertEquals(Array.isArray(app.status.resourceList), true)
  assertEquals(Array.isArray(app.status.resources), false)
})

Deno.test('an app with no history or resources normalizes to empty arrays', () => {
  const bare = argocd.normalizeApplication({ metadata: { name: 'x' } } as never)
  assertEquals(bare.status.history, [])
  assertEquals(bare.status.resourceList, [])
  assertEquals(bare.status.resources.total, 0)
})
