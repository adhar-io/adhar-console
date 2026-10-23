import { assert, assertEquals } from 'jsr:@std/assert@1'
import { applyPanelTime, computeStepMs, formatUnit, mapValue, reduce, roundInterval, type VarMap } from './grafana-board.ts'
import {
  type DataFrame,
  displayItems,
  displayValue,
  fieldColor,
  fieldDisplayName,
  framesFromQueries,
  interpolateLink,
  matchField,
  resolveFields,
  templateDisplayName,
} from './grafana-fields.ts'
import { applyTransformations, joinByField, merge, organize, sortBy } from './grafana-transforms.ts'
import { buildStateLane, buildStatusCells, insertNulls, timelineLegend } from './grafana-timeline.ts'
import { calculateHeatmap, heatmapFromBuckets, heatmapPalette, heatmapScale, histogram } from './grafana-heatmap.ts'
import { axisRange, axisTicks, linePath, seriesStyle, splitRuns, stackSeries } from './grafana-timeseries.ts'
import { filterAlertItems, normalizeRuleGroups, parseLabelFilter } from './grafana-lists.ts'
import { consoleBoardHref } from './grafana-links.ts'

const T0 = 1_760_000_000_000
const S = 60_000
const plain = (v: unknown) => ({ text: String(v ?? '—'), numeric: typeof v === 'number' ? v : null })

/* ─────────── grafana-board additions ─────────── */

Deno.test('value mappings: value, range, regex, special and legacy kinds', () => {
  const m = [
    { type: 'value', options: { '0': { text: 'open', color: 'red' } } },
    { type: 'range', options: { from: 10, to: 20, result: { text: 'mid' } } },
    { type: 'regex', options: { pattern: '/^pod-(\\d+)$/', result: { text: 'Pod $1' } } },
    { type: 'special', options: { match: 'null', result: { text: 'N/A', color: 'gray' } } },
  ]
  assertEquals(mapValue(0, m)?.text, 'open')
  assertEquals(mapValue(15, m)?.text, 'mid')
  assertEquals(mapValue('pod-7', m)?.text, 'Pod 7')
  assertEquals(mapValue(null, m)?.text, 'N/A')
  assertEquals(mapValue(5, m), null)
  assertEquals(mapValue(NaN, [{ type: 'special', options: { match: 'nan', result: { text: 'NaN!' } } }])?.text, 'NaN!')
  assertEquals(mapValue(1, [{ type: 1, value: '1', text: 'UP' }])?.text, 'UP')
  assertEquals(mapValue(3, [{ type: 2, from: '2', to: '4', text: 'two-four' }])?.text, 'two-four')
  // First match wins, open-ended ranges.
  assertEquals(mapValue(99, [{ type: 'range', options: { from: 50, to: null, result: { text: 'hi' } } }])?.text, 'hi')
})

Deno.test('units Grafana boards use: cores, currency, d/h, ISO dates, unknown suffix', () => {
  assertEquals(formatUnit(2.5, 'cores'), '2.5 cores')
  assertEquals(formatUnit(1234, 'currencyUSD'), '$1.23K')
  assertEquals(formatUnit(3, 'd'), '3 day')
  assertEquals(formatUnit(2, 'h'), '2 hour')
  assertEquals(formatUnit(12, 'short'), '12')
  assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(formatUnit(T0, 'dateTimeAsIso')))
})

Deno.test('Grafana interval rounding and step', () => {
  assertEquals(roundInterval(12_000), 10_000)
  assertEquals(roundInterval(21_600), 20_000)
  assertEquals(roundInterval(288_000), 300_000)
  // 6h over a 1000px panel → 21.6s → 20s (Grafana), floored at the 15s scrape.
  assertEquals(computeStepMs(6 * 3_600_000, 1000), 20_000)
  assertEquals(computeStepMs(6 * 3_600_000, 1000, 60_000), 60_000)
})

