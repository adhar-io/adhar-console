import { useToolPublicUrl } from '@adhar/shell-ui'
import type { metabase } from '@adhar/api-clients'
import {
  colKind,
  pickColumns,
  type Slice,
  toChartModel,
  toNumber,
  toPivot,
  toScalar,
  toSlices,
  toSmartScalar,
} from '../data/bi-chart.ts'
import { datasetError } from '../data/bi-sql.ts'
import { useMbProperties } from '../data/bi.ts'
import { InlineError } from '../views/bi-states.tsx'
import { FunnelBars, GaugeView, MapPlaceholder, ProgressView, ScalarView, ShareBars, XYChart, type XYKind } from './bi-charts.tsx'
import { DataGrid, MiniTable, ObjectDetail, PivotTable } from './bi-table.tsx'

/**
 * One visualisation of one dataset, by Metabase `display` type. This is the
 * single place display types map to marks; dashboards, the question viewer
 * and the SQL editor all render through it.
 */

export const XY_DISPLAYS = new Set(['line', 'area', 'bar', 'row', 'combo', 'waterfall', 'scatter'])

export function Visualization({
  display,
  dataset,
  settings,
  height,
  dense,
  metabaseHref,
}: {
  display: string
  dataset: metabase.MbDataset
  settings?: Record<string, unknown>
  height: number
  /** Dashboard-card density (compact table, no pagination). */
  dense?: boolean
  metabaseHref?: string
}) {
  const err = datasetError(dataset)
  if (err) return <InlineError message={err} />
  const cols = dataset.data?.cols ?? []
  const rows = dataset.data?.rows ?? []
  if (display === 'map') return <MapPlaceholder href={metabaseHref} />
  if (!rows.length) {
    return <div className="flex h-full items-center justify-center text-[12px] text-content-subtle">No results</div>
  }
  const s = settings ?? {}

  switch (display) {
    case 'scalar':
      return <ScalarView model={toScalar(dataset, s)} height={height} prefix={str(s['scalar.prefix'])} suffix={str(s['scalar.suffix'])} />
    case 'smartscalar':
      return <ScalarView model={toSmartScalar(dataset)} height={height} />
    case 'progress': {
      const v = toScalar(dataset, s)
      return <ProgressView value={typeof v.value === 'number' ? v.value : null} goal={num(s['progress.goal'])} col={v.col} />
    }
    case 'gauge': {
      const v = toScalar(dataset, s)
      const segs = Array.isArray(s['gauge.segments']) ? (s['gauge.segments'] as Array<{ min: number; max: number; label?: string }>) : undefined
      return <GaugeView value={typeof v.value === 'number' ? v.value : null} segments={segs?.map(({ min, max, label }) => ({ min, max, label }))} col={v.col} />
    }
    case 'pie': {
      const slices = toSlices(cols, rows, s)
      if ('error' in slices) return <Fallback cols={cols} rows={rows} note={slices.error} />
      const { metrics } = pickColumns(cols, rows)
      return <ShareBars slices={slices} col={cols[metrics[0]]} height={height} />
    }
    case 'funnel': {
      const steps = funnelSteps(cols, rows, s)
      if (!steps.length) return <Fallback cols={cols} rows={rows} note="A funnel needs a step column and a number column." />
      const { metrics } = pickColumns(cols, rows)
      return <FunnelBars slices={steps} col={cols[metrics[0]]} />
    }
    case 'pivot': {
      const p = toPivot(cols, rows)
      if ('error' in p) return <Fallback cols={cols} rows={rows} note={p.error} />
      const mi = cols.findIndex((c, i) => colKind(c, rows, i) === 'number')
      return <PivotTable model={p} col={cols[mi]} />
    }
    case 'object':
      return <ObjectDetail cols={cols} row={rows[0]} />
    case 'table':
      return dense ? <MiniTable cols={cols} rows={rows} /> : <DataGrid cols={cols} rows={rows} height={height} pageSize={rows.length > 100 ? 50 : undefined} />
  }

  if (XY_DISPLAYS.has(display)) {
    const model = toChartModel(cols, rows, s)
    if ('error' in model) return <Fallback cols={cols} rows={rows} note={model.error} />
    const { metrics } = pickColumns(cols, rows, s)
    const kind: XYKind = display === 'waterfall' ? 'bar' : (display as XYKind)
    const goalOn = s['graph.show_goal'] === true && num(s['graph.goal_value']) != null
    const seriesSettings = (s.series_settings ?? {}) as Record<string, { display?: string }>
    return (
      <XYChart
        model={model}
        kind={kind}
        height={height}
        yCol={cols[metrics[0]]}
        stack={s['stackable.stack_type'] === 'stacked' || s['stackable.stack_type'] === 'normalized' ? (s['stackable.stack_type'] as 'stacked' | 'normalized') : null}
        seriesDisplay={Object.fromEntries(Object.entries(seriesSettings).map(([k, v]) => [k, v?.display ?? '']))}
        goal={goalOn ? { value: num(s['graph.goal_value'])!, label: str(s['graph.goal_label']) } : null}
      />
    )
  }
  return <Fallback cols={cols} rows={rows} note={`“${display}” charts aren’t drawn in the console yet — showing the data.`} />
}

function Fallback({ cols, rows, note }: { cols: metabase.MbColumn[]; rows: metabase.MbCell[][]; note: string }) {
  return (
    <div className="flex h-full flex-col gap-1">
      <div className="shrink-0 text-[11px] text-content-subtle">{note}</div>
      <div className="min-h-0 flex-1">
        <MiniTable cols={cols} rows={rows} />
      </div>
    </div>
  )
}

function funnelSteps(cols: metabase.MbColumn[], rows: metabase.MbCell[][], s: Record<string, unknown>): Slice[] {
  const { dims, metrics } = pickColumns(cols, rows, {
    'graph.dimensions': s['funnel.dimension'] ? [s['funnel.dimension']] : undefined,
    'graph.metrics': s['funnel.metric'] ? [s['funnel.metric']] : undefined,
  })
  if (!metrics.length) return []
  const di = dims[0]
  const out: Slice[] = []
  for (const r of rows) {
    const v = toNumber(r[metrics[0]])
    if (v == null) continue
    out.push({ label: di == null ? cols[metrics[0]].name : String(r[di] ?? '(empty)'), value: v, share: 0 })
  }
  return out
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/**
 * Browser URL of Metabase itself, for "Open in Metabase". Prefers the
 * console's configured public URL, then Metabase's own `site-url`.
 */
export function useMetabaseUrl(): string {
  const tool = useToolPublicUrl('metabase')
  const props = useMbProperties()
  const site = typeof props.data?.['site-url'] === 'string' ? (props.data['site-url'] as string) : ''
  return (tool || site || '').replace(/\/$/, '')
}

export function mbLink(base: string, kind: 'dashboard' | 'question' | 'model' | 'metric' | 'browse-db' | 'admin-db' | 'collection', id?: number | string): string {
  if (!base) return ''
  switch (kind) {
    case 'dashboard':
      return `${base}/dashboard/${id}`
    case 'question':
      return `${base}/question/${id}`
    case 'model':
      return `${base}/model/${id}`
    case 'metric':
      return `${base}/metric/${id}`
    case 'browse-db':
      return `${base}/browse/databases/${id}`
    case 'admin-db':
      return `${base}/admin/databases/${id}`
    case 'collection':
      return `${base}/collection/${id}`
  }
}
