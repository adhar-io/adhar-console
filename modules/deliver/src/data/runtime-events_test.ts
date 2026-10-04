import { assert, assertEquals } from 'jsr:@std/assert'
import {
  basename,
  byNewest,
  isShell,
  matchesFilter,
  parseEventLines,
  parseFalcoEvent,
  parseTetragonEvent,
  summarise,
  type RuntimeEvent,
} from './runtime-events.ts'

/**
 * The fixtures below are real lines, trimmed: Tetragon's JSON export from the
 * `export-stdout` sidecar and Falco's JSON alerts, both read from the agents'
 * container logs on a running cluster.
 */

const TG_EXEC = {
  process_exec: {
    process: {
      exec_id: 'YWRoYXItd29ya2Vy',
      pid: 1194595,
      uid: 0,
      cwd: '/',
      binary: '/bin/sleep',
      arguments: '2',
      flags: 'execve rootcwd clone inInitTree',
      start_time: '2026-10-04T08:50:20.940256107Z',
      pod: {
        namespace: 'adhar-system',
        name: 'plane-minio-bucket-1-8876t',
        container: { id: 'containerd://e97', name: 'init', image: { name: 'docker.io/library/busybox' } },
      },
    },
    parent: { binary: '/bin/sh', pid: 1194500 },
  },
  node_name: 'adhar-worker-workers-1',
  time: '2026-10-04T08:50:20.940256107Z',
}

const FALCO_NOTICE = {
  hostname: 'adhar-worker-workers-1',
  output: '08:53:23.659410347: Notice Unexpected connection to K8s API Server from container',
  output_fields: {
    'container.image.repository': 'quay.io/mongodb/mongodb-agent-ubi',
    'container.image.tag': '108.0.6.8796-1',
    'container.name': 'mongodb-agent',
    'k8s.ns.name': 'adhar-system',
    'k8s.pod.name': 'litmus-db-0',
    'proc.cmdline': 'readinessprobe',
    'proc.exepath': '/opt/scripts/readinessprobe',
    'proc.name': 'readinessprobe',
    'proc.pname': 'containerd-shim',
    'user.name': '<NA>',
    'user.uid': 2000,
    'proc.pid': 4242,
  },
  priority: 'Notice',
  rule: 'Contact K8S API Server From Container',
  source: 'syscall',
  tags: ['T1565', 'container', 'mitre_discovery'],
  time: '2026-10-04T08:53:23.659410347Z',
}

Deno.test('a Tetragon exec carries its process, pod and container', () => {
  const e = parseTetragonEvent(TG_EXEC)!
  assertEquals(e.engine, 'tetragon')
  assertEquals(e.kind, 'exec')
  assertEquals(e.binary, '/bin/sleep')
  assertEquals(e.namespace, 'adhar-system')
  assertEquals(e.pod, 'plane-minio-bucket-1-8876t')
  assertEquals(e.container, 'init')
  assertEquals(e.node, 'adhar-worker-workers-1')
  assertEquals(e.parent, '/bin/sh')
  assertEquals(e.title, 'Exec sleep')
  assertEquals(e.severity, 'info')
})

/**
 * An exec and its exit report the same `exec_id` — it identifies the process,
 * not the event. Keying rows on it alone collapsed the pair into one row.
 */
Deno.test('an exec and its exit are two events, not one', () => {
  const exit = {
    process_exit: { process: { ...TG_EXEC.process_exec.process }, status: 0 },
    node_name: 'n1',
    time: '2026-10-04T08:50:21.000000000Z',
  }
  const a = parseTetragonEvent(TG_EXEC)!
  const b = parseTetragonEvent(exit)!
  assert(a.id !== b.id, 'ids must differ')
  assertEquals(b.kind, 'exit')
  assertEquals(b.fields.exit_status, '0')
})

Deno.test('a shell starting in a container is raised above ordinary process noise', () => {
  const sh = structuredClone(TG_EXEC)
  sh.process_exec.process.binary = '/bin/bash'
  const e = parseTetragonEvent(sh)!
  assertEquals(e.severity, 'low')
  assert(e.reason.includes('shell'))
})

/** A shell on the host is not the same signal as a shell inside a workload. */
Deno.test('a shell outside a container is not raised', () => {
  const sh = structuredClone(TG_EXEC) as Record<string, any>
  sh.process_exec.process.binary = '/bin/bash'
  delete sh.process_exec.process.pod
  assertEquals(parseTetragonEvent(sh)!.severity, 'info')
})

