import { assert, assertEquals } from 'jsr:@std/assert@1'
import { andQuery, compile, lex, parse, type QlContext, type QlIssue, setOrderBy, splitOrderBy, suggest } from './work-ql.ts'

const NOW = Date.parse('2026-10-21T12:00:00Z')

const ctx: QlContext = {
  now: NOW,
  me: 'u-ada',
  projects: [
    { id: 'p1', identifier: 'CON', name: 'Console' },
    { id: 'p2', identifier: 'OPS', name: 'Operations' },
  ],
  states: [
    { id: 's-todo', name: 'Todo', group: 'unstarted', project: 'p1', sequence: 1 },
    { id: 's-prog', name: 'In Progress', group: 'started', project: 'p1', sequence: 2 },
    { id: 's-done', name: 'Done', group: 'completed', project: 'p1', sequence: 3 },
    { id: 's2-todo', name: 'Todo', group: 'unstarted', project: 'p2', sequence: 1 },
  ],
  labels: [
    { id: 'l-bug', name: 'bug', project: 'p1' },
    { id: 'l-ui', name: 'ui', project: 'p1' },
  ],
  members: [
    { id: 'u-ada', name: 'Ada Lovelace', email: 'ada@acme.io' },
    { id: 'u-bob', name: 'bob', email: 'bob@acme.io' },
  ],
  cycles: [
    { id: 'c-now', name: 'Sprint 12', status: 'current' },
    { id: 'c-next', name: 'Sprint 13', status: 'upcoming' },
  ],
  modules: [{ id: 'm-auth', name: 'Auth revamp' }],
}

const mk = (id: string, extra: Partial<QlIssue> = {}): QlIssue => ({
  id,
  name: id,
  project: 'p1',
  state: 's-todo',
  priority: 'none',
  assignees: [],
  labels: [],
  created_at: '2026-10-01T00:00:00Z',
  ...extra,
})

const ISSUES: QlIssue[] = [
  mk('a', { sequence_id: 1, state: 's-prog', priority: 'high', assignees: ['u-ada'], labels: ['l-bug'], cycle: 'c-now', target_date: '2026-10-20', estimate_point: 3, sort_order: 300 }),
  mk('b', { sequence_id: 2, priority: 'urgent', labels: ['l-bug', 'l-ui'], module: 'm-auth', target_date: '2026-10-25', estimate_point: 5, sort_order: 100 }),
  mk('c', { sequence_id: 3, state: 's-done', priority: 'low', assignees: ['u-bob'], name: 'Login page crash', description_stripped: 'stack trace on submit', sort_order: 200 }),
  mk('d', { sequence_id: 4, project: 'p2', state: 's2-todo', priority: 'medium', parent: 'a', updated_at: '2026-10-21T00:00:00Z' }),
]

const run = (q: string) => {
  const c = compile(q, ctx)
  return { ids: ISSUES.filter(c.predicate).sort(c.compare).map((i) => i.id), c }
}

Deno.test('lexer handles quotes, operators, parens and functions', () => {
  const t = lex('status in (Todo, "In Progress") AND assignee != me()')
  assertEquals(t.map((x) => x.value), ['status', 'in', '(', 'Todo', ',', 'In Progress', ')', 'AND', 'assignee', '!=', 'me', '(', ')'])
  assertEquals(lex('"unterminated')[0].open, true)
})

Deno.test('the brief example compiles and filters', () => {
  const { ids } = run('project = CON AND status in (Todo, "In Progress") AND assignee = me AND label = bug ORDER BY priority')
  // Unquoted `me` reads as me(); a member literally called "me" needs quotes.
  assertEquals(ids, ['a'])
  assert(compile('assignee = "me"', ctx).warnings.some((w) => w.includes('No member "me"')))
  const real = run('project = CON AND status in (Todo, "In Progress") AND assignee = me() AND label = bug ORDER BY priority')
  assertEquals(real.ids, ['a'])
  assertEquals(real.c.projectIds, ['p1'])
  assertEquals(real.c.errors, [])
})

Deno.test('OR, NOT, parentheses and juxtaposition', () => {
  assertEquals(run('priority = urgent OR priority = low ORDER BY key').ids, ['b', 'c'])
  assertEquals(run('NOT label = bug ORDER BY key').ids, ['c', 'd'])
  assertEquals(run('(label = ui OR assignee = bob) priority != low ORDER BY key').ids, ['b'])
  assertEquals(run('label not in (bug) ORDER BY key').ids, ['c', 'd'])
})

Deno.test('EMPTY, categories, sprints and epics', () => {
  assertEquals(run('assignee is empty ORDER BY key').ids, ['b', 'd'])
  assertEquals(run('assignee = EMPTY ORDER BY key').ids, ['b', 'd'])
  assertEquals(run('category = done').ids, ['c'])
  assertEquals(run('statusCategory in (unstarted, "in progress") ORDER BY key').ids, ['a', 'b', 'd'])
  assertEquals(run('sprint in openSprints()').ids, ['a'])
  assertEquals(run('sprint is empty AND epic = "Auth revamp"').ids, ['b'])
})

