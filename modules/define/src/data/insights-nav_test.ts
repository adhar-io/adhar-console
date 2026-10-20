import { assertEquals } from 'jsr:@std/assert@1'
import { defineHref, jql } from './insights-query.ts'

Deno.test('jql builds stable JQL-like drill-down queries', () => {
  assertEquals(jql({ project: 'CON', assignee: 'me', statusCategory: ['backlog', 'unstarted', 'started'] }), 'project = CON AND assignee = me AND category in (backlog, unstarted, started)')
  assertEquals(jql({ project: 'CON', due: '< today()', cycle: 'Sprint 4' }), 'project = CON AND sprint = "Sprint 4" AND due < today()')
  assertEquals(jql({ label: 'bug', created: '>= -30d' }), 'label = bug AND created >= -30d')
  assertEquals(jql({ state: 'He said "hi"' }), 'status = "He said \\"hi\\""')
})

Deno.test('defineHref encodes section and params', () => {
  assertEquals(defineHref('issues', { q: 'assignee = me' }), '/define?section=issues&q=assignee+%3D+me')
  assertEquals(defineHref('reports', { report: 'velocity', range: '30' }), '/define?section=reports&report=velocity&range=%2230%22')
})
