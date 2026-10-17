interface Point {
  t: number
  v: number
}

interface Props {
  points: Point[]
  width?: number
  height?: number
  /** Stroke colour; defaults to the first categorical series slot. */
  color?: string
  label?: string
}

/**
 * Tiny inline sparkline over `{t, v}` points, x positioned by time (so gaps in
 * collection show as compressed spans rather than being spread evenly).
 * Theme-aware: stroke and the "no data" text use tokens, not fixed hex.
 */
export function Sparkline({ points, width = 280, height = 48, color = 'var(--viz-1, var(--color-brand-500))', label = 'trend' }: Props) {
  const pts = points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
  if (pts.length < 2) {
    return (
      <svg width={width} height={height} role="img" aria-label="No data">
        <text x={width / 2} y={height / 2 + 3} textAnchor="middle" fontSize="10" fill="var(--color-content-subtle)">
          no data
        </text>
      </svg>
    )
  }
  const t0 = pts[0].t
  const t1 = pts[pts.length - 1].t
  const min = Math.min(...pts.map((p) => p.v))
  const max = Math.max(...pts.map((p) => p.v))
  const range = max - min || 1
  const span = t1 - t0 || 1
  const pad = 1.5
  const d = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(((p.t - t0) / span) * (width - pad * 2) + pad).toFixed(1)},${(height - pad - ((p.v - min) / range) * (height - pad * 2)).toFixed(1)}`)
    .join(' ')
  return (
    <svg width={width} height={height} role="img" aria-label={label}>
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