Deno.test('panel timeFrom / timeShift override the window', () => {
  const t = { start: T0 - 6 * 3_600_000, end: T0 }
  const a = applyPanelTime(t, '2h', undefined)
  assertEquals(a.start, T0 - 2 * 3_600_000)
  assertEquals(a.info, 'Last 2h')
  const b = applyPanelTime(t, undefined, '1d')
  assertEquals(b.end, T0 - 86_400_000)
  assertEquals(b.info, 'timeshift -1d')
  assertEquals(applyPanelTime(t).info, undefined)
})

Deno.test('reducers: last vs lastNotNull, counter-aware delta, percentiles', () => {
  assertEquals(reduce([1, 2, null], 'last'), null)
  assertEquals(reduce([1, 2, null], 'lastNotNull'), 2)
  assertEquals(reduce([10, 15, 3, 5], 'delta'), 5 + 3 + 2)
  assertEquals(reduce([10, 15, 3, 5], 'diff'), -5)
  assertEquals(reduce([1, 2, 3, 4], 'p50'), 2)
  assertEquals(reduce([1, 1, 2], 'distinctCount'), 2)
})

/* ─────────── frames & field config ─────────── */

const tsFrames = () =>
  framesFromQueries([
    {
      refId: 'A',
      legendFormat: '{{pod}}',
      stepMs: S,
      series: [
        { metric: { pod: 'web-1' }, values: [[T0 / 1000, '1'], [(T0 + S) / 1000, '2']] },
        { metric: { pod: 'web-2' }, values: [[T0 / 1000, '3']] },
      ],
    },
    { refId: 'B', legendFormat: 'limit', series: [{ metric: {}, values: [[T0 / 1000, '9']] }] },
  ])

Deno.test('time series become one frame per series with the legend as DS name', () => {
  const f = tsFrames()
  assertEquals(f.length, 3)
  assertEquals(f[0].fields.map((x) => x.name), ['Time', 'Value'])
  assertEquals(fieldDisplayName(f[0].fields[1], f[0]), 'web-1')
  assertEquals(f[0].fields[1].config.interval, S)
})

Deno.test('table format: one frame per query, label columns, Value #refId', () => {
  const f = framesFromQueries([
    { refId: 'A', table: true, series: [{ metric: { namespace: 'a', pod: 'p' }, value: [T0 / 1000, '5'] }] },
    { refId: 'B', table: true, series: [{ metric: { namespace: 'a' }, value: [T0 / 1000, '7'] }] },
  ])
  assertEquals(f[0].fields.map((x) => x.name), ['Time', 'namespace', 'pod', 'Value #A'])
  assertEquals(f[1].fields.map((x) => x.name), ['Time', 'namespace', 'Value #B'])
  const single = framesFromQueries([{ refId: 'A', table: true, series: [{ metric: { a: '1' }, value: [T0 / 1000, '1'] }] }])
  assertEquals(single[0].fields.at(-1)?.name, 'Value')
})

Deno.test('override matchers: byName, byRegexp, byFrameRefID, byType, byNames', () => {
  const f = tsFrames()
  const v = f[0].fields[1]
  assert(matchField({ id: 'byName', options: 'web-1' }, v, f[0], 'web-1'))
  assert(matchField({ id: 'byRegexp', options: '/web-.*/' }, v, f[0], 'web-1'))
  assert(matchField({ id: 'byRegexp', options: 'web-\\d' }, v, f[0], 'web-1'))
  assert(!matchField({ id: 'byRegexp', options: 'web' }, v, f[0], 'web-1'), 'plain patterns are anchored')
  assert(matchField({ id: 'byFrameRefID', options: 'A' }, v, f[0], 'web-1'))
  assert(matchField({ id: 'byType', options: 'number' }, v, f[0], 'web-1'))
  assert(matchField({ id: 'byNames', options: { mode: 'include', names: ['web-1'] } }, v, f[0], 'web-1'))
})