Deno.test('a policy match is medium, and enforcement is critical', () => {
  const kprobe = {
    process_kprobe: {
      process: { exec_id: 'k1', pid: 7, binary: '/usr/bin/curl', pod: { namespace: 'prod', name: 'api-0' } },
      function_name: 'security_file_permission',
      policy_name: 'block-sensitive-files',
    },
    node_name: 'n1',
    time: '2026-10-04T09:00:00.000Z',
  }
  const observed = parseTetragonEvent(kprobe)!
  assertEquals(observed.severity, 'medium')
  assertEquals(observed.policy, 'block-sensitive-files')
  assertEquals(observed.hook, 'security_file_permission')
  assertEquals(observed.title, 'security_file_permission')

  const enforced = structuredClone(kprobe) as Record<string, any>
  enforced.process_kprobe.action = 'ACTION_SIGKILL'
  const killed = parseTetragonEvent(enforced)!
  assertEquals(killed.severity, 'critical')
  assertEquals(killed.action, 'SIGKILL')
  assert(killed.reason.includes('SIGKILL'))
})

/** `ACTION_POST` is Tetragon saying "reported", which is not enforcement. */
Deno.test('a reported-only action does not read as enforcement', () => {
  const e = structuredClone({
    process_kprobe: { process: { exec_id: 'k', binary: '/x' }, action: 'ACTION_POST', policy_name: 'p' },
    time: '2026-10-04T09:00:00.000Z',
  })
  const parsed = parseTetragonEvent(e)!
  assertEquals(parsed.action, undefined)
  assertEquals(parsed.severity, 'medium')
})

Deno.test('a tracepoint is named by subsystem and event', () => {
  const e = parseTetragonEvent({
    process_tracepoint: {
      process: { exec_id: 't', binary: '/x' },
      subsys: 'raw_syscalls',
      event: 'sys_enter',
      policy_name: 'syscalls',
    },
    time: '2026-10-04T09:00:00.000Z',
  })!
  assertEquals(e.hook, 'raw_syscalls/sys_enter')
})

/** `node_labels` lines carry no event and must not become blank rows. */
Deno.test('an envelope with no process payload is skipped', () => {
  assertEquals(parseTetragonEvent({ node_labels: {}, time: 't' }), null)
})

Deno.test('a Falco alert keeps its rule, priority, MITRE tags and k8s context', () => {
  const e = parseFalcoEvent(FALCO_NOTICE)!
  assertEquals(e.engine, 'falco')
  assertEquals(e.title, 'Contact K8S API Server From Container')
  assertEquals(e.severity, 'low')
  assertEquals(e.namespace, 'adhar-system')
  assertEquals(e.pod, 'litmus-db-0')
  assertEquals(e.container, 'mongodb-agent')
  assertEquals(e.image, 'quay.io/mongodb/mongodb-agent-ubi:108.0.6.8796-1')
  assertEquals(e.binary, '/opt/scripts/readinessprobe')
  assertEquals(e.parent, 'containerd-shim')
  assertEquals(e.tags, ['T1565', 'container', 'mitre_discovery'])
})

Deno.test('every Falco priority maps onto the shared scale', () => {
  const sev = (p: string) => parseFalcoEvent({ ...FALCO_NOTICE, priority: p })!.severity
  assertEquals(sev('Emergency'), 'critical')
  assertEquals(sev('Critical'), 'critical')
  assertEquals(sev('Error'), 'high')
  assertEquals(sev('Warning'), 'medium')
  assertEquals(sev('Notice'), 'low')
  assertEquals(sev('Debug'), 'info')
})

/** Falco writes `<NA>` where it has no user, which is not a username. */
Deno.test('an unknown Falco user is absent, not the literal <NA>', () => {
  assertEquals(parseFalcoEvent(FALCO_NOTICE)!.user, undefined)
})

Deno.test('a line with no rule is not a Falco event', () => {
  assertEquals(parseFalcoEvent({ priority: 'Notice', output: 'hello' }), null)
})

/**
 * A log tail is not a clean JSON document: agents print plain-text banners,
 * and the first line is routinely a fragment of one that began earlier.
 */
Deno.test('banners and truncated lines are skipped, not fatal', () => {
  const text = [
    'Falco version: 0.41.0 (x86_64)',
    '",\"priority\":\"Notice\"} <- truncated fragment',
    JSON.stringify(FALCO_NOTICE),
    '',
    '{not json at all',
  ].join('\n')
  const events = parseEventLines(text, 'falco')
  assertEquals(events.length, 1)
  assertEquals(events[0].title, 'Contact K8S API Server From Container')
})

