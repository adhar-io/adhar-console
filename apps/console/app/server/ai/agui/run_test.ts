import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { priorTurns } from './run.ts'

// A delegated run used to receive only the last user message, so the runtime —
// whose own session memory is in-process and best-effort — answered a
// follow-up like "and the other one?" from nothing.
Deno.test('a follow-up carries the earlier turns, oldest first, without the message being asked', () => {
  const thread = [
    { role: 'user', content: 'Which apps are degraded?' },
    { role: 'assistant', content: 'Two: strapi and nexus.   Both are Progressing.' },
    { role: 'user', content: 'And the other one?' },
  ]
  const out = priorTurns(thread)
  assertStringIncludes(out, 'Earlier in this conversation (oldest first):')
  assertStringIncludes(out, 'user: Which apps are degraded?')
  assertStringIncludes(out, 'assistant: Two: strapi and nexus. Both are Progressing.')
  assertEquals(out.includes('And the other one?'), false)
})

Deno.test('the first message of a thread has no earlier turns', () => {
  assertEquals(priorTurns([{ role: 'user', content: 'hello' }]), '')
})

Deno.test('tool transcripts and long threads are bounded', () => {
  const thread = []
  for (let i = 0; i < 20; i++) {
    thread.push({ role: 'user', content: `q${i} ` + 'x'.repeat(1000) })
    thread.push({ role: 'tool', content: 'ignored', toolCallId: 't' })
    thread.push({ role: 'assistant', content: `a${i}` })
  }
  thread.push({ role: 'user', content: 'last' })
  const out = priorTurns(thread)
  const lines = out.split('\n').slice(1)
  assertEquals(lines.length, 6)
  assertEquals(lines.some((l) => l.startsWith('tool:')), false)
  assertEquals(lines[0].startsWith('user: q17 '), true)
  assertEquals(Math.max(...lines.map((l) => l.length)) <= 'user: '.length + 400, true)
})
