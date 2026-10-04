import { assert, assertEquals } from 'jsr:@std/assert'
import { hookSummary, readPolicy } from './tracing-policy.ts'

/** The shape Tetragon's own example policies use. */
const BLOCK_WRITES = {
  metadata: { name: 'block-sensitive-write', creationTimestamp: '2026-10-04T09:00:00Z' },
  spec: {
    kprobes: [
      {
        call: 'security_file_permission',
        selectors: [{ matchActions: [{ action: 'Sigkill' }] }],
      },
      { call: 'security_bprm_check', selectors: [{ matchActions: [{ action: 'Post' }] }] },
    ],
  },
}

Deno.test('a policy is read into its hooks and the actions it can take', () => {
  const p = readPolicy(BLOCK_WRITES)
  assertEquals(p.name, 'block-sensitive-write')
  assertEquals(p.scope, 'cluster')
  assertEquals(p.hooks.length, 2)
  assertEquals(p.hooks[0], { type: 'kprobe', name: 'security_file_permission', enforcing: true })
  assertEquals(p.hooks[1].enforcing, false)
  assertEquals(p.actions, ['Post', 'Sigkill'])
  assert(p.enforcing)
})

/**
 * The difference an operator most needs to see: a policy that only reports is
 * safe to roll out, one that kills processes is not.
 */
Deno.test('a policy with no enforcing action is observation only', () => {
  const p = readPolicy({
    metadata: { name: 'watch-execs' },
    spec: { kprobes: [{ call: 'sys_execve', selectors: [{ matchActions: [{ action: 'Post' }] }] }] },
  })
  assertEquals(p.enforcing, false)
  assertEquals(p.actions, ['Post'])
})

Deno.test('every kind of hook list is collected', () => {
  const p = readPolicy({
    metadata: { name: 'everything' },
    spec: {
      kprobes: [{ call: 'a' }],
      tracepoints: [{ subsystem: 'raw_syscalls', event: 'sys_enter' }],
      uprobes: [{ symbols: ['SSL_write', 'SSL_read'] }],
      lsmhooks: [{ hook: 'file_open' }],
      fentries: [{ call: 'f' }],
    },
  })
  assertEquals(p.hooks.map((h) => h.type), ['kprobe', 'tracepoint', 'uprobe', 'lsm', 'fentry'])
  assertEquals(p.hooks[1].name, 'raw_syscalls/sys_enter')
  // A uprobe hooks a list of symbols, not one.
  assertEquals(p.hooks[2].name, 'SSL_write, SSL_read')
})

Deno.test('a namespaced policy reports its namespace and scope', () => {
  const p = readPolicy({
    metadata: { name: 'ns-policy', namespace: 'payments' },
    spec: { kprobes: [{ call: 'x' }] },
  })
  assertEquals(p.scope, 'namespace')
  assertEquals(p.namespace, 'payments')
})

Deno.test('a pod selector is described rather than dumped', () => {
  const p = readPolicy({
    metadata: { name: 'scoped' },
    spec: { kprobes: [{ call: 'x' }], podSelector: { matchLabels: { app: 'api', tier: 'web' } } },
  })
  assertEquals(p.selector, 'app=api, tier=web')
})

Deno.test('an unscoped policy says nothing rather than "all pods"', () => {
  assertEquals(readPolicy({ metadata: { name: 'x' }, spec: { kprobes: [{ call: 'y' }] } }).selector, undefined)
})

/** A policy object the viewer cannot fully read must not throw a page away. */
Deno.test('a policy with no spec, or a malformed one, still renders', () => {
  const empty = readPolicy({ metadata: { name: 'empty' } })
  assertEquals(empty.hooks, [])
  assertEquals(empty.enforcing, false)
  assertEquals(hookSummary(empty), 'no hooks')

  const junk = readPolicy({ metadata: {}, spec: { kprobes: 'not-a-list', tracepoints: [null] } })
  assertEquals(junk.name, 'unnamed')
  assertEquals(junk.hooks, [])
})

Deno.test('a hook with no recognisable name is labelled, not blank', () => {
  const p = readPolicy({ metadata: { name: 'x' }, spec: { kprobes: [{ selectors: [] }] } })
  assertEquals(p.hooks[0].name, 'unnamed')
})

Deno.test('the summary counts hooks by type and pluralises', () => {
  assertEquals(hookSummary(readPolicy(BLOCK_WRITES)), '2 kprobes')
  assertEquals(
    hookSummary(readPolicy({
      metadata: { name: 'm' },
      spec: { kprobes: [{ call: 'a' }], lsmhooks: [{ hook: 'b' }] },
    })),
    '1 kprobe, 1 lsm',
  )
})
