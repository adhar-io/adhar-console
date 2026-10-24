import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  ALL_VALUE,
  clampRefresh,
  applyVarRegex,
  builtinVars,
  computeStepMs,
  expandRepeats,
  formatLegend,
  formatUnit,
  type GrafanaDatasource,
  type GrafanaPanel,
  groupLibrary,
  interpolate,
  layoutSections,
  mapValue,
  normalizePanels,
  orderVariables,
  parseCustomOptions,
  parseGrafanaTime,
  parseImport,
  parsePromVarQuery,
  readBoardUrl,
  reconcileSelection,
  reduce,
  resolveDatasource,
  resolveRange,
  sortOptions,
  thresholdFor,
  type VarMap,
  writeBoardUrl,
} from './grafana-board.ts'

const NOW = Date.UTC(2026, 9, 17, 12, 30, 0)

Deno.test('relative Grafana times resolve against now', () => {
  assertEquals(parseGrafanaTime('now', NOW), NOW)
  assertEquals(parseGrafanaTime('now-6h', NOW), NOW - 6 * 3_600_000)
  assertEquals(parseGrafanaTime('now-1d-30m', NOW), NOW - 86_400_000 - 1_800_000)
  assertEquals(parseGrafanaTime('1700000000000', NOW), 1_700_000_000_000)
  const sod = new Date(NOW)
  sod.setHours(0, 0, 0, 0)
  assertEquals(parseGrafanaTime('now/d', NOW), sod.getTime())
  assertEquals(parseGrafanaTime('now/d', NOW, true), sod.getTime() + 86_400_000 - 1)
})

Deno.test('an inverted range falls back to the hour before `to`', () => {
  const r = resolveRange('now', 'now-1h', NOW)
  assertEquals(r.end - r.start, 3_600_000)
})

Deno.test('step is range/points rounded up, never under the scrape interval', () => {
  assertEquals(computeStepMs(3_600_000), 15_000)
  assertEquals(computeStepMs(24 * 3_600_000), 300_000)
  assertEquals(computeStepMs(60_000), 15_000)
})

Deno.test('rate interval follows Grafana: max(step + scrape, 4 × scrape)', () => {
  assertEquals(builtinVars(3_600_000, 15_000).__rate_interval, '1m')
  assertEquals(builtinVars(86_400_000, 300_000).__rate_interval, '315s')
  assertEquals(builtinVars(3_600_000, 15_000).__range, '3600s')
})

const vars: VarMap = {
  namespace: { values: ['adhar-system'], options: ['adhar-system', 'default'] },
  pod: { values: ['a.1', 'b'], options: ['a.1', 'b', 'c'], multi: true },
  job: { values: [ALL_VALUE], options: ['x', 'y'], includeAll: true, allValue: '.+' },
  node: { values: [ALL_VALUE], options: ['n1', 'n2'], includeAll: true },
}

Deno.test('interpolation covers $var, ${var}, [[var]], formats and All', () => {
  assertEquals(interpolate('up{namespace="$namespace"}', vars), 'up{namespace="adhar-system"}')
  assertEquals(interpolate('{pod=~"${pod}"}', vars), '{pod=~"(a\\.1|b)"}')
  assertEquals(interpolate('{pod=~"[[pod]]"}', vars), '{pod=~"(a\\.1|b)"}')
  assertEquals(interpolate('${pod:csv}', vars), 'a.1,b')
  assertEquals(interpolate('{job=~"$job"}', vars), '{job=~".+"}')
  assertEquals(interpolate('{node=~"$node"}', vars), '{node=~"(n1|n2)"}')
  assertEquals(interpolate('rate(x[$__rate_interval])', vars, { __rate_interval: '1m' }), 'rate(x[1m])')
  assertEquals(interpolate('$unknown', vars), '$unknown')
  assertEquals(interpolate('{pod="$pod"}', vars, {}, { pod: 'web-0' }), '{pod="web-0"}')
})

Deno.test('Prometheus variable queries parse', () => {
  assertEquals(parsePromVarQuery('label_values(cluster)'), { kind: 'label_values', label: 'cluster' })
  assertEquals(parsePromVarQuery('label_values(kube_pod_info{cluster="$cluster"}, namespace)'), {
    kind: 'label_values',
    label: 'namespace',
    match: 'kube_pod_info{cluster="$cluster"}',
  })
  assertEquals(parsePromVarQuery('query_result(up == 1)'), { kind: 'query_result', expr: 'up == 1' })
  assertEquals(parsePromVarQuery('metrics(node_.*)'), { kind: 'metrics', regex: 'node_.*' })
  assertEquals(parsePromVarQuery('label_names()').kind, 'label_names')
})

