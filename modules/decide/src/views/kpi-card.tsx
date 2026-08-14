import { Sparkline, type SeriesPoint } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'

interface Props {
  label: string
  value: string
  delta?: string
  trend?: 'up' | 'down' | 'flat'
  accent?: 'emerald' | 'amber' | 'rose' | 'slate' | 'indigo'
  /** Optional tiny trendline that sits behind the value for visual weight. */
  series?: SeriesPoint[]
}

const ACCENT: Record<NonNullable<Props['accent']>, { text: string; color: string; bg: string }> = {
  emerald: {
    text: 'text-emerald-700',
    color: 'var(--color-emerald-500,#10b981)',
    bg: 'bg-emerald-50',
  },
  amber: {
    text: 'text-amber-700',
    color: '#f59e0b',
    bg: 'bg-amber-50',
  },
  rose: {
    text: 'text-rose-700',
    color: '#f43f5e',
    bg: 'bg-rose-50',
  },
  slate: {
    text: 'text-content-muted',
    color: 'var(--color-brand-400)',
    bg: 'bg-surface-sunken',
  },
  indigo: {
    text: 'text-indigo-700',
    color: '#6366f1',
    bg: 'bg-indigo-50',
  },
}

export function KpiCard({ label, value, delta, trend, accent = 'slate', series }: Props) {
  const a = ACCENT[accent]
  return (
    <div className="group relative overflow-hidden rounded-xl border border-edge-default bg-surface-raised p-5 shadow-sm transition-all duration-150 ease-smooth hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-md">
      <div className="relative z-10">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
            {label}
          </div>
          {delta ? (
            <div
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                a.bg,
                a.text,
              )}
            >
              <TrendGlyph trend={trend} />
              {delta}
            </div>
          ) : null}
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <div className="text-3xl font-semibold tabular-nums tracking-tight text-content">
            {value}
          </div>
        </div>
      </div>
      {series && series.length > 1 ? (
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-16 opacity-60">
          <Sparkline points={series} color={a.color} height={64} strokeWidth={1.25} />
        </div>
      ) : null}
    </div>
  )
}

function TrendGlyph({ trend }: { trend?: Props['trend'] }) {
  const size = 10
  if (trend === 'up') {
    return (
      <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden>
        <path d="M2 9 l4-4 2 2 2-2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8 5 l2 0 0 2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (trend === 'down') {
    return (
      <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden>
        <path d="M2 3 l4 4 2-2 2 2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8 7 l2 0 0-2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden>
      <path d="M2 6 h8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
