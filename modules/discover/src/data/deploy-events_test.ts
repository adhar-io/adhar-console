import { assertEquals } from 'jsr:@std/assert@1'
import { type AppLike, deployEvents, shortRev } from './deploy-events.ts'

const app = (name: string, ns: string, history: Array<{ deployedAt: string; revision: string }>, op?: { phase: string; finishedAt: string }) =>
  ({
    metadata: { name, namespace: 'argocd', labels: {} },
    spec: { destination: { namespace: ns, server: '' } },
    status: {
      health: { status: 'Healthy' },
      sync: { status: 'Synced' },
      history: history.map((h, i) => ({ id: i, ...h })),
      operationState: op,
    },
  }) as unknown as AppLike

Deno.test('deployEvents: in-window history + failed operations, newest first, namespace filter', () => {
  const now = Date.parse('2026-10-17T12:00:00Z')
  const apps = [
    app('web', 'shop', [{ deployedAt: '2026-10-17T11:30:00Z', revision: 'a'.repeat(40) }, { deployedAt: '2026-10-16T11:30:00Z', revision: 'old' }]),
    app('api', 'core', [{ deployedAt: '2026-10-17T11:00:00Z', revision: 'b1' }], { phase: 'Failed', finishedAt: '2026-10-17T11:45:00Z' }),
  ]
  const ev = deployEvents(apps, now - 3_600_000)
  assertEquals(ev.map((e) => `${e.app}:${e.phase}`), ['api:Failed', 'web:Succeeded', 'api:Succeeded'])
  assertEquals(deployEvents(apps, now - 3_600_000, 'shop').map((e) => e.app), ['web'])
  assertEquals(shortRev('a'.repeat(40)), 'aaaaaaa')
  assertEquals(shortRev('v1.2.0'), 'v1.2.0')
})