Deno.test('overrides apply over defaults: unit, color, custom paths, displayName template', () => {
  const r = resolveFields(tsFrames(), { unit: 'short', custom: { lineWidth: 2 } }, [
    { matcher: { id: 'byName', options: 'limit' }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: 'red' } }, { id: 'custom.lineStyle', value: { fill: 'dash', dash: [10, 10] } }] },
    { matcher: { id: 'byFrameRefID', options: 'A' }, properties: [{ id: 'unit', value: 'bytes' }, { id: 'displayName', value: 'Pod ${__field.labels.pod}' }] },
  ]).flatMap((x) => x.fields).filter((x) => x.type === 'number')
  assertEquals(r.map((x) => x.displayName), ['Pod web-1', 'Pod web-2', 'limit'])
  assertEquals(r[0].config.unit, 'bytes')
  assertEquals(r[2].config.unit, 'short')
  assertEquals(r[2].config.color?.fixedColor, 'red')
  assertEquals((r[2].config.custom as { lineStyle: { fill: string } }).lineStyle.fill, 'dash')
  assertEquals((r[2].config.custom as { lineWidth: number }).lineWidth, 2)
  assertEquals(r.map((x) => x.seriesIndex), [0, 1, 2])
})

Deno.test('display name templates use labels and board variables', () => {
  const f = tsFrames()
  const vars: VarMap = { namespace: { values: ['adhar-system'], options: ['adhar-system'] } }
  assertEquals(templateDisplayName('$namespace / ${__field.labels.pod}', f[0].fields[1], f[0], vars), 'adhar-system / web-1')
})

Deno.test('display values: mappings beat units; noValue for nulls; thresholds colour', () => {
  const cfg = {
    unit: 'percent',
    noValue: 'No data',
    thresholds: { steps: [{ color: 'green', value: null }, { color: 'red', value: 80 }] },
    mappings: [{ type: 'value', options: { '1': { text: 'Up', color: 'green' } } }],
  }
  assertEquals(displayValue(cfg, 1, '').text, 'Up')
  assertEquals(displayValue(cfg, 90, '').text, '90%')
  assertEquals(displayValue(cfg, 90, '').rawColor, 'red')
  assertEquals(displayValue(cfg, null, '').text, 'No data')
  assertEquals(fieldColor({ color: { mode: 'fixed', fixedColor: 'blue' } }, 1, 'x').raw, 'blue')
  assertEquals(fieldColor({ color: { mode: 'palette-classic' } }, 1, 'slot-3').color, 'slot-3')
  assert(fieldColor({ color: { mode: 'continuous-GrYlRd' }, min: 0, max: 100 }, 50, '').color?.startsWith('rgb('))
})

Deno.test('data links interpolate row fields, queryparam vars and time range', () => {
  const vars: VarMap = { datasource: { values: ['prom'], options: [] }, cluster: { values: ['c1'], options: [] } }
  const url = interpolateLink(
    '/d/abc?${datasource:queryparam}&var-cluster=$cluster&var-namespace=${__data.fields.Namespace}&${__url_time_range}',
    { Namespace: 'kube system' },
    vars,
    { __url_time_range: 'from=now-6h&to=now' },
  )
  assertEquals(url, '/d/abc?var-datasource=prom&var-cluster=c1&var-namespace=kube%20system&from=now-6h&to=now')
})

Deno.test('board links open in the console with vars and host params kept', () => {
  const href = consoleBoardHref('/d/abc/slug?var-ns=a&from=now-1h&to=now', '?section=dashboards&board=old', { from: 'now-6h', to: 'now' }, '/discover')
  assert(href?.startsWith('/discover?'))
  const qs = new URLSearchParams(href!.split('?')[1])
  assertEquals(qs.get('section'), 'dashboards')
  assertEquals(qs.get('board'), 'abc')
  assertEquals(qs.get('var-ns'), 'a')
  assertEquals(qs.get('from'), 'now-1h')
  assertEquals(consoleBoardHref('https://example.com/x', '', { from: 'a', to: 'b' }), null)
})

Deno.test('displayItems reduce each numeric field (or show rows)', () => {
  const r = resolveFields(tsFrames(), {}, [])
  const items = displayItems(r, { calcs: ['max'] }, 'lastNotNull', reduce)
  assertEquals(items.map((i) => [i.name, i.value]), [['web-1', 2], ['web-2', 3], ['limit', 9]])
  const t = resolveFields(framesFromQueries([{ refId: 'A', table: true, series: [{ metric: { pod: 'a' }, value: [1, '4'] }, { metric: { pod: 'b' }, value: [1, '6'] }] }]), {}, [])
  assertEquals(displayItems(t, { values: true }, 'lastNotNull', reduce).map((i) => [i.name, i.value]), [['a', 4], ['b', 6]])
})

