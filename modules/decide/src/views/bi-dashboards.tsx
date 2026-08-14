import { useEffect, useState } from 'react'
import {
  AreaChart,
  BarChart,
  Card,
  CardBody,
  CardHeader,
  DonutGauge,
  EmptyState,
  Sparkline,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import type { metabase } from '@adhar-console/api-clients'
import { useDashboard, useDashboards } from '../data/bi.ts'

/**
 * BI Dashboards. Sidebar lists every Metabase dashboard, the right pane
 * renders the active one as a 12-column grid of question cards using
 * the right chart primitive per `display` type.
 */
export function Dashboards() {
  const list = useDashboards()
  const [activeId, setActiveId] = useState<number | null>(null)

  useEffect(() => {
    if (!activeId && list.data?.length) setActiveId(list.data[0].id)
  }, [list.data, activeId])

  if (list.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading dashboards…
      </div>
    )
  }
  const all = list.data ?? []
  if (all.length === 0) {
    return <EmptyState title="No dashboards" description="Create one in Metabase to populate this list." />
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-content">Dashboards</div>
            <StatusBadge kind="info">{all.length}</StatusBadge>
          </div>
        </CardHeader>
        <CardBody className="p-0!">
          <ul className="max-h-[70vh] divide-y divide-edge-subtle overflow-y-auto">
            {all.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => setActiveId(d.id)}
                  className={
                    activeId === d.id
                      ? 'block w-full bg-brand-50 px-4 py-3 text-left'
                      : 'block w-full px-4 py-3 text-left transition-colors hover:bg-surface-sunken'
                  }
                >
                  <div className="text-sm font-semibold text-content">{d.name}</div>
                  {d.description ? (
                    <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-content-muted">
                      {d.description}
                    </div>
                  ) : null}
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-content-subtle">
                    <span>{d.cards.length} cards</span>
                    <span>· {d.view_count ?? 0} views</span>
                    {d.updated_at ? <span>· {formatRelative(d.updated_at)}</span> : null}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      {activeId ? <DashboardCanvas id={activeId} /> : null}
    </div>
  )
}

function DashboardCanvas({ id }: { id: number }) {
  const q = useDashboard(id)
  if (q.isLoading) {
    return (
      <Card>
        <CardBody className="flex h-64 items-center justify-center">
          <Spinner size={14} />
        </CardBody>
      </Card>
    )
  }
  if (!q.data) {
    return <EmptyState title="Dashboard not found" />
  }
  const { dashboard, cards } = q.data
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-content">{dashboard.name}</div>
            {dashboard.description ? (
              <div className="text-[11px] text-content-subtle">{dashboard.description}</div>
            ) : null}
          </div>
          <span className="text-[11px] text-content-muted">
            {dashboard.view_count ?? 0} views
            {dashboard.updated_at ? ` · refreshed ${formatRelative(dashboard.updated_at)}` : ''}
          </span>
        </div>
      </CardHeader>
      <CardBody>
        <div className="grid grid-cols-12 gap-3">
          {dashboard.cards.map((dc) => {
            const card = cards.find((c) => c.id === dc.card_id)
            if (!card) return null
            return (
              <div
                key={dc.id}
                className={spanClasses(dc.size_x)}
              >
                <CardRender card={card} />
              </div>
            )
          })}
        </div>
      </CardBody>
    </Card>
  )
}

function spanClasses(sizeX: number): string {
  // Map 12-col Metabase sizes to a responsive Tailwind layout.
  const lg = Math.max(2, Math.min(12, sizeX))
  const sm = lg <= 4 ? 6 : 12
  return `col-span-12 sm:col-span-${sm} lg:col-span-${lg}`
}

/* ─────────── card render ─────────── */

export function CardRender({ card }: { card: metabase.Question }) {
  return (
    <Card className="h-full">
      <CardHeader className="py-3!">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-content">{card.name}</div>
            {card.description ? (
              <div className="truncate text-[10px] text-content-subtle">{card.description}</div>
            ) : null}
          </div>
          <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-content-muted">
            {card.display}
          </span>
        </div>
      </CardHeader>
      <CardBody className="p-3!">
        <ChartFor card={card} />
      </CardBody>
    </Card>
  )
}

function ChartFor({ card }: { card: metabase.Question }) {
  switch (card.display) {
    case 'scalar':
      return <ScalarChart card={card} />
    case 'progress':
      return <ProgressChart card={card} />
    case 'gauge':
      return <GaugeChart card={card} />
    case 'line':
    case 'area':
      return <LineChart card={card} />
    case 'bar':
      return <BarChartView card={card} />
    case 'pie':
      return <PieChart card={card} />
    case 'table':
      return <TableChart card={card} />
  }
}

function ScalarChart({ card }: { card: metabase.Question }) {
  const v = card.scalar ?? 0
  const formatted = formatScalar(v, card.scalar_unit)
  const delta = card.scalar_delta
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums tracking-tight text-content">
          {formatted}
        </span>
        {delta != null ? (
          <span
            className={`font-mono text-[12px] tabular-nums ${
              delta >= 0 ? 'text-emerald-700' : 'text-rose-700'
            }`}
          >
            {delta >= 0 ? '+' : ''}
            {(delta * 100).toFixed(1)}%
          </span>
        ) : null}
      </div>
      {card.result?.rows && card.result.rows.length > 1 ? (
        <Sparkline
          points={card.result.rows.map((r) => Number(r[1] ?? 0))}
          color="var(--color-brand-500)"
          height={32}
          strokeWidth={1.75}
        />
      ) : null}
    </div>
  )
}

