import { assertEquals } from 'jsr:@std/assert@1'
import { AnalyticsError, analyticsProblem } from './analytics.ts'

Deno.test('analyticsProblem — a BFF connect failure is "not reachable", not "starting up"', () => {
  assertEquals(analyticsProblem(new AnalyticsError(502, 'x', 'upstream_unreachable')), 'PostHog is not reachable from the console.')
  assertEquals(analyticsProblem(new AnalyticsError(503, 'x', 'tool_not_configured')), 'PostHog is not configured for the console.')
  assertEquals(analyticsProblem(new AnalyticsError(502, 'x')), 'PostHog is starting up — try again shortly.')
  assertEquals(analyticsProblem(new AnalyticsError(0, 'x')), 'PostHog is not reachable from the console.')
})