/* ─────────── transformations ─────────── */

const tableFrames = (): DataFrame[] =>
  framesFromQueries([
    { refId: 'A', table: true, series: [{ metric: { namespace: 'a', workload_type: 'deployment' }, value: [1, '1'] }, { metric: { namespace: 'b', workload_type: 'sts' }, value: [1, '2'] }] },
    { refId: 'B', table: true, series: [{ metric: { namespace: 'a', workload_type: 'deployment' }, value: [1, '10'] }] },
  ])

Deno.test('joinByField (outer) suffixes duplicate names with the frame number', () => {
  const [j] = joinByField(tableFrames(), 'namespace', 'outer')
  assertEquals(j.fields.map((f) => f.name), ['namespace', 'Time 1', 'workload_type 1', 'Value #A', 'Time 2', 'workload_type 2', 'Value #B'])
  assertEquals(j.fields[0].values, ['a', 'b'])
  assertEquals(j.fields[6].values, [10, null])
  const [inner] = joinByField(tableFrames(), 'namespace', 'inner')
  assertEquals(inner.fields[0].values, ['a'])
})

Deno.test('organize excludes, orders and renames (rename sets the display name)', () => {
  const [j] = joinByField(tableFrames(), 'namespace')
  const o = organize(j, {
    excludeByName: { 'Time 1': true, 'Time 2': true, 'workload_type 2': true },
    indexByName: { 'Value #A': 0, namespace: 1 },
    renameByName: { 'Value #A': 'Pods', namespace: 'Namespace', 'workload_type 1': 'Type' },
  })
  assertEquals(o.fields.map((f) => fieldDisplayName(f, o)), ['Pods', 'Namespace', 'Type', 'Value #B'])
})

Deno.test('merge joins table frames on their common fields', () => {
  const [m] = merge(tableFrames())
  assertEquals(m.fields.map((f) => f.name), ['Time', 'namespace', 'workload_type', 'Value #A', 'Value #B'])
  assertEquals(m.fields[1].values, ['a', 'b'])
  assertEquals(m.fields[3].values, [1, 2])
  assertEquals(m.fields[4].values, [10, null])
})

Deno.test('general transformations: reduce, filter, calculateField, sortBy, limit, groupBy, labelsToFields', () => {
  const ts = tsFrames()
  const red = applyTransformations(ts, [{ id: 'reduce', options: { reducers: ['max', 'lastNotNull'] } }]).frames[0]
  assertEquals(red.fields.map((f) => f.name), ['Field', 'Max', 'Last *'])
  assertEquals(red.fields[0].values, ['web-1', 'web-2', 'limit'])
  const [m] = merge(tableFrames())
  const filtered = applyTransformations([m], [{ id: 'filterFieldsByName', options: { include: { names: ['namespace', 'Value #A'] } } }]).frames[0]
  assertEquals(filtered.fields.map((f) => f.name), ['namespace', 'Value #A'])
  const calc = applyTransformations([m], [{ id: 'calculateField', options: { mode: 'binary', binary: { left: 'Value #B', operator: '/', right: 'Value #A' }, alias: 'ratio' } }]).frames[0]
  assertEquals(calc.fields.at(-1)?.values, [10, null])
  const sorted = sortBy(m, [{ field: 'Value #A', desc: true }])
  assertEquals(sorted.fields[1].values, ['b', 'a'])
  assertEquals(applyTransformations([m], [{ id: 'limit', options: { limitField: 1 } }]).frames[0].fields[1].values, ['a'])
  const g = applyTransformations([m], [{ id: 'groupBy', options: { fields: { workload_type: { operation: 'groupby' }, 'Value #A': { operation: 'aggregate', aggregations: ['sum'] } } } }]).frames[0]
  assertEquals(g.fields.map((f) => f.name), ['workload_type', 'Value #A (sum)'])
  const l2f = applyTransformations([tsFrames()[0]], [{ id: 'labelsToFields', options: {} }]).frames[0]
  assertEquals(l2f.fields.map((f) => f.name), ['Time', 'pod', 'Value'])
  const unknown = applyTransformations(ts, [{ id: 'prepareTimeSeries' }, { id: 'merge', disabled: true }])
  assertEquals(unknown.skipped, ['prepareTimeSeries'])
})

