import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  buildParameterValues,
  buildTemplateTags,
  encodeFilterValue,
  filterReach,
  missingRequired,
  parametersForDashcard,
  parseSqlVariables,
} from './bi-params.ts'
import {
  autoDisplay,
  colKind,
  columnStats,
  foldSeries,
  formatCompact,
  formatTime,
  niceScale,
  sortRowIndexes,
  toChartModel,
  toPivot,
  toScalar,
  toSlices,
  toSmartScalar,
  vizSupported,
  wallTime,
} from './bi-chart.ts'
import { describeSchedule, fromChannel, nextRun, toChannelSchedule } from './bi-schedule.ts'
import { gridColumns, gridMode, layout } from './bi-grid.ts'
import { datasetError, errorPosition, formatSql, loadHistory, pushHistory, saveHistory, toCsv, toJson } from './bi-sql.ts'

/* ───────────── parameters ───────────── */

Deno.test('parseSqlVariables finds variables, optional clauses, snippets and card refs', () => {
  const sql = `SELECT * FROM {{#12-orders}} o
WHERE created_at > {{since}}
[[ AND status = {{status}} ]]
{{snippet: active users}}
[[ AND region = {{ since }} ]]`
  assertEquals(parseSqlVariables(sql), [
    { key: '#12-orders', name: '#12-orders', kind: 'card', optional: false },
    { key: 'since', name: 'since', kind: 'variable', optional: false },
    { key: 'status', name: 'status', kind: 'variable', optional: true },
    { key: 'snippet: active users', name: 'active users', kind: 'snippet', optional: false },
  ])
})

Deno.test('template tags keep existing ids and types; parameter values target their tag', () => {
  const vars = parseSqlVariables('select {{n}} [[ and x = {{label}} ]] {{snippet: s}}')
  const tags = buildTemplateTags(vars, { n: 'number' }, {
    prev: { label: { id: 'keep-me', name: 'label', 'display-name': 'Label', type: 'text' } },
    snippets: [{ id: 9, name: 's', content: '1=1' }],
  })
  assertEquals(tags.n.type, 'number')
  assertEquals(tags.label.id, 'keep-me')
  assertEquals(tags['snippet: s'], { id: tags['snippet: s'].id, name: 'snippet: s', 'display-name': 's', type: 'snippet', 'snippet-name': 's', 'snippet-id': 9 })
  assertEquals(missingRequired(vars, { label: '' }), ['n'])
  assertEquals(buildParameterValues(vars, { n: '42', label: '' }, { n: 'number' }), [
    { type: 'number/=', value: 42, target: ['variable', ['template-tag', 'n']] },
  ])
})

Deno.test('dashboard filters only reach the cards they are mapped to', () => {
  const params = [
    { id: 'p1', name: 'Region', slug: 'region', type: 'string/=' },
    { id: 'p2', name: 'Date', slug: 'date', type: 'date/all-options' },
    { id: 'p3', name: 'Unused', slug: 'unused', type: 'number/=' },
  ]
  const dc = {
    card_id: 7,
    parameter_mappings: [
      { parameter_id: 'p1', card_id: 7, target: ['dimension', ['field', 1, null]] },
      { parameter_id: 'p2', card_id: 8, target: ['dimension', ['field', 2, null]] }, // series card, not this one
    ],
  }
  assertEquals(parametersForDashcard(params, dc, { p1: 'EU, US', p2: 'past30days', p3: '4' }), [
    { id: 'p1', type: 'string/=', value: ['EU', 'US'], target: ['dimension', ['field', 1, null]] },
  ])
  assertEquals(encodeFilterValue('number/between', '1, 9'), [1, 9])
  assertEquals(encodeFilterValue('date/single', '2026-01-01'), '2026-01-01')
  assertEquals(encodeFilterValue('string/=', '  '), null)
  assertEquals(filterReach(params, [dc]), { p1: 1, p2: 1, p3: 0 })
})

/* ───────────── result → chart ───────────── */

const timeCols = [
  { name: 'created_at', display_name: 'Created At', base_type: 'type/DateTime', unit: 'month' },
  { name: 'count', display_name: 'Count', base_type: 'type/BigInteger' },
]

Deno.test('wall-clock time ignores the report-timezone offset', () => {
  assertEquals(wallTime('2026-01-01T00:00:00-05:00'), Date.UTC(2026, 0, 1))
  assertEquals(formatTime(wallTime('2026-01-01T00:00:00+05:30')!, 'month'), 'Jan 2026')
  assertEquals(formatTime(Date.UTC(2026, 3, 1), 'quarter'), 'Q2 2026')
})

