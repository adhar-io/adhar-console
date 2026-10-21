import { assertEquals } from 'jsr:@std/assert@1'
import { workloadOk, workloadRows } from './workloads.ts'

Deno.test('a frontend that is only a Rollout is listed, ahead of the composed Deployments', () => {
  const rows = workloadRows({
    rollouts: [{ metadata: { name: 'ngapp' }, spec: { replicas: 2 }, status: { readyReplicas: 2, phase: 'Healthy' } }],
    deployments: [{ metadata: { name: 'my-service-cache' }, spec: { replicas: 1 }, status: { readyReplicas: 1 } }],
  })
  assertEquals(rows.map((r) => `${r.kind}/${r.name}`), ['Rollout/ngapp', 'Deployment/my-service-cache'])
  assertEquals(rows.every(workloadOk), true)
})

Deno.test('a paused canary is not reported healthy even with every replica ready', () => {
  const [r] = workloadRows({ rollouts: [{ metadata: { name: 'reactapp' }, spec: { replicas: 1 }, status: { readyReplicas: 2, phase: 'Paused' } }] })
  assertEquals(workloadOk(r), false)
  assertEquals(r.phase, 'Paused')
})
