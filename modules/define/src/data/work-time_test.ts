import { assertEquals } from 'jsr:@std/assert@1'
import { checklistProgress, formatMinutes, parseDuration } from './work-time.ts'

Deno.test('durations parse Jira-style and format back', () => {
  assertEquals(parseDuration('1h 30m'), 90)
  assertEquals(parseDuration('90m'), 90)
  assertEquals(parseDuration('1.5h'), 90)
  assertEquals(parseDuration('2'), 120)
  assertEquals(parseDuration('1d 2h'), 600)
  assertEquals(parseDuration('soon'), undefined)
  assertEquals(parseDuration('3h lunch'), undefined)
  assertEquals(formatMinutes(90), '1h 30m')
  assertEquals(formatMinutes(120), '2h')
  assertEquals(formatMinutes(45), '45m')
  assertEquals(formatMinutes(null), '—')
})

Deno.test('checklist progress spans every list', () => {
  assertEquals(checklistProgress({ lists: [{ items: [{ done: true }, { done: false }] }, { items: [{ done: true }] }] }), { done: 2, total: 3 })
  assertEquals(checklistProgress(undefined), { done: 0, total: 0 })
})