Deno.test('variable regex narrows to the capture group and drops misses', () => {
  assertEquals(applyVarRegex(['up{job="api"} 1', 'up{job="web"} 1', 'nope'], '/job="([^"]+)"/'), ['api', 'web'])
  assertEquals(applyVarRegex(['a', 'b'], ''), ['a', 'b'])
})

Deno.test('custom options, sort codes and selection reconcile', () => {
  assertEquals(parseCustomOptions('1m,5m, 1h'), [
    { text: '1m', value: '1m' },
    { text: '5m', value: '5m' },
    { text: '1h', value: '1h' },
  ])
  assertEquals(parseCustomOptions('Prod : prod,Dev : dev')[0], { text: 'Prod', value: 'prod' })
  assertEquals(sortOptions(['b', 'a', 'c'], 1), ['a', 'b', 'c'])
  assertEquals(sortOptions(['n10', 'n2'], 3), ['n2', 'n10'])
  assertEquals(reconcileSelection(['gone'], ['x', 'y']), ['x'])
  assertEquals(reconcileSelection(['y'], ['x', 'y']), ['y'])
  assertEquals(reconcileSelection([ALL_VALUE], ['x'], true), [ALL_VALUE])
  assertEquals(reconcileSelection([], ['x'], true), [ALL_VALUE])
})

Deno.test('variables are ordered after the variables they reference', () => {
  const ordered = orderVariables([
    { name: 'namespace', type: 'query', query: 'label_values(kube_pod_info{cluster="$cluster"}, namespace)' },
    { name: 'cluster', type: 'query', query: 'label_values(up, cluster)', datasource: '$datasource' },
    { name: 'datasource', type: 'datasource', query: 'prometheus' },
  ])
  assertEquals(ordered.map((v) => v.name), ['datasource', 'cluster', 'namespace'])
})

const DS: GrafanaDatasource[] = [
  { uid: 'prom', name: 'Prometheus', type: 'prometheus', isDefault: true },
  { uid: 'loki', name: 'Loki', type: 'loki' },
]

Deno.test('datasource refs resolve by uid, name, variable and default', () => {
  const v: VarMap = { datasource: { values: ['loki'], options: ['prom', 'loki'] } }
  assertEquals(resolveDatasource({ uid: 'loki', type: 'loki' }, DS, v)?.name, 'Loki')
  assertEquals(resolveDatasource('Loki', DS, v)?.uid, 'loki')
  assertEquals(resolveDatasource({ uid: '${datasource}', type: 'prometheus' }, DS, v)?.uid, 'loki')
  assertEquals(resolveDatasource(null, DS, v)?.uid, 'prom')
  assertEquals(resolveDatasource({ type: 'loki' }, DS, v)?.uid, 'loki')
  assertEquals(resolveDatasource('-- Mixed --', DS, v), null)
})

Deno.test('rows split the board into rebased sections; collapsed rows keep nested panels', () => {
  const panels: GrafanaPanel[] = [
    { id: 1, type: 'stat', gridPos: { x: 0, y: 0, w: 12, h: 4 } },
    { id: 2, type: 'stat', gridPos: { x: 12, y: 0, w: 12, h: 4 } },
    { id: 3, type: 'row', title: 'CPU', gridPos: { x: 0, y: 4, w: 24, h: 1 } },
    { id: 4, type: 'timeseries', gridPos: { x: 0, y: 5, w: 24, h: 8 } },
    {
      id: 5,
      type: 'row',
      title: 'Memory',
      collapsed: true,
      gridPos: { x: 0, y: 13, w: 24, h: 1 },
      panels: [{ id: 6, type: 'timeseries', gridPos: { x: 0, y: 14, w: 24, h: 8 } }],
    },
  ]
  const s = layoutSections(panels)
  assertEquals(s.length, 3)
  assertEquals(s[0].row, null)
  assertEquals(s[0].height, 4)
  assertEquals(s[1].row?.title, 'CPU')
  assertEquals(s[1].panels[0].gridPos.y, 0)
  assertEquals(s[2].panels[0].id, 6)
  assertEquals(s[2].panels[0].gridPos.y, 0)
})

Deno.test('legacy rows become flat panels with gridPos', () => {
  const p = normalizePanels({
    uid: 'x',
    title: 'x',
    rows: [{ title: 'R', height: '250px', panels: [{ id: 1, type: 'graph', span: 6 } as GrafanaPanel, { id: 2, type: 'graph', span: 6 } as GrafanaPanel] }],
  })
  assertEquals(p.map((x) => x.type), ['row', 'graph', 'graph'])
  assertEquals(p[2].gridPos?.x, 12)
})