Deno.test('an empty log is an empty feed, not an error', () => {
  assertEquals(parseEventLines('', 'tetragon'), [])
  assertEquals(parseEventLines('\n\n', 'falco'), [])
})

Deno.test('the feed runs newest first and does not shuffle on equal times', () => {
  const at = (time: string, id: string): RuntimeEvent =>
    ({ time, id, tags: [], fields: {} } as unknown as RuntimeEvent)
  const list = [at('2026-01-01T00:00:01Z', 'b'), at('2026-01-01T00:00:03Z', 'c'), at('2026-01-01T00:00:01Z', 'a')]
  assertEquals([...list].sort(byNewest).map((e) => e.id), ['c', 'a', 'b'])
})

Deno.test('filters narrow by engine, severity, namespace and free text', () => {
  const e = parseFalcoEvent(FALCO_NOTICE)!
  assert(matchesFilter(e, {}))
  assert(matchesFilter(e, { engines: ['falco'] }))
  assert(!matchesFilter(e, { engines: ['tetragon'] }))
  assert(matchesFilter(e, { severities: ['low'] }))
  assert(!matchesFilter(e, { severities: ['critical'] }))
  assert(matchesFilter(e, { namespace: 'adhar-system' }))
  assert(!matchesFilter(e, { namespace: 'kube-system' }))
  // Free text reaches the pod name and the rule, case-insensitively.
  assert(matchesFilter(e, { search: 'LITMUS' }))
  assert(matchesFilter(e, { search: 'k8s api server' }))
  assert(!matchesFilter(e, { search: 'nonsense' }))
})

Deno.test('an empty engine or severity list is not a filter that excludes everything', () => {
  const e = parseFalcoEvent(FALCO_NOTICE)!
  assert(matchesFilter(e, { engines: [], severities: [] }))
})

Deno.test('the summary counts both engines and ranks what actually matched', () => {
  const events = [
    parseFalcoEvent(FALCO_NOTICE)!,
    parseFalcoEvent({ ...FALCO_NOTICE, time: '2026-10-04T08:54:23.000Z' })!,
    parseFalcoEvent({ ...FALCO_NOTICE, rule: 'Run shell untrusted', priority: 'Warning', time: '2026-10-04T08:55:23.000Z' })!,
    parseTetragonEvent(TG_EXEC)!,
  ]
  const s = summarise(events)
  assertEquals(s.total, 4)
  assertEquals(s.byEngine, { falco: 3, tetragon: 1 })
  // Two Notice alerts, one Warning, and the Tetragon exec that matched nothing.
  assertEquals(s.bySeverity.low, 2)
  assertEquals(s.bySeverity.medium, 1)
  assertEquals(s.bySeverity.info, 1)
  // Ranked by hits, and only things that matched a rule or policy are listed —
  // otherwise plain process activity buries them.
  assertEquals(s.rules[0], { name: 'Contact K8S API Server From Container', count: 2 })
  assertEquals(s.rules.length, 2)
  assertEquals(s.namespaces[0], { name: 'adhar-system', count: 4 })
  assert(s.binaries.some((b) => b.name === 'sleep'))
})

Deno.test('a rate needs a window — one event does not imply a per-minute figure', () => {
  assertEquals(summarise([parseTetragonEvent(TG_EXEC)!]).rate, 0)
  assertEquals(summarise([]).total, 0)
  assertEquals(summarise([]).rate, 0)
})

Deno.test('the rate is events per minute over the observed window', () => {
  const events = Array.from({ length: 11 }, (_, i) =>
    parseFalcoEvent({
      ...FALCO_NOTICE,
      time: new Date(Date.UTC(2026, 9, 4, 9, 0, i * 6)).toISOString(),
    })!)
  // 11 events spanning exactly one minute.
  assertEquals(summarise(events).rate, 11)
})

Deno.test('basename and shell detection handle bare names and paths', () => {
  assertEquals(basename('/usr/bin/bash'), 'bash')
  assertEquals(basename('bash'), 'bash')
  assertEquals(basename(''), '')
  assert(isShell('/bin/sh'))
  assert(isShell('busybox'))
  assert(!isShell('/usr/bin/postgres'))
  assert(!isShell(''))
})
