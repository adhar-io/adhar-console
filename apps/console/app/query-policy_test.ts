import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { applyPollPolicy, createQueryClient } from './query-policy.ts'

Deno.test('applyPollPolicy floors numeric intervals to a minute', () => {
  assertEquals(applyPollPolicy({ refetchInterval: 5_000 }).refetchInterval, 60_000)
  assertEquals(applyPollPolicy({ refetchInterval: 120_000 }).refetchInterval, 120_000)
  assertEquals(applyPollPolicy({ refetchInterval: false }).refetchInterval, false)
  assertEquals(applyPollPolicy<{ refetchInterval?: number }>({}).refetchInterval, undefined)
})

Deno.test('applyPollPolicy floors function intervals and disables background polling', () => {
  const o = applyPollPolicy({ refetchInterval: () => 3_000, refetchIntervalInBackground: true })
  assertEquals((o.refetchInterval as () => number)(), 60_000)
  assertEquals(o.refetchIntervalInBackground, false)
  const off = applyPollPolicy({ refetchInterval: () => false })
  assertEquals((off.refetchInterval as () => false)(), false)
})

Deno.test('the shared client applies the policy to every query', () => {
  const qc = createQueryClient()
  const o = qc.defaultQueryOptions({ queryKey: ['x'], refetchInterval: 2_000 })
  assertEquals(o.refetchInterval, 60_000)
  assertEquals(o.refetchOnWindowFocus, false)
  // idempotent across re-defaulting
  assertEquals(qc.defaultQueryOptions(o).refetchInterval, 60_000)
})