Deno.test('time + metric → one sorted series; numbers kept, gaps stay null', () => {
  const m = toChartModel(timeCols, [['2026-03-01', 5], ['2026-01-01', 3], ['2026-02-01', null]])
  assert(!('error' in m))
  assertEquals(m.xKind, 'time')
  assertEquals(m.x, [Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1), Date.UTC(2026, 2, 1)])
  assertEquals(m.series, [{ key: 'count', name: 'Count', values: [3, null, 5] }])
  assertEquals(m.unit, 'month')
})

Deno.test('two dimensions pivot into one series per breakout value', () => {
  const cols = [
    { name: 'month', base_type: 'type/Date', unit: 'month' },
    { name: 'plan', base_type: 'type/Text' },
    { name: 'mrr', base_type: 'type/Float' },
  ]
  const m = toChartModel(cols, [
    ['2026-01-01', 'team', 10],
    ['2026-01-01', 'pro', 20],
    ['2026-02-01', 'team', 12],
  ])
  assert(!('error' in m))
  assertEquals(m.series.map((s) => [s.name, s.values]), [['team', [10, 12]], ['pro', [20, null]]])
})

Deno.test('graph.dimensions / graph.metrics settings win over inference', () => {
  const cols = [
    { name: 'a', base_type: 'type/Text' },
    { name: 'b', base_type: 'type/Text' },
    { name: 'x', base_type: 'type/Integer' },
    { name: 'y', base_type: 'type/Integer' },
  ]
  const m = toChartModel(cols, [['p', 'q', 1, 2]], { 'graph.dimensions': ['b'], 'graph.metrics': ['y'] })
  assert(!('error' in m))
  assertEquals(m.xName, 'b')
  assertEquals(m.series.map((s) => s.key), ['y'])
})

Deno.test('unchartable results say why instead of drawing zeros', () => {
  assertEquals(toChartModel([{ name: 'name', base_type: 'type/Text' }], [['a']]), { error: 'This result has no numeric column to plot.' })
  assertEquals(toChartModel(timeCols, []), { error: 'No rows to chart.' })
})

Deno.test('more than eight series fold the smallest into Other', () => {
  const series = Array.from({ length: 11 }, (_, i) => ({ key: `s${i}`, name: `s${i}`, values: [i, i] }))
  const { kept, folded } = foldSeries(series)
  assertEquals(kept.length, 8)
  assertEquals(folded, 4)
  assertEquals(kept[7], { key: '__other__', name: 'Other (4)', values: [6, 6] }) // s0+s1+s2+s3
  assert(!kept.some((s) => s.key === 's0'))
})

Deno.test('slices are shares of the total, largest first, folded past the cap', () => {
  const cols = [{ name: 'k', base_type: 'type/Text' }, { name: 'v', base_type: 'type/Integer' }]
  const s = toSlices(cols, [['a', 1], ['b', 3], ['c', -2], ['d', 0]], undefined, 2)
  assert(Array.isArray(s))
  assertEquals(s.map((x) => [x.label, x.value, x.share]), [['b', 3, 0.75], ['Other (2)', 1, 0.25]])
})

Deno.test('scalar and trend scalar read real values; one row means no delta', () => {
  assertEquals(toScalar({ data: { cols: [{ name: 'sum', base_type: 'type/Float' }], rows: [[12.5]] } }).value, 12.5)
  const t = toSmartScalar({ data: { cols: timeCols, rows: [['2026-02-01', 120], ['2026-01-01', 100]] } })
  assertEquals([t.value, t.previous, t.change, t.period, t.previousPeriod], [120, 100, 0.2, 'Feb 2026', 'Jan 2026'])
  const one = toSmartScalar({ data: { cols: timeCols, rows: [['2026-02-01', 120]] } })
  assertEquals([one.value, one.change], [120, null])
})

Deno.test('auto display and support checks', () => {
  assertEquals(autoDisplay([{ name: 'n', base_type: 'type/Integer' }], [[1]]), 'scalar')
  assertEquals(autoDisplay(timeCols, [['2026-01-01', 1]]), 'line')
  assertEquals(autoDisplay([{ name: 'k', base_type: 'type/Text' }, { name: 'v', base_type: 'type/Integer' }], [['a', 1]]), 'bar')
  assertEquals(vizSupported('line', [{ name: 'k', base_type: 'type/Text' }], [['a']]), false)
  assertEquals(vizSupported('table', [], []), true)
  assertEquals(colKind({ name: 'id', base_type: 'type/Integer', semantic_type: 'type/PK' }), 'category')
  assertEquals(colKind({ name: 'd' }, [['2026-01-01']], 0), 'time')
})

