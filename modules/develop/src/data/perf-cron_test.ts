import { assertEquals, assertThrows } from 'jsr:@std/assert@^1'
import { cronError, describeCron, nextRuns, parseCron } from './perf-cron.ts'

/**
 * The "next run" column is computed here, not read from the cluster, so it
 * must agree with the CronJob controller — including its odd corners.
 */

const at = (iso: string) => Date.parse(iso)
const iso = (ms: number) => new Date(ms).toISOString()

Deno.test('the next run is strictly after now', () => {
  assertEquals(nextRuns('0 2 * * *', at('2026-10-11T01:59:30Z')).map(iso), ['2026-10-11T02:00:00.000Z'])
  // Exactly on the minute: that one has already fired.
  assertEquals(nextRuns('0 2 * * *', at('2026-10-11T02:00:00Z')).map(iso), ['2026-10-12T02:00:00.000Z'])
})

Deno.test('steps, ranges and lists', () => {
  assertEquals(
    nextRuns('*/15 * * * *', at('2026-10-11T10:07:00Z'), 3).map(iso),
    ['2026-10-11T10:15:00.000Z', '2026-10-11T10:30:00.000Z', '2026-10-11T10:45:00.000Z'],
  )
  assertEquals(
    nextRuns('0 9,17 * * *', at('2026-10-11T10:00:00Z'), 2).map(iso),
    ['2026-10-11T17:00:00.000Z', '2026-10-12T09:00:00.000Z'],
  )
})

Deno.test('weekdays skip the weekend', () => {
  // 2026-10-10 is a Saturday.
  assertEquals(nextRuns('0 6 * * 1-5', at('2026-10-10T12:00:00Z')).map(iso), ['2026-10-12T06:00:00.000Z'])
  assertEquals(nextRuns('0 6 * * MON-FRI', at('2026-10-10T12:00:00Z')).map(iso), ['2026-10-12T06:00:00.000Z'])
})

Deno.test('Sunday is both 0 and 7', () => {
  assertEquals(nextRuns('0 3 * * 7', at('2026-10-10T12:00:00Z')), nextRuns('0 3 * * 0', at('2026-10-10T12:00:00Z')))
})

Deno.test('day-of-month and day-of-week together mean EITHER, as in classic cron', () => {
  // The 13th, or any Friday. 2026-10-11 is a Sunday; Friday the 16th comes after the 13th.
  assertEquals(
    nextRuns('0 0 13 * FRI', at('2026-10-11T00:00:00Z'), 2).map(iso),
    ['2026-10-13T00:00:00.000Z', '2026-10-16T00:00:00.000Z'],
  )
})

Deno.test('macros', () => {
  assertEquals(nextRuns('@daily', at('2026-10-11T10:00:00Z')).map(iso), ['2026-10-12T00:00:00.000Z'])
  assertEquals(nextRuns('@monthly', at('2026-10-11T10:00:00Z')).map(iso), ['2026-11-01T00:00:00.000Z'])
})

Deno.test('Feb 29 is found even years away', () => {
  assertEquals(nextRuns('0 0 29 2 *', at('2026-10-11T00:00:00Z')).map(iso), ['2028-02-29T00:00:00.000Z'])
})

Deno.test('time zones follow spec.timeZone', () => {
  // 02:00 in Kolkata (UTC+5:30) is 20:30 UTC the previous evening.
  assertEquals(
    nextRuns('0 2 * * *', at('2026-10-11T00:00:00Z'), 1, 'Asia/Kolkata').map(iso),
    ['2026-10-11T20:30:00.000Z'],
  )
})

Deno.test('invalid expressions are explained and produce no runs', () => {
  assertEquals(cronError('0 2 * *'), 'expected five fields: minute hour day-of-month month day-of-week')
  assertEquals(typeof cronError('61 * * * *'), 'string')
  assertEquals(typeof cronError('*/0 * * * *'), 'string')
  assertEquals(cronError(''), 'A schedule is required.')
  assertEquals(cronError('0 2 * * *'), null)
  assertEquals(nextRuns('nope', Date.now()), [])
  assertThrows(() => parseCron('@sometimes'))
})

Deno.test('common shapes read as English', () => {
  assertEquals(describeCron('0 2 * * *'), 'Every day at 02:00')
  assertEquals(describeCron('0 6 * * 1-5'), 'Weekdays at 06:00')
  assertEquals(describeCron('*/15 * * * *'), 'Every 15 minutes')
  assertEquals(describeCron('30 * * * *'), 'Every hour at :30')
  assertEquals(describeCron('0 3 * * 0'), 'Every Sun at 03:00')
  assertEquals(describeCron('@hourly'), 'Every hour')
  assertEquals(describeCron('5 4 1,15 * *'), '5 4 1,15 * *')
  assertEquals(describeCron('0 */6 * * 1-5'), 'Every 6 hours at :00, on weekdays')
  assertEquals(describeCron('*/10 * * * 0,6'), 'Every 10 minutes, at weekends')
  assertEquals(describeCron('0 8,20 * * *'), 'Every day at 08:00, 20:00')
  assertEquals(describeCron('15 9,17 * * 1,3'), 'At 09:15, 17:15, on Mon, Wed')
})
