import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  type AmAlert,
  groupAlerts,
  inhibitSides,
  lanesFromAlertsSeries,
  matcherText,
  mergeAlerts,
  parseMatchers,
  type PromAlert,
  receiverIntegrations,
  silenceMatchersFor,
  silenceMatches,
  since,
} from './alerting.ts'

const am: AmAlert[] = [
  {
    labels: { alertname: 'HighErrorRate', severity: 'critical', namespace: 'shop', prometheus: 'mon/kps' },
    annotations: { summary: 's' },
    startsAt: '2026-10-17T10:00:00Z',
    fingerprint: 'f1',
    receivers: [{ name: 'pager' }],
    status: { state: 'active', silencedBy: [], inhibitedBy: [] },
  },
  {
    labels: { alertname: 'PodCrashLooping', severity: 'warning', namespace: 'shop' },
    fingerprint: 'f2',
    status: { state: 'suppressed', silencedBy: ['s1'], inhibitedBy: [] },
  },
  {
    labels: { alertname: 'CPUThrottling', severity: 'info', namespace: 'kube-system' },
    fingerprint: 'f3',
    status: { state: 'suppressed', silencedBy: [], inhibitedBy: ['f1'] },
  },
]
const prom: PromAlert[] = [
  { labels: { alertname: 'HighErrorRate', severity: 'critical', namespace: 'shop' }, state: 'firing', value: '0.12' },
  { labels: { alertname: 'DiskFilling', severity: 'warning', namespace: 'adhar-system' }, state: 'pending', activeAt: '2026-10-17T11:00:00Z', value: '0.9' },
  { labels: { alertname: 'Watchdog' }, state: 'inactive' },
]

Deno.test('mergeAlerts combines Alertmanager state with Prometheus pending + value', () => {
  const u = mergeAlerts(am, prom)
  assertEquals(u.length, 4)
  const her = u.find((a) => a.name === 'HighErrorRate')!
  assertEquals(her.state, 'firing')
  assertEquals(her.value, 0.12) // matched despite AM's extra external label
  assertEquals(her.receivers, ['pager'])
  assertEquals(u.find((a) => a.name === 'PodCrashLooping')!.state, 'silenced')
  assertEquals(u.find((a) => a.name === 'CPUThrottling')!.state, 'inhibited')
  const pend = u.find((a) => a.name === 'DiskFilling')!
  assertEquals(pend.state, 'pending')
  assertEquals(pend.source, 'prometheus')
})

Deno.test('mergeAlerts without Alertmanager falls back to Prometheus', () => {
  const u = mergeAlerts(null, prom)
  assertEquals(u.map((a) => a.state).sort(), ['firing', 'pending'])
})

Deno.test('groupAlerts orders by worst state then severity', () => {
  const u = mergeAlerts(am, prom)
  const byNs = groupAlerts(u, 'namespace')
  assertEquals(byNs.map((g) => g.key), ['shop', 'adhar-system', 'kube-system'])
  assertEquals(byNs[0].counts, { firing: 1, pending: 0, silenced: 1, inhibited: 0 })
  assertEquals(byNs[0].worstSeverity, 'critical')
  const bySev = groupAlerts(u, 'severity')
  assertEquals(bySev[0].key, 'critical')
  assertEquals(groupAlerts(u, 'none').length, 1)
  assertEquals(groupAlerts([], 'alertname'), [])
})

Deno.test('silence matchers', () => {
  const m = silenceMatchersFor({ alertname: 'X', pod: 'p-1', namespace: 'n' })
  assertEquals(m.map(matcherText), ['alertname="X"', 'namespace="n"'])
  assert(silenceMatches({ matchers: m }, { alertname: 'X', namespace: 'n', pod: 'other' }))
  assert(!silenceMatches({ matchers: m }, { alertname: 'Y', namespace: 'n' }))
  assert(silenceMatches({ matchers: [{ name: 'alertname', value: 'Kube.*', isRegex: true }] }, { alertname: 'KubePodNotReady' }))
  assert(!silenceMatches({ matchers: [{ name: 'alertname', value: 'Kube', isRegex: true }] }, { alertname: 'KubePodNotReady' }))
  assert(silenceMatches({ matchers: [{ name: 'severity', value: 'info', isRegex: false, isEqual: false }] }, { severity: 'critical' }))
  assert(!silenceMatches({ matchers: [] }, { a: 'b' }))
})

Deno.test('parseMatchers', () => {
  assertEquals(parseMatchers('alertname="A", severity=~"crit.*", ns!="x"')!.map(matcherText), ['alertname="A"', 'severity=~"crit.*"', 'ns!="x"'])
  assertEquals(parseMatchers('{a="b"}')!.length, 1)
  assertEquals(parseMatchers('a=b'), null)
  assertEquals(parseMatchers(''), [])
})

Deno.test('lanesFromAlertsSeries builds merged intervals', () => {
  const lanes = lanesFromAlertsSeries([
    { metric: { alertname: 'A', alertstate: 'firing', severity: 'warning', pod: '1' }, values: [[100, '1'], [160, '1'], [220, '1'], [600, '1']] },
    { metric: { alertname: 'A', alertstate: 'firing', severity: 'critical', pod: '2' }, values: [[280, '1']] },
    { metric: { alertname: 'A', alertstate: 'pending', severity: 'warning', pod: '1' }, values: [[40, '1']] },
    { metric: { alertname: 'B', alertstate: 'firing', severity: 'info' }, values: [[100, '1']] },
  ], 60)
  assertEquals(lanes[0].name, 'A')
  assertEquals(lanes[0].severity, 'critical')
  assertEquals(lanes[0].instances, 2)
  const firing = lanes[0].intervals.filter((i) => i.state === 'firing')
  assertEquals(firing.map((i) => [i.start, i.end]), [[100_000, 280_000], [600_000, 600_000]])
  assertEquals(lanes[0].intervals.filter((i) => i.state === 'pending').length, 1)
})

Deno.test('receiver + inhibit helpers', () => {
  assertEquals(receiverIntegrations({ name: 'x', slack_configs: [{}, {}], email_configs: [], webhook_configs: [{}] }), ['slack ×2', 'webhook'])
  const s = inhibitSides({ source_matchers: ['severity="critical"'], target_match: { severity: 'warning' }, equal: ['namespace'] })
  assertEquals(s, { source: ['severity="critical"'], target: ['severity="warning"'], equal: ['namespace'] })
})

Deno.test('since formats durations', () => {
  const now = Date.parse('2026-10-17T12:00:00Z')
  assertEquals(since('2026-10-17T10:55:00Z', now), '1h 5m')
  assertEquals(since('2026-10-15T11:00:00Z', now), '2d 1h')
  assertEquals(since('nope', now), '—')
})