Deno.test('pivot-lite totals rows, columns and grand total', () => {
  const p = toPivot(
    [{ name: 'r', base_type: 'type/Text' }, { name: 'c', base_type: 'type/Text' }, { name: 'v', base_type: 'type/Integer' }],
    [['a', 'x', 1], ['a', 'y', 2], ['b', 'x', 3]],
  )
  assert(!('error' in p))
  assertEquals(p.cells, [[1, 2], [3, null]])
  assertEquals([p.rowTotals, p.colTotals, p.grand], [[3, 3], [4, 2], 6])
})

Deno.test('sorting puts nulls last both ways; stats summarise loaded rows', () => {
  const rows = [[3], [null], [1], [2]]
  assertEquals(sortRowIndexes(rows, 0, 'asc'), [2, 3, 0, 1])
  assertEquals(sortRowIndexes(rows, 0, 'desc'), [0, 3, 2, 1])
  const s = columnStats([{ name: 'v', base_type: 'type/Integer' }], rows)[0]
  assertEquals([s.nulls, s.distinct, s.min, s.max, s.sum, s.avg], [1, 3, 1, 3, 6, 2])
})

Deno.test('number formatting and nice scales', () => {
  assertEquals([formatCompact(1234), formatCompact(12_345), formatCompact(2_500_000), formatCompact(0.0421)], ['1234', '12.3K', '2.5M', '0.042'])
  assertEquals(niceScale(0, 87), { lo: 0, hi: 100, step: 25 })
  assertEquals(niceScale(-12, 30).lo < 0, true)
})

/* ───────────── schedules ───────────── */

Deno.test('schedules map to Metabase channel fields and back', () => {
  assertEquals(toChannelSchedule({ type: 'hourly', hour: 5, day: 'mon', frame: 'first' }), {
    schedule_type: 'hourly', schedule_hour: null, schedule_day: null, schedule_frame: null,
  })
  assertEquals(toChannelSchedule({ type: 'monthly', hour: 9, day: 'fri', frame: 'mid' }), {
    schedule_type: 'monthly', schedule_hour: 9, schedule_day: null, schedule_frame: 'mid',
  })
  const back = fromChannel({ schedule_type: 'weekly', schedule_hour: 14, schedule_day: 'wed' })
  assertEquals(describeSchedule(back), 'Weekly on Wednesday at 2:00 PM')
  assertEquals(describeSchedule({ type: 'monthly', hour: 0, day: 'mon', frame: 'last' }), 'Monthly on the last Monday at 12:00 AM')
  assertEquals(describeSchedule({ type: 'monthly', hour: 8, day: null, frame: 'first' }), 'Monthly on the 1st at 8:00 AM')
})

Deno.test('next run is computed in the report timezone', () => {
  // Tue 2026-10-20 10:30 UTC.
  const now = Date.UTC(2026, 9, 20, 10, 30)
  assertEquals(nextRun({ type: 'hourly', hour: 0, day: null, frame: 'first' }, now, 'UTC'), Date.UTC(2026, 9, 20, 11))
  assertEquals(nextRun({ type: 'daily', hour: 8, day: null, frame: 'first' }, now, 'UTC'), Date.UTC(2026, 9, 21, 8))
  assertEquals(nextRun({ type: 'daily', hour: 12, day: null, frame: 'first' }, now, 'UTC'), Date.UTC(2026, 9, 20, 12))
  assertEquals(nextRun({ type: 'weekly', hour: 9, day: 'mon', frame: 'first' }, now, 'UTC'), Date.UTC(2026, 9, 26, 9))
  assertEquals(nextRun({ type: 'monthly', hour: 9, day: null, frame: 'last' }, now, 'UTC'), Date.UTC(2026, 9, 31, 9))
  assertEquals(nextRun({ type: 'monthly', hour: 9, day: 'mon', frame: 'first' }, now, 'UTC'), Date.UTC(2026, 10, 2, 9))
  assertEquals(nextRun({ type: 'monthly', hour: 9, day: null, frame: 'mid' }, now, 'UTC'), Date.UTC(2026, 10, 15, 9))
  // 08:00 in Kolkata (UTC+5:30) is 02:30 UTC.
  assertEquals(nextRun({ type: 'daily', hour: 8, day: null, frame: 'first' }, now, 'Asia/Kolkata'), Date.UTC(2026, 9, 21, 2, 30))
  // 08:00 New York on 2026-10-21 is still EDT (UTC-4).
  assertEquals(nextRun({ type: 'daily', hour: 8, day: null, frame: 'first' }, now, 'America/New_York'), Date.UTC(2026, 9, 20, 12))
})