Deno.test('repeat panels clone per value and push later panels down', () => {
  const v: VarMap = { pod: { values: ['a', 'b', 'c', 'd', 'e'], options: [], multi: true } }
  const out = expandRepeats(
    [
      { id: 1, type: 'stat', repeat: 'pod', gridPos: { x: 0, y: 0, w: 6, h: 4 } },
      { id: 2, type: 'table', gridPos: { x: 0, y: 4, w: 24, h: 6 } },
    ],
    v,
  )
  const clones = out.filter((p) => p.scopedVars)
  assertEquals(clones.length, 5)
  assertEquals(clones[4].gridPos, { x: 0, y: 4, w: 6, h: 4 })
  assertEquals(out.find((p) => p.id === 2)?.gridPos?.y, 8)
})

Deno.test('legend formats use labels; auto falls back to the series string', () => {
  assertEquals(formatLegend('{{pod}} / {{container}}', { pod: 'web', container: 'app' }), 'web / app')
  assertEquals(formatLegend('__auto', { __name__: 'up', job: 'api' }), 'up{job="api"}')
  assertEquals(formatLegend(undefined, {}, 'A'), 'A')
})

Deno.test('reducers', () => {
  assertEquals(reduce([1, 2, NaN], 'lastNotNull'), 2)
  assertEquals(reduce([1, 2, 3], 'mean'), 2)
  assertEquals(reduce([1, 5, 3], 'max'), 5)
  assertEquals(reduce([], 'max'), null)
})

Deno.test('units format like Grafana', () => {
  assertEquals(formatUnit(1536, 'bytes'), '1.5 KiB')
  assertEquals(formatUnit(0.256, 'percentunit'), '25.6%')
  assertEquals(formatUnit(42, 'percent'), '42%')
  assertEquals(formatUnit(0.25, 's'), '250 ms')
  assertEquals(formatUnit(1500, 'reqps'), '1.5K req/s')
  assertEquals(formatUnit(null, 'bytes'), '—')
  assertEquals(formatUnit(12345, 'short'), '12.3K')
})

Deno.test('thresholds pick the highest step reached; mappings translate values', () => {
  const t = { steps: [{ color: 'green', value: null }, { color: 'orange', value: 70 }, { color: 'red', value: 90 }] }
  assertEquals(thresholdFor(50, t)?.color, 'green')
  assertEquals(thresholdFor(75, t)?.color, 'orange')
  assertEquals(thresholdFor(95, t)?.color, 'red')
  assertEquals(thresholdFor(0.95, { mode: 'percentage', steps: t.steps }, 0, 1)?.color, 'red')
  assertEquals(mapValue(1, [{ type: 'value', options: { '1': { text: 'UP' } } }])?.text, 'UP')
})

Deno.test('library groups starred first, then folders, and filters by tag/query', () => {
  const hits = [
    { uid: '1', title: 'Nodes', tags: ['kubernetes'], folderTitle: 'Kubernetes' },
    { uid: '2', title: 'API golden signals', tags: ['adhar'], folderTitle: 'Adhar', isStarred: true },
    { uid: '3', title: 'Pods', tags: ['kubernetes'] },
  ]
  const g = groupLibrary(hits)
  assertEquals(g.map((x) => x.folder), ['★ Starred', 'Adhar', 'General', 'Kubernetes'])
  assertEquals(groupLibrary(hits, { tags: ['kubernetes'] }).flatMap((x) => x.items.map((i) => i.uid)).sort(), ['1', '3'])
  assertEquals(groupLibrary(hits, { query: 'golden' }).flatMap((x) => x.items).length, 2)
})

Deno.test('import accepts bare and wrapped dashboards and strips the id', () => {
  const a = parseImport('{"id": 4, "title": "T", "panels": []}')
  assert(a.ok && !('id' in a.dashboard))
  assert(parseImport('{"dashboard": {"title": "T", "panels": []}}').ok)
  assert(!parseImport('{"title": "T"}').ok)
  assert(!parseImport('nope').ok)
})

Deno.test('board URL state round-trips and keeps the host params', () => {
  const qs = writeBoardUrl('?section=dashboards', {
    board: 'abc',
    from: 'now-6h',
    to: 'now',
    vars: { namespace: ['adhar-system'], pod: [ALL_VALUE], port: ['8080'] },
  })
  assert(qs.includes('section=dashboards'))
  const back = readBoardUrl(qs)
  assertEquals(back.board, 'abc')
  assertEquals(back.vars, { namespace: ['adhar-system'], pod: [ALL_VALUE], port: ['8080'] })
  assertEquals(writeBoardUrl(qs, { vars: {} }), '?section=dashboards')
})

Deno.test('clampRefresh — raises sub-minute refresh to the poll floor', () => {
  assertEquals(clampRefresh('5s'), '1m')
  assertEquals(clampRefresh('30s'), '1m')
  assertEquals(clampRefresh('1m'), '1m')
  assertEquals(clampRefresh('5m'), '5m')
  assertEquals(clampRefresh(''), '')
  assertEquals(clampRefresh(undefined), '')
  assertEquals(clampRefresh('soon'), '')
})
