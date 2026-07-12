interface Point {
  t: number
  v: number
}

interface Props {
  points: Point[]
  width?: number
  height?: number
}

/**
 * Tiny inline sparkline — avoids pulling in a charting lib for v1.
 * Swap for Recharts or a Grafana scene panel when/if density increases.
 */
export function Sparkline({ points, width = 280, height = 48 }: Props) {
  if (points.length < 2) {
    return (
      <svg width={width} height={height} role="img" aria-label="No data">
        <text x={width / 2} y={height / 2} textAnchor="middle" fontSize="11" fill="#94a3b8">
          no data
        </text>
      </svg>
    )
  }
  const min = Math.min(...points.map((p) => p.v))
  const max = Math.max(...points.map((p) => p.v))
  const range = max - min || 1
  const step = width / (points.length - 1)
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${i * step} ${height - ((p.v - min) / range) * height}`)
    .join(' ')
  return (
    <svg width={width} height={height} role="img" aria-label="time series">
      <path d={d} fill="none" stroke="#0f172a" strokeWidth={1.5} />
    </svg>
  )
}