/* ─────────── state timeline / status history ─────────── */

const disp = (v: unknown) => ({ ...plain(v), color: v === 1 ? 'green' : 'red' })

Deno.test('state lanes merge equal neighbours and run to the range end', () => {
  const times = [T0, T0 + S, T0 + 2 * S, T0 + 3 * S]
  const segs = buildStateLane(times, [1, 1, 0, 0], { rangeStart: T0, rangeEnd: T0 + 4 * S, mergeValues: true, stepMs: S, display: disp })
  assertEquals(segs.map((s) => [s.text, s.start - T0, s.end - T0]), [['1', 0, 2 * S], ['0', 2 * S, 4 * S]])
  const unmerged = buildStateLane(times, [1, 1, 0, 0], { rangeStart: T0, rangeEnd: T0 + 4 * S, mergeValues: false, stepMs: S, display: disp })
  assertEquals(unmerged.length, 4)
})

Deno.test('a gap longer than the step ends the state unless spanNulls carries it', () => {
  const times = [T0, T0 + S, T0 + 5 * S, T0 + 6 * S]
  const base = { rangeStart: T0, rangeEnd: T0 + 7 * S, stepMs: S, display: disp }
  const gap = buildStateLane(times, [1, 1, 1, 1], base)
  assertEquals(gap.map((s) => [s.start - T0, s.end - T0]), [[0, 2 * S], [5 * S, 7 * S]])
  const spanned = buildStateLane(times, [1, 1, 1, 1], { ...base, spanNulls: true })
  assertEquals(spanned.map((s) => [s.start - T0, s.end - T0]), [[0, 7 * S]])
  const short = buildStateLane(times, [1, 1, 1, 1], { ...base, spanNulls: 2 * S })
  assertEquals(short.length, 2, 'a 4-step gap is not bridged by a 2-step spanNulls')
  const off = buildStateLane(times, [1, 1, 1, 1], { ...base, insertNulls: false })
  assertEquals(off.length, 1, 'insertNulls: false never breaks')
  // Data that stops early ends one step after the last sample.
  const early = buildStateLane([T0, T0 + S], [0, 0], { rangeStart: T0, rangeEnd: T0 + 10 * S, stepMs: S, display: disp })
  assertEquals(early.map((s) => s.end - T0), [2 * S])
})

Deno.test('explicit nulls and instant samples', () => {
  const segs = buildStateLane([T0, T0 + S, T0 + 2 * S], [1, null, 0], { rangeStart: T0, rangeEnd: T0 + 3 * S, stepMs: S, display: disp })
  assertEquals(segs.map((s) => s.text), ['1', '0'])
  const inst = buildStateLane([T0 + 3 * S], [1], { rangeStart: T0, rangeEnd: T0 + 3 * S, display: disp })
  assertEquals(inst.map((s) => [s.start, s.end]), [[T0, T0 + 3 * S]])
  assertEquals(insertNulls([0, 10, 50], [1, 1, 1], 10, 50).values, [1, 1, null, 1])
})

Deno.test('status history: a cell per sample', () => {
  const cells = buildStatusCells([T0, T0 + S, T0 + 2 * S], [1, null, 0], { rangeStart: T0, rangeEnd: T0 + 3 * S, stepMs: S, display: disp })
  assertEquals(cells.map((c) => [c.text, c.start - T0, c.end - T0]), [['1', 0, S], ['0', 2 * S, 3 * S]])
})

