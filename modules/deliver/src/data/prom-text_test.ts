import { assertEquals } from 'jsr:@std/assert'
import { groupBy, parsePrometheusText, series, total } from './prom-text.ts'

/** Real lines from `tetragon:2112/metrics`, trimmed. */
const METRICS = `
# HELP tetragon_events_total The total number of Tetragon events
# TYPE tetragon_events_total counter
tetragon_build_info{commit="",go_version="go1.26.7",version="v1.7.1"} 1
tetragon_events_total{binary="/app/gitea/gitea",namespace="adhar-system",pod="gitea-cd5f548cf-65cc4",type="PROCESS_EXEC",workload="gitea"} 41
tetragon_events_total{binary="/app/gitea/gitea",namespace="adhar-system",pod="gitea-cd5f548cf-65cc4",type="PROCESS_EXIT",workload="gitea"} 64
tetragon_events_total{binary="/azurediskplugin",namespace="kube-system",pod="csi-azuredisk-node-vz5dj",type="PROCESS_EXEC",workload="csi-azuredisk-node"} 1
tetragon_events_total{binary="/var/lib/dpkg/info/policykit-1.postinst",namespace="",pod="",type="PROCESS_EXEC",workload=""} 1
tetragon_missed_link_probes_total{attach="acct_process",policy="__base__"} 0
tetragon_errors_total{error="process_pid_tid_mismatch_exec"} 3
`

Deno.test('a labelled counter is read into name, labels and value', () => {
  const s = parsePrometheusText(METRICS)
  const gitea = s.find((x) => x.labels.type === 'PROCESS_EXEC' && x.labels.workload === 'gitea')!
  assertEquals(gitea.name, 'tetragon_events_total')
  assertEquals(gitea.value, 41)
  assertEquals(gitea.labels.namespace, 'adhar-system')
  assertEquals(gitea.labels.binary, '/app/gitea/gitea')
})

Deno.test('HELP and TYPE comments are not samples', () => {
  assertEquals(parsePrometheusText(METRICS).some((s) => s.name.startsWith('#')), false)
  assertEquals(series(parsePrometheusText(METRICS), 'tetragon_events_total').length, 4)
})

Deno.test('a metric with no labels still parses', () => {
  const s = parsePrometheusText('go_goroutines 42')
  assertEquals(s, [{ name: 'go_goroutines', labels: {}, value: 42 }])
})

/** The format allows a trailing millisecond timestamp; the value is first. */
Deno.test('a trailing timestamp is ignored, not read as the value', () => {
  const s = parsePrometheusText('http_requests_total{code="200"} 1027 1395066363000')
  assertEquals(s[0].value, 1027)
})

Deno.test('escaped quotes, backslashes and newlines survive a label value', () => {
  const s = parsePrometheusText('m{cmd="sh -c \\"echo hi\\"",path="C:\\\\tmp",note="a\\nb"} 1')
  assertEquals(s[0].labels.cmd, 'sh -c "echo hi"')
  assertEquals(s[0].labels.path, 'C:\\tmp')
  assertEquals(s[0].labels.note, 'a\nb')
})

/** A container argv in a label routinely contains a comma and an equals sign. */
Deno.test('a comma or equals inside a value does not split the labels', () => {
  const s = parsePrometheusText('m{argv="-c max_connections=1024,foo",type="X"} 7')
  assertEquals(s[0].labels.argv, '-c max_connections=1024,foo')
  assertEquals(s[0].labels.type, 'X')
  assertEquals(s[0].value, 7)
})

Deno.test('the special values the format spells out are read', () => {
  assertEquals(parsePrometheusText('m +Inf')[0].value, Infinity)
  assertEquals(parsePrometheusText('m -Inf')[0].value, -Infinity)
  // NaN is a real reading but cannot be summed, so it is dropped.
  assertEquals(parsePrometheusText('m NaN').length, 0)
})

Deno.test('a blank or malformed line is skipped rather than fatal', () => {
  assertEquals(parsePrometheusText(''), [])
  assertEquals(parsePrometheusText('\n\n   \n'), [])
  assertEquals(parsePrometheusText('no_value_here'), [])
  assertEquals(parsePrometheusText('broken{unclosed="x" 1'), [])
})

Deno.test('totals add a metric up, with and without a predicate', () => {
  const s = parsePrometheusText(METRICS)
  assertEquals(total(s, 'tetragon_events_total'), 107)
  assertEquals(total(s, 'tetragon_events_total', (l) => l.type === 'PROCESS_EXEC'), 43)
  assertEquals(total(s, 'tetragon_events_total', (l) => l.namespace === 'adhar-system'), 105)
  assertEquals(total(s, 'nothing_by_this_name'), 0)
})

/**
 * Tetragon reports host processes with an empty namespace label. An empty
 * string is not a namespace and must not appear in a ranked list as one.
 */
Deno.test('grouping ranks by total and skips samples with no such label', () => {
  const s = parsePrometheusText(METRICS)
  assertEquals(groupBy(s, 'tetragon_events_total', 'namespace'), [
    { name: 'adhar-system', count: 105 },
    { name: 'kube-system', count: 1 },
  ])
  assertEquals(groupBy(s, 'tetragon_events_total', 'type'), [
    { name: 'PROCESS_EXIT', count: 64 },
    { name: 'PROCESS_EXEC', count: 43 },
  ])
  assertEquals(groupBy(s, 'tetragon_events_total', 'namespace', 1).length, 1)
})

Deno.test('the agent version comes off the build-info sample', () => {
  const s = parsePrometheusText(METRICS)
  assertEquals(series(s, 'tetragon_build_info')[0].labels.version, 'v1.7.1')
})
