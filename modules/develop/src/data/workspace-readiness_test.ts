import { assert, assertEquals } from 'jsr:@std/assert'
import { primaryAgent, tallyReadiness, workspaceState } from './workspace-readiness.ts'
import type { coder } from '@adhar/api-clients'

function ws(
  status: string,
  agent?: { status?: string; lifecycle_state?: string; name?: string } | null,
): coder.Workspace {
  return {
    id: 'w1',
    name: 'test-service',
    latest_build: {
      status,
      resources: agent === undefined
        ? []
        : agent === null
        ? [{ name: 'pod', agents: [] }]
        : [{ name: 'pod', agents: [{ name: agent.name ?? 'main', status: agent.status ?? 'connected', lifecycle_state: agent.lifecycle_state, apps: [] }] }],
    },
  } as unknown as coder.Workspace
}

Deno.test('a connected, ready agent is the only thing that counts as ready', () => {
  const s = workspaceState(ws('running', { status: 'connected', lifecycle_state: 'ready' }))
  assertEquals(s.readiness, 'ready')
  assertEquals(s.label, 'Ready')
  assert(s.usable)
  assertEquals(s.agent, 'main')
})

/**
 * The bug this exists for. A workspace built for a dormant Coder owner reaches
 * `running`, and its agent is refused with 401 and times out. The page said
 * "1 running" and offered IDE buttons that could only open a dead app.
 */
Deno.test('running with a timed-out agent is not running, it is unreachable', () => {
  const s = workspaceState(ws('running', { status: 'timeout' }))
  assertEquals(s.readiness, 'unreachable')
  assertEquals(s.label, 'Agent timed out')
  assertEquals(s.usable, false)
  assert(s.reason!.includes('never connected'))
})

Deno.test('an agent that was connected and dropped is reported as lost', () => {
  const s = workspaceState(ws('running', { status: 'disconnected' }))
  assertEquals(s.readiness, 'unreachable')
  assertEquals(s.label, 'Agent lost')
  assertEquals(s.usable, false)
})

Deno.test('an agent still connecting is starting, not broken', () => {
  const s = workspaceState(ws('running', { status: 'connecting' }))
  assertEquals(s.readiness, 'starting')
  assertEquals(s.usable, false)
})

/**
 * Connected is not the same as finished: the startup script clones the repo.
 * An IDE opened mid-startup lands in a half-built home directory.
 */
Deno.test('a connected agent still running its startup script is preparing', () => {
  const s = workspaceState(ws('running', { status: 'connected', lifecycle_state: 'starting' }))
  assertEquals(s.readiness, 'starting')
  assertEquals(s.label, 'Preparing')
  assertEquals(s.usable, false)
})

/** A failed startup script is still openable — into a broken environment. */
Deno.test('a failed startup script is flagged but does not block opening', () => {
  const s = workspaceState(ws('running', { status: 'connected', lifecycle_state: 'start_error' }))
  assertEquals(s.readiness, 'unreachable')
  assert(s.usable)
  assert(s.reason!.includes('startup script failed'))
})

Deno.test('a startup script that timed out does not block a connected agent', () => {
  const s = workspaceState(ws('running', { status: 'connected', lifecycle_state: 'start_timeout' }))
  assertEquals(s.readiness, 'ready')
  assert(s.usable)
})

Deno.test('a running build with no agent has nothing to open', () => {
  for (const w of [ws('running'), ws('running', null)]) {
    const s = workspaceState(w)
    assertEquals(s.readiness, 'unreachable')
    assertEquals(s.label, 'No agent')
    assertEquals(s.usable, false)
  }
})

Deno.test('build states are reported as builds, not as readiness', () => {
  for (const st of ['pending', 'starting', 'stopping', 'canceling', 'deleting']) {
    assertEquals(workspaceState(ws(st)).readiness, 'building')
  }
  assertEquals(workspaceState(ws('failed')).readiness, 'failed')
  assertEquals(workspaceState(ws('stopped')).readiness, 'stopped')
  assertEquals(workspaceState(ws('canceled')).label, 'Gone')
})

Deno.test('a status this console has not seen is unknown, never ready', () => {
  const s = workspaceState(ws('something-new'))
  assertEquals(s.readiness, 'unknown')
  assertEquals(s.usable, false)
})

Deno.test('the first agent of the first resource that has one is the primary', () => {
  const w = {
    latest_build: {
      status: 'running',
      resources: [{ name: 'disk', agents: [] }, { name: 'pod', agents: [{ name: 'main', status: 'connected' }] }],
    },
  } as unknown as coder.Workspace
  assertEquals(primaryAgent(w)?.name, 'main')
  assertEquals(primaryAgent({ latest_build: { status: 'running' } } as unknown as coder.Workspace), undefined)
})

Deno.test('the tally separates usable environments from merely running ones', () => {
  const t = tallyReadiness([
    ws('running', { status: 'connected', lifecycle_state: 'ready' }),
    ws('running', { status: 'timeout' }),
    ws('running', { status: 'connecting' }),
    ws('pending'),
    ws('stopped'),
    ws('failed'),
  ])
  assertEquals(t, { ready: 1, starting: 1, unreachable: 1, building: 1, stopped: 1, failed: 1 })
})