Deno.test('dates, relative offsets and numbers', () => {
  assertEquals(run('due < now() ORDER BY key').ids, ['a'])
  assertEquals(run('due <= +7d ORDER BY key').ids, ['a', 'b'])
  assertEquals(run('due = 2026-10-25').ids, ['b'])
  assertEquals(run('due > 2026-10-20').ids, ['b'])
  assertEquals(run('estimate >= 4').ids, ['b'])
  assertEquals(run('updated >= -1d').ids, ['d'])
  assertEquals(run('priority > medium ORDER BY key').ids, ['a', 'b'])
})

Deno.test('text search, keys and parents', () => {
  assertEquals(run('login').ids, ['c'])
  assertEquals(run('text ~ "stack trace"').ids, ['c'])
  assertEquals(run('"crash" priority = low').ids, ['c'])
  assertEquals(run('key = con-2').ids, ['b'])
  assertEquals(run('key in (OPS-4, CON-1) ORDER BY key').ids, ['a', 'd'])
  const withKeys = compile('parent = CON-1', { ...ctx, idByKey: new Map([['CON-1', 'a']]) })
  assertEquals(ISSUES.filter(withKeys.predicate).map((i) => i.id), ['d'])
  assertEquals(run('parent is empty ORDER BY key').ids, ['a', 'b', 'c'])
  assertEquals(compile('crash', ctx).textTerms, ['crash'])
})

Deno.test('ORDER BY: priority asc is most urgent first; missing values sink; multi-key', () => {
  assertEquals(run('ORDER BY priority').ids, ['b', 'a', 'd', 'c'])
  assertEquals(run('ORDER BY priority DESC').ids, ['c', 'd', 'a', 'b'])
  assertEquals(run('ORDER BY due DESC').ids, ['b', 'a', 'c', 'd'])
  assertEquals(run('ORDER BY rank').ids, ['b', 'c', 'a', 'd'])
  assertEquals(run('ORDER BY status, key').ids, ['b', 'd', 'a', 'c'])
})

Deno.test('cross-project: project in (...) reports every named project', () => {
  const { c, ids } = run('project in (CON, OPS) AND category = unstarted ORDER BY key')
  assertEquals(c.projectIds?.sort(), ['p1', 'p2'])
  assertEquals(ids, ['b', 'd'])
  // Negated project clauses do not ask for a project to be loaded.
  assertEquals(compile('project != OPS', ctx).projectIds, null)
})

Deno.test('errors and warnings are reported, never thrown', () => {
  const bad = parse('status = ')
  assert(bad.errors.length > 0)
  const unknown = parse('colour = red')
  assert(unknown.errors.some((e) => e.message.includes('Unknown field')))
  assert(parse('status in (Todo').errors.some((e) => e.message.includes('Missing ")"')))
  assert(parse('ORDER BY nonsense').errors.some((e) => e.message.includes("Can't sort")))
  const noMe = compile('assignee = me()', { ...ctx, me: undefined })
  assert(noMe.warnings[0].includes('me() matches nobody'))
  assertEquals(ISSUES.filter(noMe.predicate).length, 0)
})

Deno.test('text helpers: split/and/setOrderBy', () => {
  assertEquals(splitOrderBy('label = bug ORDER BY due DESC'), { where: 'label = bug', orderBy: 'due DESC' })
  assertEquals(andQuery('a = 1 OR b = 2 ORDER BY key', ['assignee = me()']), '(a = 1 OR b = 2) AND assignee = me() ORDER BY key')
  assertEquals(andQuery('', ['label = bug']), 'label = bug')
  assertEquals(setOrderBy('label = bug ORDER BY key', 'due', 'desc'), 'label = bug ORDER BY due DESC')
  assertEquals(setOrderBy('label = bug ORDER BY key', null), 'label = bug')
})

Deno.test('autocomplete walks field → operator → value → keyword', () => {
  const labels = (q: string, at = q.length) => suggest(q, at, ctx).items.map((i) => i.label)
  assert(labels('').includes('project'))
  assertEquals(labels('sta'), ['status', 'start'])
  assert(labels('status ').includes('in'))
  assertEquals(labels('status = '), ['Todo', 'In Progress', 'Done'])
  assertEquals(labels('status = "In P'), ['In Progress'])
  assert(labels('assignee = ').includes('me()'))
  assert(labels('sprint in (').includes('openSprints()'))
  assertEquals(labels('label = bug '), ['AND', 'OR', 'ORDER BY'])
  assert(labels('label = bug ORDER BY ').includes('priority'))
  assertEquals(labels('label = bug ORDER BY due '), ['ASC', 'DESC'])
  assertEquals(labels('status in (Todo, '), ['Todo', 'In Progress', 'Done'])
  assertEquals(labels('status in (Todo) '), ['AND', 'OR', 'ORDER BY'])
  // The replacement range covers the partial word.
  const s = suggest('label = bu AND x', 10, ctx)
  assertEquals([s.from, s.to], [8, 10])
  // Multi-word values insert quoted.
  assertEquals(suggest('status = In', 11, ctx).items[0].insert, '"In Progress"')
})
