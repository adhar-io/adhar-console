import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  averageRetention,
  buildCohortFilters,
  buildFunnelsQuery,
  buildTrendsQuery,
  describeCohort,
  filterRecordings,
  filtersToHogQL,
  flagDraftToFilters,
  funnelMath,
  funnelSpecFromInsight,
  hogqlString,
  normalizeRecording,
  parseFlag,
  parseFunnel,
  parsePaths,
  parseRetention,
  parseTrends,
  pctChange,
  variantsValid,
  windowClause,
  worstStep,
} from './posthog.ts'

Deno.test('HogQL literals are escaped', () => {
  assertEquals(hogqlString("o'brien\\x"), "'o\\'brien\\\\x'")
})

Deno.test('property filters compile to HogQL', () => {
  assertEquals(
    filtersToHogQL([
      { key: '$browser', value: 'Chrome', type: 'event' },
      { key: 'plan', value: ['team', 'enterprise'], type: 'person' },
      { key: '$current_url', value: 'pricing', operator: 'icontains', type: 'event' },
      { key: 'weird key', operator: 'is_set', type: 'event' },
      { key: 'id', value: 7, type: 'cohort' },
    ]),
    "properties.$browser = 'Chrome' and person.properties.plan IN ('team', 'enterprise') and properties.$current_url ILIKE '%pricing%' and properties['weird key'] IS NOT NULL and person_id IN COHORT 7",
  )
  assertEquals(filtersToHogQL([{ key: '', type: 'event' }]), '')
})

Deno.test('window clauses cover the current and the previous period', () => {
  assertEquals(windowClause('-7d'), 'timestamp >= now() - interval 168 hour')
  assertEquals(windowClause('-24h', true), 'timestamp >= now() - interval 48 hour and timestamp < now() - interval 24 hour')
})

Deno.test('trends query carries math, breakdown, compare and filters', () => {
  const q = buildTrendsQuery({ event: '$pageview', math: 'dau', range: '-30d', breakdown: '$browser', compare: true, filters: [{ key: 'plan', value: 'team', type: 'person' }] })
  assertEquals(q.kind, 'TrendsQuery')
  assertEquals((q.series as Array<Record<string, unknown>>)[0].math, 'dau')
  assertEquals(q.interval, 'day')
  assertEquals(q.compareFilter, { compare: true })
  assertEquals((q.breakdownFilter as Record<string, unknown>).breakdown, '$browser')
  assertEquals((q.properties as unknown[]).length, 1)
  assertEquals(buildTrendsQuery({ event: null, math: 'total', range: '-24h' }).interval, 'hour')
})

Deno.test('trend results parse with timestamps, breakdown and compare labels', () => {
  const s = parseTrends([
    { label: '$pageview', data: [1, 2, 3], days: ['2026-10-01', '2026-10-02', '2026-10-03'], count: 6, breakdown_value: 'Chrome', compare_label: 'current' },
    { label: '$pageview', data: [0, 1], days: ['2026-10-01 10:00:00', '2026-10-01 11:00:00'], breakdown_value: '$$_posthog_breakdown_other_$$' },
  ])
  assertEquals(s[0].count, 6)
  assertEquals(s[0].breakdown, 'Chrome')
  assertEquals(s[0].compare, 'current')
  assertEquals(s[0].times.length, 3)
  assertEquals(s[1].breakdown, 'Other')
  assertEquals(s[1].count, 1)
  assertEquals(parseTrends(null), [])
})

Deno.test('pct change is null without a baseline', () => {
  assertEquals(pctChange(150, 100), 50)
  assertEquals(pctChange(5, 0), null)
})

Deno.test('funnel query and math: conversion, drop-off, worst step', () => {
  const q = buildFunnelsQuery({ steps: [{ event: 'a' }, { event: 'b' }], range: '-30d', windowDays: 7, breakdown: '$browser' })
  assertEquals((q.funnelsFilter as Record<string, unknown>).funnelWindowInterval, 7)
  const groups = parseFunnel([
    { name: 'a', order: 0, count: 200, average_conversion_time: null },
    { name: 'b', order: 1, count: 100, average_conversion_time: 30, median_conversion_time: 20 },
    { name: 'c', order: 2, count: 20, average_conversion_time: 300 },
  ])
  assertEquals(groups.length, 1)
  const m = funnelMath(groups[0].steps)
  assertEquals(m.overall, 0.1)
  assertEquals(m.steps[1].fromPrevious, 0.5)
  assertEquals(m.steps[2].dropped, 80)
  assertEquals(m.steps[1].avgTime, 30)
  assertEquals(m.steps[0].avgTime, null)
  assertEquals(worstStep(m.steps), 2)
  assertEquals(funnelMath([]).overall, 0)
})

Deno.test('breakdown funnels parse into groups', () => {
  const g = parseFunnel([
    [{ name: 'a', order: 0, count: 10, breakdown_value: ['Chrome'] }, { name: 'b', order: 1, count: 5, breakdown_value: ['Chrome'] }],
    [{ name: 'a', order: 0, count: 4, breakdown_value: ['Safari'] }, { name: 'b', order: 1, count: 1, breakdown_value: ['Safari'] }],
  ])
  assertEquals(g.map((x) => x.value), ['Chrome', 'Safari'])
})

