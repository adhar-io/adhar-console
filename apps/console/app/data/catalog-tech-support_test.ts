import { assertEquals } from 'jsr:@std/assert@^1'
import { describeSupport, ENDING_SOON_DAYS, REVIEWED_AT, SUPPORT_TABLE, supportStatus, worstSupport } from './catalog-tech-support.ts'

const TODAY = new Date('2026-10-17T12:00:00Z')

Deno.test('support table: reviewed date, cycles ordered, ISO dates', () => {
  assertEquals(REVIEWED_AT, '2026-10')
  for (const [key, p] of Object.entries(SUPPORT_TABLE)) {
    for (const c of p.cycles) {
      if (c.eol) assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(c.eol), true, `${key} ${c.cycle}`)
      assertEquals(c.cycle.split('.').length, p.parts, `${key} ${c.cycle} parts`)
    }
    const nums = p.cycles.map((c) => c.cycle.split('.').map(Number))
    for (let i = 1; i < nums.length; i++) {
      const [a, b] = [nums[i - 1], nums[i]]
      assertEquals(a[0] < b[0] || (a[0] === b[0] && (a[1] ?? 0) < (b[1] ?? 0)), true, `${key} order at ${p.cycles[i].cycle}`)
    }
  }
})

Deno.test('supportStatus: Java LTS, feature releases and the 1.8 spelling', () => {
  assertEquals(supportStatus('java', '21', TODAY).state, 'supported')
  assertEquals(supportStatus('java', '21.0.4', TODAY).lts, true)
  assertEquals(supportStatus('java', '24', TODAY).state, 'eol')
  assertEquals(supportStatus('java', '1.8', TODAY).cycle, '8')
  assertEquals(supportStatus('java', '1.8', TODAY).state, 'supported')
})

Deno.test('supportStatus: ending soon inside the window, EOL after', () => {
  // Python 3.10 ends 2026-10-31 — two weeks out.
  const py = supportStatus('python', '3.10.12', TODAY)
  assertEquals([py.state, py.cycle], ['ending', '3.10'])
  assertEquals((py.days ?? 0) <= ENDING_SOON_DAYS, true)
  assertEquals(supportStatus('python', '3.9', TODAY).state, 'eol')
  assertEquals(supportStatus('node', '20.10+', TODAY).state, 'eol')
  assertEquals(supportStatus('node', '22', TODAY).state, 'supported')
  assertEquals(supportStatus('spring-boot', '3.3.2', TODAY).state, 'eol')
  assertEquals(supportStatus('spring-boot', '4.0.1', TODAY).state, 'ending')
  assertEquals(supportStatus('dotnet', '8.0', TODAY).state, 'ending')
  assertEquals(supportStatus('go', '1.22.5', TODAY).state, 'eol')
  assertEquals(supportStatus('postgres', '16', TODAY).state, 'supported')
  assertEquals(supportStatus('react', '18.3.1', TODAY).state, 'eol')
  assertEquals(supportStatus('react', '19.1.0', TODAY).state, 'supported')
})

Deno.test('supportStatus: unknown tech, missing version, outside the table', () => {
  assertEquals(supportStatus('kafka', '3.7', TODAY).state, 'unknown')
  assertEquals(supportStatus('java', undefined, TODAY).state, 'unknown')
  assertEquals(supportStatus('python', '3', TODAY).state, 'unknown') // no minor → no cycle
  // Newer than the table: the table is stale, not the service.
  assertEquals(supportStatus('java', '29', TODAY).state, 'unknown')
  // Older than every cycle: end of life.
  assertEquals(supportStatus('node', '10', TODAY).state, 'eol')
  assertEquals(supportStatus('nodejs', '24', TODAY).product, 'Node.js')
})

Deno.test('worstSupport and describeSupport', () => {
  const items = [
    { k: 'a', status: supportStatus('java', '21', TODAY) },
    { k: 'b', status: supportStatus('python', '3.10', TODAY) },
    { k: 'c', status: supportStatus('kafka', '3', TODAY) },
  ]
  assertEquals(worstSupport(items)?.k, 'b')
  assertEquals(describeSupport(supportStatus('python', '3.9', TODAY)), 'end of life since Oct 2025')
  assertEquals(describeSupport(supportStatus('python', '3.10', TODAY)), 'support ends Oct 2026')
  assertEquals(describeSupport(supportStatus('java', '21', TODAY)), 'supported until Dec 2029')
})