/* ───────────── grid ───────────── */

Deno.test('grid layout honours Metabase positions on desktop and flows in reading order below', () => {
  const items = [
    { id: 2, row: 0, col: 12, size_x: 12, size_y: 4 },
    { id: 1, row: 0, col: 0, size_x: 12, size_y: 4 },
    { id: 3, row: 4, col: 0, size_x: 24, size_y: 12 },
    { id: 4, row: 4, col: 24, size_x: 4, size_y: 2 }, // placed past 24 — widen, never clip
  ]
  assertEquals(gridColumns(items), 28)
  const d = layout(items, 'desktop')
  assertEquals(d.placements.map((p) => [p.id, p.column, p.row]), [
    [1, '1 / span 12', '1 / span 4'],
    [2, '13 / span 12', '1 / span 4'],
    [3, '1 / span 24', '5 / span 12'],
    [4, '25 / span 4', '5 / span 2'],
  ])
  assertEquals(layout(items, 'tablet').placements.map((p) => p.column), ['span 6', 'span 6', 'span 12', 'span 6'])
  assertEquals(layout(items, 'phone').placements.map((p) => [p.id, p.span]), [[1, 4], [2, 4], [3, 9], [4, 2]])
  assertEquals([gridMode(1300), gridMode(800), gridMode(390)], ['desktop', 'tablet', 'phone'])
})

/* ───────────── sql ───────────── */

Deno.test('formatSql breaks clauses, upper-cases keywords and leaves literals and tags alone', () => {
  const out = formatSql("select a, count(*) as n from t left join u on t.id = u.id where x = 'select, from' and y > {{since}} [[and z = {{z}}]] group by a order by n desc limit 10")
  assertEquals(out, `SELECT
  a,
  COUNT(*) AS n
FROM t
LEFT JOIN u ON t.id = u.id
WHERE x = 'select, from'
  AND y > {{since}}
  [[AND z = {{z}}]]
GROUP BY a
ORDER BY n DESC
LIMIT 10
`)
  // Idempotent.
  assertEquals(formatSql(out), out)
})

Deno.test('error positions from Postgres offsets and line/column messages', () => {
  const sql = 'select 1\nfrom nope'
  assertEquals(errorPosition('ERROR: relation "nope" does not exist\n  Position: 15', sql), { line: 2, column: 6 })
  assertEquals(errorPosition('Syntax error: line 2:5 unexpected', sql), { line: 2, column: 5 })
  assertEquals(errorPosition('SQL compilation error: error line 3 at position 4', sql), { line: 3, column: 5 })
  assertEquals(errorPosition('something else', sql), null)
  assertEquals(datasetError({ status: 'failed', error: 'boom' }), 'boom')
  assertEquals(datasetError({ status: 'completed' }), null)
})

Deno.test('history is per user, newest first, de-duplicated and capped', () => {
  const mem = new Map<string, string>()
  const kv = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
  let h = loadHistory(kv, 7)
  h = pushHistory(h, { sql: 'select 1', databaseId: 1, at: 1, ok: true })
  h = pushHistory(h, { sql: 'select 2', databaseId: 1, at: 2, ok: true })
  h = pushHistory(h, { sql: 'select 1 ', databaseId: 1, at: 3, ok: false })
  saveHistory(kv, 7, h)
  assertEquals(loadHistory(kv, 7).map((e) => [e.sql, e.at]), [['select 1 ', 3], ['select 2', 2]])
  assertEquals(loadHistory(kv, 8), [])
  for (let i = 0; i < 80; i++) h = pushHistory(h, { sql: `q${i}`, databaseId: 1, at: i, ok: true })
  assertEquals(h.length, 50)
})

Deno.test('CSV quotes, neutralises formulas; JSON keys by column name', () => {
  const cols = [{ name: 'a', display_name: 'A' }, { name: 'b' }]
  assertEquals(toCsv(cols, [['x,y', '=SUM(1)'], [null, -3]]), 'A,b\r\n"x,y",\'=SUM(1)\r\n,-3\r\n')
  assertEquals(JSON.parse(toJson(cols, [[1, null]])), [{ a: 1, b: null }])
})