Deno.test('timeline legend: threshold steps, else distinct states', () => {
  const fmt = (v: number) => String(v)
  const id = (c: string) => c
  assertEquals(
    timelineLegend({ color: { mode: 'thresholds' }, thresholds: { steps: [{ color: 'red', value: null }, { color: 'green', value: 1 }] } }, [], fmt, id),
    [{ label: '< 1', color: 'red' }, { label: '1+', color: 'green' }],
  )
  const lanes = [[{ start: 0, end: 1, value: 1, text: 'closed', color: 'g' }, { start: 1, end: 2, value: 0, text: 'open', color: 'r' }], [{ start: 0, end: 1, value: 1, text: 'closed', color: 'g' }]]
  assertEquals(timelineLegend({ color: { mode: 'thresholds' }, thresholds: { steps: [{ color: 'green', value: null }] } }, lanes, fmt, id).map((l) => l.label), ['closed', 'open'])
})

/* ─────────── heatmap / histogram ─────────── */

Deno.test('Prometheus buckets are sorted by le and de-accumulated', () => {
  const b = (le: string, vals: number[]) => ({ metric: { le }, values: vals.map((v, i) => [(T0 + i * S) / 1000, String(v)] as [number, string]) })
  const h = heatmapFromBuckets([b('+Inf', [10, 12]), b('0.5', [6, 6]), b('0.1', [2, 3])])!
  assertEquals(h.buckets.map((x) => x.hi), [0.1, 0.5, Infinity])
  assertEquals(h.counts, [[2, 3], [4, 3], [4, 6]])
  assertEquals(h.max, 6)
  assertEquals(h.xStep, S)
  assertEquals(heatmapFromBuckets([{ metric: { pod: 'x' }, values: [] }]), null)
})

Deno.test('calculated heatmap buckets raw samples per column', () => {
  const h = calculateHeatmap([[[T0, 1], [T0 + S, 9]], [[T0, 2]]], { yBuckets: 4 })!
  assertEquals(h.counts.flat().reduce((a: number, b) => a + (b ?? 0), 0), 3)
  assertEquals(h.xs.length, 2)
  const log = calculateHeatmap([[[T0, 1], [T0, 100]]], { yScale: 'log', logBase: 10 })!
  assertEquals(log.buckets[0].lo, 1)
})

Deno.test('heatmap palette inverts Spectral (red = high) and scales exponentially', () => {
  const p = heatmapPalette({ scheme: 'Spectral', steps: 8 })
  assertEquals(p.length, 8)
  assertEquals(p[7], 'rgb(158, 1, 66)')
  assertEquals(heatmapScale(25, 0, 100, { scale: 'exponential', exponent: 0.5 }), 0.5)
  assertEquals(heatmapScale(25, 0, 100, {}), 0.25)
})

Deno.test('histogram buckets values', () => {
  const bars = histogram([1, 2, 2, 3, 10], { bucketSize: 5 })
  assertEquals(bars.map((b) => [b.lo, b.count]), [[0, 4], [5, 0], [10, 1]])
})

/* ─────────── time series maths ─────────── */

Deno.test('series style reads field config with Grafana defaults', () => {
  const s = seriesStyle({ custom: { drawStyle: 'bars', fillOpacity: 70, stacking: { mode: 'normal', group: 'A' }, lineStyle: { fill: 'dash', dash: [10, 10] }, transform: 'negative-Y', hideFrom: { tooltip: true } } })
  assertEquals([s.drawStyle, s.fillOpacity, s.stackMode, s.negativeY, s.hideTooltip], ['bars', 70, 'normal', true, true])
  assertEquals(s.dash, [10, 10])
  assertEquals(seriesStyle({}).lineInterpolation, 'linear')
})

Deno.test('runs break at gaps unless spanned; insertNulls false always connects', () => {
  const pts: Array<[number, number | null]> = [[0, 1], [60, 1], [300, 1], [360, 1]]
  assertEquals(splitRuns(pts, false, 60).length, 2)
  assertEquals(splitRuns(pts, true, 60).length, 1)
  assertEquals(splitRuns(pts, 300, 60).length, 1)
  assertEquals(splitRuns(pts, 120, 60).length, 2)
  assertEquals(splitRuns(pts, false, false).length, 1)
  assertEquals(splitRuns([[0, 1], [60, null], [120, 1]], false, false).length, 2)
})

