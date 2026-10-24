/**
 * How often a sliding "last N" window is worth re-reading while visible.
 *
 * Re-running a 7-day Loki/Tempo query every minute moves its right edge by
 * 0.01% — the chart cannot change visibly, but the backend scans the whole
 * week again. So the cadence scales with the window (about 1/60th of it, so
 * the newest bucket of a 120-point chart turns over between reads) and never
 * goes below the console-wide poll floor.
 *
 *   5m / 15m / 1h → 1 min · 6h → 6 min · 24h → 24 min · 7d → 2 h 48 min
 */
export const MIN_REFRESH_MS = 60_000

export function windowRefreshMs(windowMs: number): number {
  if (!Number.isFinite(windowMs) || windowMs <= 0) return MIN_REFRESH_MS
  return Math.max(MIN_REFRESH_MS, Math.round(windowMs / 60))
}