function ProgressChart({ card }: { card: metabase.Question }) {
  const v = (card.scalar ?? 0) * (card.scalar_unit === '%' ? 100 : 1)
  const goal = 100
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-2xl font-semibold tabular-nums text-content">
          {(card.scalar ?? 0) > 1 ? v.toFixed(0) : (v).toFixed(0)}%
        </span>
        <span className="text-[10px] text-content-muted">goal {goal}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
        <div
          className="h-full bg-linear-to-r from-brand-500 to-brand-400"
          style={{ width: `${Math.min(100, v)}%` }}
        />
      </div>
    </div>
  )
}

function GaugeChart({ card }: { card: metabase.Question }) {
  const v = (card.scalar ?? 0) * 100
  const tone = v >= 100 ? 'var(--color-emerald-500)' : v >= 80 ? 'var(--color-amber-500)' : 'var(--color-rose-500)'
  return (
    <div className="flex items-center justify-center">
      <DonutGauge
        value={v}
        max={150}
        size={140}
        thickness={14}
        color={tone}
        label={
          <div className="text-center">
            <div className="text-xl font-semibold tabular-nums text-content">{v.toFixed(1)}</div>
            <div className="text-[10px] uppercase tracking-wider text-content-subtle">
              {card.scalar_unit ?? ''}
            </div>
          </div>
        }
      />
    </div>
  )
}

function LineChart({ card }: { card: metabase.Question }) {
  if (!card.result?.rows.length) {
    return <EmptyState compact title="No data" />
  }
  const points = card.result.rows.map((r) => ({ v: Number(r[1] ?? 0), label: String(r[0]) }))
  const isArea = card.display === 'area'
  return (
    <AreaChart
      points={points}
      color={isArea ? 'var(--color-brand-500)' : 'var(--color-brand-500)'}
      height={150}
      showAxis
    />
  )
}

function BarChartView({ card }: { card: metabase.Question }) {
  if (!card.result?.rows.length) {
    return <EmptyState compact title="No data" />
  }
  return (
    <BarChart
      bars={card.result.rows.map((r, i) => ({
        label: String(r[0]),
        value: Number(r[1] ?? 0),
        color: i === 0 ? 'var(--color-brand-500)' : 'var(--color-brand-400)',
      }))}
      height={Math.min(card.result.rows.length * 26 + 16, 280)}
    />
  )
}

function PieChart({ card }: { card: metabase.Question }) {
  if (!card.result?.rows.length) {
    return <EmptyState compact title="No data" />
  }
  const rows = card.result.rows
  const total = rows.reduce((acc, r) => acc + Number(r[1] ?? 0), 0) || 1
  const colors = ['var(--color-brand-500)', 'var(--color-emerald-500)', 'var(--color-amber-500)', 'var(--color-violet-500)', 'var(--color-rose-500)']

  // Render as concentric slices using stacked bar (simpler than SVG donut).
  return (
    <div className="space-y-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-edge-subtle">
        {rows.map((r, i) => (
          <div
            key={i}
            className="h-full"
            style={{ width: `${(Number(r[1] ?? 0) / total) * 100}%`, backgroundColor: colors[i % colors.length] }}
          />
        ))}
      </div>
      <ul className="space-y-1 text-[11px]">
        {rows.map((r, i) => {
          const v = Number(r[1] ?? 0)
          return (
            <li key={i} className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: colors[i % colors.length] }} />
                {String(r[0])}
              </span>
              <span className="font-mono tabular-nums text-content-muted">
                {v.toLocaleString()} <span className="opacity-60">({((v / total) * 100).toFixed(0)}%)</span>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function TableChart({ card }: { card: metabase.Question }) {
  if (!card.result?.rows.length) {
    return <EmptyState compact title="No rows" />
  }
  const cols = card.result.cols
  const rows = card.result.rows
  return (
    <div className="overflow-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b border-edge-default">
            {cols.map((c) => (
              <th key={c.name} className="px-2 py-1 text-left font-semibold text-content-subtle">
                {c.display_name ?? c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-edge-subtle last:border-0">
              {r.map((cell, j) => (
                <td key={j} className="px-2 py-1 font-mono text-content">
                  {cell == null ? '—' : String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function formatScalar(v: number, unit?: string): string {
  if (unit === 'USD') {
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
    if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
    return `$${v.toFixed(0)}`
  }
  if (unit === '%') return `${(v * 100).toFixed(1)}%`
  if (unit === '×') return `${v.toFixed(2)}×`
  if (unit === 'min') return `${v.toFixed(0)} min`
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M ${unit ?? ''}`.trim()
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K ${unit ?? ''}`.trim()
  return `${v.toFixed(0)} ${unit ?? ''}`.trim()
}
