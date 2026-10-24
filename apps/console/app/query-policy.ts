import { QueryClient } from '@tanstack/react-query'
import { POLL_FLOOR_MS } from '@adhar/shell-ui'

/**
 * Fetch policy for the one QueryClient every module shares.
 *
 * Live data reaches the console over `/api/live` (apiserver watches and BFF
 * change detection); a query's timer is only the safety net behind that. So
 * the policy is enforced here, once, rather than trusted to 200 call sites:
 *
 *   • `refetchInterval` never runs faster than `POLL_FLOOR_MS` (a function
 *     interval is wrapped and its answer floored too);
 *   • nothing polls from a background tab;
 *   • no refetch on window focus — pushes keep visible data current, and a
 *     focus refetch fires every query on the page at once;
 *   • 4xx answers are not retried (they will not change on a retry).
 */

type Interval = number | false | undefined

function floor(v: Interval): Interval {
  return typeof v === 'number' && v > 0 ? Math.max(v, POLL_FLOOR_MS) : v
}

export function applyPollPolicy<T extends { refetchInterval?: unknown; refetchIntervalInBackground?: boolean }>(opts: T): T {
  const ri = opts.refetchInterval
  const out = { ...opts, refetchIntervalInBackground: false }
  if (typeof ri === 'function') {
    out.refetchInterval = (...args: unknown[]) => floor((ri as (...a: unknown[]) => Interval)(...args))
  } else {
    out.refetchInterval = floor(ri as Interval)
  }
  return out
}

function retry(failureCount: number, error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) return false
  return failureCount < 1
}

export function createQueryClient(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry,
        refetchOnWindowFocus: false,
      },
    },
  })
  // Every observer defaults its options through here, so this is the one
  // place a per-query `refetchInterval` can be held to the policy.
  const base = qc.defaultQueryOptions.bind(qc)
  qc.defaultQueryOptions = ((options: Parameters<typeof base>[0]) => {
    const o = base(options)
    // Observers re-default on every render; apply once.
    if ((o as { _polled?: boolean })._polled) return o
    return Object.assign(applyPollPolicy(o), { _polled: true })
  }) as QueryClient['defaultQueryOptions']
  return qc
}