Deno.test('stacking accumulates per group; percent normalises; negative-Y stacks apart', () => {
  const st = (mode: string, extra: Record<string, unknown> = {}) => seriesStyle({ custom: { stacking: { mode, group: 'A' }, ...extra } })
  const out = stackSeries([
    { points: [[0, 1], [1, 2]], style: st('normal') },
    { points: [[0, 3], [1, 2]], style: st('normal') },
    { points: [[0, 5]], style: st('none') },
    { points: [[0, 4]], style: st('normal', { transform: 'negative-Y' }) },
  ])
  assertEquals(out[1], [[0, 1, 4], [1, 2, 4]])
  assertEquals(out[2], [[0, 0, 5]])
  assertEquals(out[3], [[0, 0, -4]])
  const pct = stackSeries([{ points: [[0, 1]], style: st('percent') }, { points: [[0, 3]], style: st('percent') }])
  assertEquals(pct[1], [[0, 0.25, 1]])
})

Deno.test('axis range pads and clamps at zero; ticks are tidy', () => {
  assertEquals(axisRange([2, 10], {}), { min: 0, max: 12 })
  const r = axisRange([150, 160], {})
  assert(r.min > 0 && r.min <= 149 && r.max >= 161)
  assertEquals(axisRange([1, 2], { min: 0, max: 100 }), { min: 0, max: 100 })
  assertEquals(axisTicks(0, 10, 5), [0, 2, 4, 6, 8, 10])
  assertEquals(axisTicks(1, 1000, 5, 10), [1, 10, 100, 1000])
  assert(linePath([[0, 0], [10, 5], [20, 0]], 'smooth').includes('C'))
  assertEquals(linePath([[0, 0], [10, 5]], 'stepAfter'), 'M0.0,0.0H10.0V5.0')
})

/* ─────────── alert list ─────────── */

Deno.test('alert list: normalise, filter by state / name / dashboard / labels, sort, cap', () => {
  const items = [
    ...normalizeRuleGroups([{
      name: 'g',
      file: 'Platform',
      rules: [
        { name: 'B high latency', state: 'firing', labels: { severity: 'critical' }, annotations: { __dashboardUid__: 'd1' }, alerts: [{ labels: {}, state: 'Alerting', activeAt: '2026-10-23T10:00:00Z' }] },
        { name: 'A disk', state: 'pending', labels: { severity: 'warning' }, alerts: [{ labels: {}, state: 'Pending', activeAt: '2026-10-23T11:00:00Z' }] },
        { name: 'C ok', state: 'inactive' },
        { name: 'D nodata', state: 'inactive', health: 'nodata' },
        { name: 'rec', type: 'recording' },
      ],
    }], 'Grafana'),
  ]
  assertEquals(items.map((i) => i.state), ['firing', 'pending', 'normal', 'nodata'])
  assertEquals(filterAlertItems(items, {}).map((i) => i.name), ['A disk', 'B high latency'])
  assertEquals(filterAlertItems(items, { stateFilter: { normal: true, noData: true } }).map((i) => i.name), ['C ok', 'D nodata'])
  assertEquals(filterAlertItems(items, { onlyAlertsOnDashboard: true }, 'd1').map((i) => i.name), ['B high latency'])
  assertEquals(filterAlertItems(items, { alertInstanceLabelFilter: '{severity="warning"}' }).map((i) => i.name), ['A disk'])
  assertEquals(filterAlertItems(items, { sortOrder: 5 }).map((i) => i.name), ['A disk', 'B high latency'])
  assertEquals(filterAlertItems(items, { sortOrder: 3 }).map((i) => i.name), ['B high latency', 'A disk'])
  assertEquals(filterAlertItems(items, { maxItems: 1 }).length, 1)
  assertEquals(filterAlertItems(items, { stateFilter: ['alerting'] }).map((i) => i.name), ['B high latency'])
  assertEquals(parseLabelFilter('{a="b", c=~"d.*"}'), [{ name: 'a', op: '=', value: 'b' }, { name: 'c', op: '=~', value: 'd.*' }])
})