Deno.test('saved funnel insights round-trip to a spec (new query + legacy filters)', () => {
  const spec = funnelSpecFromInsight({
    query: { kind: 'InsightVizNode', source: buildFunnelsQuery({ steps: [{ event: 'signup' }, { event: 'paid', name: 'Paid' }], range: '-14d', windowDays: 3 }) },
  })
  assertEquals(spec?.steps, [{ event: 'signup', name: undefined }, { event: 'paid', name: 'Paid' }])
  assertEquals(spec?.windowDays, 3)
  assertEquals(spec?.range, '-14d')
  const legacy = funnelSpecFromInsight({ filters: { insight: 'FUNNELS', events: [{ id: 'b', order: 1 }, { id: 'a', order: 0 }], date_from: '-80d' } })
  assertEquals(legacy?.steps.map((s) => s.event), ['a', 'b'])
  assertEquals(legacy?.range, '-90d')
  assertEquals(funnelSpecFromInsight({ query: { kind: 'TrendsQuery' } }), null)
})

Deno.test('retention parses counts to percentages and averages by cohort size', () => {
  const c = parseRetention([
    { label: 'Week 0', date: '2026-09-01', values: [{ count: 100 }, { count: 50 }, { count: 25 }] },
    { label: 'Week 1', date: '2026-09-08', values: [{ count: 50 }, { count: 10 }] },
  ])
  assertEquals(c[0].pct, [100, 50, 25])
  const avg = averageRetention(c)
  assertEquals(avg[0], 100)
  assertEquals(avg[1], 40)
  assertEquals(avg[2], 25)
})

Deno.test('paths strip the step prefix', () => {
  const p = parsePaths([{ source: '1_/home', target: '2_/pricing', value: 5 }, { source: '1_/home', target: '2_/docs', value: 9 }])
  assertEquals(p[0].to, '/docs')
  assertEquals(p[0].from, '/home')
  assertEquals(p[0].step, 1)
})

Deno.test('flag parsing: rollout, conditions, variants, experiments', () => {
  const f = parseFlag({
    id: 3,
    key: 'new-nav',
    name: 'New nav',
    active: true,
    filters: {
      groups: [
        { properties: [{ key: 'email', value: '@adhar.dev', operator: 'icontains', type: 'person' }], rollout_percentage: 100 },
        { properties: [], rollout_percentage: 25 },
      ],
      multivariate: { variants: [{ key: 'control', rollout_percentage: 50 }, { key: 'test', rollout_percentage: 50 }] },
    },
    experiment_set: [9],
  })
  assertEquals(f.rollout, 25)
  assertEquals(f.conditions[0].properties, ['email contains @adhar.dev'])
  assertEquals(f.variants.length, 2)
  assertEquals(f.experiments, ['9'])
  assert(!f.fullyRolledOut)
  assertEquals(parseFlag({ id: 1, key: 'x', active: true, filters: { groups: [{ properties: [], rollout_percentage: null }] } }).fullyRolledOut, true)
  assertEquals(parseFlag({ id: 1, key: 'x', active: false, filters: { groups: [{ properties: [{ key: 'a', value: 1 }] }] } }).rollout, null)
})

Deno.test('flag drafts serialise to PostHog filters and validate variant splits', () => {
  const body = flagDraftToFilters({
    key: 'k',
    name: '',
    active: true,
    conditions: [{ rollout: 120, properties: [{ key: 'plan', value: 'team', type: 'person' }] }],
    variants: [{ key: 'a', rollout: 60 }, { key: 'b', rollout: 40 }],
  })
  const g = (body.groups as Array<Record<string, unknown>>)[0]
  assertEquals(g.rollout_percentage, 100)
  assertEquals((g.properties as unknown[]).length, 1)
  assert(variantsValid([{ rollout: 60 }, { rollout: 40 }]))
  assert(!variantsValid([{ rollout: 60 }, { rollout: 30 }]))
  assert(variantsValid([]))
})

Deno.test('cohort filters build and describe (behavioural + property)', () => {
  const filters = buildCohortFilters([
    { kind: 'behavioral', key: '$pageview', verb: 'performed_event_multiple', times: 5, days: 7 },
    { kind: 'person', key: 'plan', operator: 'exact', value: 'team' },
  ])
  const d = describeCohort({ id: 1, name: 'x', filters: filters as never })
  assertEquals(d.joiner, 'OR')
  assertEquals(d.groups[0], ['did $pageview ≥ 5 times in the last 7 days', 'plan = team'])
})

Deno.test('recordings normalise real rows and filter client-side', () => {
  const r = normalizeRecording({
    id: 's1',
    distinct_id: 'd1',
    recording_duration: 125,
    console_error_count: 2,
    click_count: 4,
    start_time: '2026-10-17T10:00:00Z',
    start_url: 'https://app/pricing',
    person: { uuid: 'p1', properties: { email: 'a@b.c', $browser: 'Chrome' } },
  })
  assertEquals(r.personName, 'a@b.c')
  assertEquals(r.durationS, 125)
  assertEquals(r.browser, 'Chrome')
  assertEquals(filterRecordings([r], { errorsOnly: true, minDurationS: 60, url: 'pricing', person: 'a@b' }).length, 1)
  assertEquals(filterRecordings([r], { minDurationS: 300 }).length, 0)
})
