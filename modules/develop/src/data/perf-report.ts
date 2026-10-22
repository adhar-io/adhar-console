/**
 * The downloadable Performance Report: one self-contained HTML document per
 * application, built from its readiness report (perf-readiness.ts).
 *
 * It explains rather than lists. Every observation says what was measured,
 * why it matters and what to do about it, and the recommendations are ranked
 * so a team can work top-down. It adds no data of its own: observations are
 * derived only from what the platform scorer recorded, and a measurement that
 * was never taken is reported as missing, with how to get it.
 *
 * The document has no external assets (inline CSS and SVG), so it opens
 * offline, attaches to a change record as-is, and prints to A4 / PDF cleanly.
 *
 * Pure: no React, no DOM.
 */

import { fmtGauge, type Gauge, type ReadinessReport, type Tone } from './perf-readiness.ts'

export type Priority = 'high' | 'medium' | 'low'

export interface Finding {
  area: 'Load test' | 'Live service levels' | 'Resilience' | 'Workload design' | 'Team evidence'
  tone: Tone
  title: string
  /** What was observed — numbers included. */
  observation: string
  /** Why it matters. */
  explanation: string
  /** What to do; absent when nothing needs doing. */
  recommendation?: string
  /** An optional config snippet that implements the recommendation. */
  snippet?: string
  priority?: Priority
}

/* ─────────────────────────── signal guidance ─────────────────────────── */

interface Guidance {
  area: Finding['area']
  priority: Priority
  why: string
  fix: string
  snippet?: string
}

const GUIDANCE: Record<string, Guidance> = {
  load_test: {
    area: 'Load test',
    priority: 'high',
    why: 'The hourly k6 test is the platform\'s early warning: a service that misses its targets in test will miss them in production under the same load.',
    fix: 'Profile the slowest endpoints under load (traces in Discover show where time goes), check for CPU throttling against the container limit, add caching or batch database calls on hot paths, and raise replicas or the HPA ceiling if the service is simply saturated.',
  },
  latency_slo: {
    area: 'Live service levels',
    priority: 'high',
    why: 'Users feel p95 latency directly. Missing it over a full day means a real share of requests are slow, not a one-off spike.',
    fix: 'Compare the slow window against deploys and traffic in Discover. Look for slow downstream calls (database, external APIs) in traces, add timeouts, and scale out if latency tracks request volume.',
  },
  error_budget: {
    area: 'Live service levels',
    priority: 'high',
    why: '5xx responses above the budget mean the availability target is being missed; at this rate the budget for the period runs out early.',
    fix: 'Group the 5xx responses by route and status in the logs, fix the top cause first, and freeze risky releases until the ratio is back under budget.',
  },
  perf_center_gate: {
    area: 'Team evidence',
    priority: 'medium',
    why: 'The team\'s own Performance Center gate encodes the budgets and baseline the team agreed to; a failed gate is a known regression.',
    fix: 'Open the latest run in Performance Center, read the gate reasons (budget or baseline regression), and compare with the last passing run to find the change that caused it.',
  },
  chaos_pod_delete: {
    area: 'Resilience',
    priority: 'high',
    why: 'Pods are deleted routinely (deploys, node upgrades, evictions). If killing one interrupts service, every ordinary cluster operation is an outage.',
    fix: 'Run at least two replicas, give the container a readiness probe so traffic only reaches ready pods, and add a PodDisruptionBudget.',
    snippet: 'spec:\n  replicas: 2\n  template:\n    spec:\n      containers:\n        - name: app\n          readinessProbe:\n            httpGet: { path: /healthz, port: http }\n            periodSeconds: 5',
  },
  chaos_network_latency: {
    area: 'Resilience',
    priority: 'medium',
    why: 'Networks slow down. A service without timeouts holds connections open until it runs out of workers, turning a slow dependency into a full outage.',
    fix: 'Set explicit client timeouts on every outbound call, retry idempotent calls with backoff, and add a circuit breaker around slow dependencies.',
  },
  chaos_cpu_stress: {
    area: 'Resilience',
    priority: 'medium',
    why: 'Under CPU saturation the service should slow down gracefully, not fail health checks and restart in a loop.',
    fix: 'Set CPU requests to the real steady-state usage, scale on CPU with an HPA, and make sure liveness probes are not so tight that a busy pod is killed.',
  },
  chaos_gameday: {
    area: 'Team evidence',
    priority: 'medium',
    why: 'A failed game day is a failure mode the team has seen with its own eyes and not yet fixed.',
    fix: 'Re-read the game day\'s probe results, fix the weakest path it exposed, and re-run the same experiment to confirm.',
  },
  recovery_time: {
    area: 'Resilience',
    priority: 'medium',
    why: 'Slow recovery stretches every incident: the longer a replacement pod takes to become ready, the longer capacity is reduced.',
    fix: 'Shorten start-up (smaller image, lazy initialisation, warm caches in the background), tune the readiness probe\'s initial delay and period, and keep spare replicas so one restart does not drop capacity.',
  },
  replicas_ha: {
    area: 'Workload design',
    priority: 'high',
    why: 'A single replica is a single point of failure: any restart, deploy or node drain takes the service down.',
    fix: 'Run at least two replicas in every environment that serves real traffic.',
    snippet: 'spec:\n  replicas: 2',
  },
  pod_disruption_budget: {
    area: 'Workload design',
    priority: 'medium',
    why: 'Without a PodDisruptionBudget a node drain may evict every replica at once.',
    fix: 'Add a PodDisruptionBudget that keeps at least one pod available.',
    snippet: 'apiVersion: policy/v1\nkind: PodDisruptionBudget\nmetadata:\n  name: <app>\nspec:\n  minAvailable: 1\n  selector:\n    matchLabels:\n      app: <app>',
  },
  autoscaling: {
    area: 'Workload design',
    priority: 'medium',
    why: 'A fixed replica count is either too many (cost) or too few (latency at peak). An autoscaler follows the load.',
    fix: 'Add a HorizontalPodAutoscaler on CPU (or request rate) with a floor of two replicas.',
    snippet: 'apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata:\n  name: <app>\nspec:\n  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: <app> }\n  minReplicas: 2\n  maxReplicas: 6\n  metrics:\n    - type: Resource\n      resource: { name: cpu, target: { type: Utilization, averageUtilization: 70 } }',
  },
  spread_across_nodes: {
    area: 'Workload design',
    priority: 'medium',
    why: 'Replicas on the same node fail together when that node goes away.',
    fix: 'Add a topology spread constraint so replicas land on different nodes.',
    snippet: 'topologySpreadConstraints:\n  - maxSkew: 1\n    topologyKey: kubernetes.io/hostname\n    whenUnsatisfiable: ScheduleAnyway\n    labelSelector:\n      matchLabels: { app: <app> }',
  },
  graceful_shutdown: {
    area: 'Workload design',
    priority: 'medium',
    why: 'Without a drain, a pod stops while requests are still routed to it, so every deploy drops a few requests.',
    fix: 'Add a short preStop sleep so endpoints update before the process stops, handle SIGTERM by finishing in-flight requests, and keep terminationGracePeriodSeconds above the drain time.',
    snippet: 'lifecycle:\n  preStop:\n    exec: { command: ["sleep", "10"] }\nterminationGracePeriodSeconds: 30',
  },
  restart_stability: {
    area: 'Workload design',
    priority: 'high',
    why: 'Crash-looping containers serve errors while they restart and hide the real failure behind back-off.',
    fix: 'Read the previous container\'s logs and its termination reason. OOMKilled means the memory limit is too low or memory leaks; a failing liveness probe may be too aggressive for start-up.',
  },
  progressive_delivery: {
    area: 'Workload design',
    priority: 'low',
    why: 'A canary or blue-green rollout exposes a bad release to a slice of traffic and rolls it back automatically, instead of to everyone at once.',
    fix: 'Deliver the service with an Argo Rollouts canary strategy and an analysis step on error rate and latency.',
  },
}

const PRIORITY_ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 }

/* ─────────────────────────── findings ─────────────────────────── */

function gaugeBy(list: Gauge[], label: string): Gauge | undefined {
  return list.find((g) => g.label === label)
}

/** Every observation the report makes, derived only from the scorer's evidence. */
export function reportFindings(r: ReadinessReport): Finding[] {
  const out: Finding[] = []

  // Load test.
  const p95 = gaugeBy(r.load, 'p95 latency')
  const p99 = gaugeBy(r.load, 'p99 latency')
  const err = gaugeBy(r.load, 'Error rate')
  const rps = gaugeBy(r.load, 'Throughput')
  if (r.loadTone === 'none' && p95?.value === undefined) {
    out.push({
      area: 'Load test',
      tone: 'none',
      title: 'No automated load test result yet',
      observation: r.pending ? `The automated load test is pending: ${r.pending}.` : 'The resilience runner has not load-tested this application yet.',
      explanation: 'Without a load test there is no evidence of how the service behaves under traffic, so the performance grade rests on live metrics alone.',
      recommendation: 'Deploy the application to its test environment; the platform load-tests every delivered application hourly and the result appears here.',
      priority: 'medium',
    })
  } else if (p95?.value !== undefined) {
    const headroom = p95.target ? Math.round((1 - p95.value / p95.target) * 100) : undefined
    out.push({
      area: 'Load test',
      tone: p95.tone,
      title: p95.tone === 'bad' ? 'p95 latency is over target under load' : 'p95 latency is within target under load',
      observation: `p95 latency was ${fmtGauge(p95)}${p95.target ? ` against a target of ${fmtGauge({ value: p95.target, unit: 'ms' })}` : ''}` +
        `${rps?.value !== undefined ? ` at ${fmtGauge(rps)}` : ''}${rps?.note ? ` (${rps.note})` : ''}.` +
        (headroom !== undefined ? (headroom >= 0 ? ` That leaves ${headroom}% headroom.` : ` That is ${-headroom}% over target.`) : ''),
      explanation: p95.tone === 'bad'
        ? '95 in every 100 requests should finish within the target. Missing it under test load means users will see slow responses at similar traffic in production.'
        : headroom !== undefined && headroom < 20
        ? 'It passes, but with little headroom: modest traffic growth or a slower dependency would push it over.'
        : 'Latency under the test load is comfortably inside the target.',
      ...(p95.tone === 'bad'
        ? { recommendation: GUIDANCE.load_test.fix, priority: 'high' as const }
        : headroom !== undefined && headroom < 20
        ? { recommendation: 'Watch the trend over the next releases and profile the slowest endpoint before traffic grows.', priority: 'low' as const }
        : {}),
    })
    if (p99?.value !== undefined && p95.value > 0 && p99.value / p95.value >= 2) {
      out.push({
        area: 'Load test',
        tone: 'warn',
        title: 'Long latency tail',
        observation: `p99 latency (${fmtGauge(p99)}) is ${(p99.value / p95.value).toFixed(1)}× the p95 (${fmtGauge(p95)}).`,
        explanation: 'A tail this long usually means a few requests wait on something the rest do not: lock contention, garbage-collection pauses, a cold cache or a slow downstream call.',
        recommendation: 'Find the slowest traces in Discover for the test window and look at what they have in common; check GC pauses and connection-pool waits.',
        priority: 'medium',
      })
    }
  }
  if (err?.value !== undefined) {
    out.push({
      area: 'Load test',
      tone: err.tone === 'none' ? (err.value > 0 ? 'warn' : 'good') : err.tone,
      title: err.tone === 'bad' ? 'Error rate over threshold under load' : err.value > 0 ? 'Some errors under load' : 'No errors under load',
      observation: `${fmtGauge(err)} of requests failed${err.target !== undefined ? ` (threshold ${fmtGauge({ value: err.target, unit: '%' })})` : ''}.`,
      explanation: err.tone === 'bad'
        ? 'Failures under load usually point at exhausted resources — connection pools, file handles, memory — or timeouts in a dependency.'
        : err.value > 0
        ? 'Within the threshold, but any failure under a steady test load is worth understanding before it grows.'
        : 'Every request in the test succeeded.',
      ...(err.tone === 'bad'
        ? { recommendation: 'Read the application logs for the test window, group failures by route and error, and check pool sizes and dependency timeouts.', priority: 'high' as const }
        : {}),
    })
  }

  // Live service levels.
  if (!r.slo.length) {
    out.push({
      area: 'Live service levels',
      tone: 'none',
      title: 'No live request metrics',
      observation: 'Prometheus has no HTTP request metrics for this service yet.',
      explanation: 'Live latency and error ratios are the only evidence of what users actually experience; without them the report covers test conditions only.',
      recommendation: 'Export HTTP request metrics (request count and a latency histogram by route and status) and make sure the service is scraped.',
      priority: 'medium',
    })
  } else {
    for (const g of r.slo) {
      if (g.value === undefined) continue
      const isLatency = g.label.startsWith('p95')
      out.push({
        area: 'Live service levels',
        tone: g.tone === 'none' ? 'good' : g.tone,
        title: isLatency
          ? g.tone === 'bad' ? 'Live p95 latency is over target' : 'Live p95 latency is within target'
          : g.tone === 'bad' ? 'Live 5xx ratio is over the error budget' : 'Live 5xx ratio is within the error budget',
        observation: `${g.label}${r.sloEnvironment ? ` in ${r.sloEnvironment}` : ''}: ${fmtGauge(g)}${g.target !== undefined ? ` against ${fmtGauge({ value: g.target, unit: g.unit })}` : ''}${g.note ? ` (${g.note})` : ''}.`,
        explanation: g.tone === 'bad'
          ? (isLatency ? GUIDANCE.latency_slo.why : GUIDANCE.error_budget.why)
          : 'Users are getting the service level the target promises.',
        ...(g.tone === 'bad'
          ? { recommendation: isLatency ? GUIDANCE.latency_slo.fix : GUIDANCE.error_budget.fix, priority: 'high' as const }
          : {}),
      })
    }
  }

  // Chaos.
  if (!r.chaos.length) {
    out.push({
      area: 'Resilience',
      tone: 'none',
      title: 'No chaos experiment has run',
      observation: 'The chaos suite has not run against this application yet.',
      explanation: 'Until failure is injected, there is no evidence the service survives a pod loss, a slow network or a saturated CPU.',
      recommendation: 'Keep the application deployed to its test environment; the resilience runner includes it in the next hourly suite. Or run a game day from Performance Center.',
      priority: 'medium',
    })
  }
  for (const c of r.chaos) {
    const ok = c.tone === 'good'
    const signal = c.experiment === 'pod-delete' ? 'chaos_pod_delete' : c.experiment === 'pod-network-latency' ? 'chaos_network_latency' : c.experiment === 'pod-cpu-hog' ? 'chaos_cpu_stress' : undefined
    const g = signal ? GUIDANCE[signal] : undefined
    out.push({
      area: 'Resilience',
      tone: c.tone,
      title: `${c.title}: ${ok ? 'kept serving' : c.status}`,
      observation: `Experiment ${c.experiment} ${c.status}` +
        (c.probePct !== undefined ? `; the steady-state probe was up ${c.probePct}% of the time` : '') +
        (c.recoverySeconds !== undefined ? `; it recovered in ${c.recoverySeconds}s` : '') +
        `.${c.detail ? ` ${c.detail}` : ''}`,
      explanation: ok ? 'The service stayed available while the fault was injected.' : g?.why ?? 'The service did not stay healthy while this fault was injected.',
      ...(!ok && c.tone !== 'none' ? { recommendation: g?.fix ?? 'Re-run the experiment from Performance Center and inspect the probe and pod events during the fault.', snippet: g?.snippet, priority: g?.priority ?? 'medium' } : {}),
    })
  }

  // Team evidence.
  if (r.perfCenter) {
    const pc = r.perfCenter
    out.push({
      area: 'Team evidence',
      tone: pc.tone,
      title: `Performance Center gate: ${pc.verdict}`,
      observation: `Latest run of "${pc.test}"${pc.trigger ? ` (${pc.trigger})` : ''}${pc.at ? ` on ${pc.at.slice(0, 10)}` : ''}: ${pc.verdict}.` +
        `${pc.reasons ? ` Reasons: ${pc.reasons}.` : ''} ${pc.count} result${pc.count === 1 ? '' : 's'} across ${pc.tests.join(', ')}.`,
      explanation: pc.tone === 'bad'
        ? GUIDANCE.perf_center_gate.why
        : pc.tone === 'good'
        ? 'The team\'s own performance budgets and baseline hold.'
        : 'No run of this test has been judged against its gate yet, so it neither passes nor fails the service.',
      ...(pc.tone === 'bad' ? { recommendation: GUIDANCE.perf_center_gate.fix, priority: 'medium' as const } : {}),
    })
  } else {
    out.push({
      area: 'Team evidence',
      tone: 'none',
      title: 'No Performance Center test targets this service',
      observation: 'None of the team\'s Performance Center tests is aimed at this application.',
      explanation: 'The automated test uses generic traffic. A team test exercises the journeys that matter and gates releases on agreed budgets and a baseline.',
      recommendation: `Create a Performance Center test with the target selector app=${r.app}, set budgets for its key journeys, and run it on every release.`,
      priority: 'low',
    })
  }
  if (r.gameDay) {
    const gd = r.gameDay
    out.push({
      area: 'Team evidence',
      tone: gd.tone,
      title: `Game day: ${gd.verdict}`,
      observation: `Latest game day "${gd.experiment}"${gd.at ? ` on ${gd.at.slice(0, 10)}` : ''}: ${gd.verdict}${gd.probe ? `, probe ${gd.probe}%` : ''}. ${gd.count} fault run${gd.count === 1 ? '' : 's'}: ${gd.experiments.join(', ')}.`,
      explanation: gd.tone === 'bad' ? GUIDANCE.chaos_gameday.why : 'The service held up in the team\'s own failure rehearsal.',
      ...(gd.tone === 'bad' ? { recommendation: GUIDANCE.chaos_gameday.fix, priority: 'medium' as const } : {}),
    })
  }

  // Workload design: failing checks not already covered above.
  const covered = new Set(['load_test', 'latency_slo', 'error_budget', 'perf_center_gate', 'chaos_pod_delete', 'chaos_network_latency', 'chaos_cpu_stress', 'chaos_gameday'])
  for (const s of r.signals) {
    if (covered.has(s.name) || !s.applicable || s.passed) continue
    const g = GUIDANCE[s.name]
    out.push({
      area: g?.area ?? 'Workload design',
      tone: 'bad',
      title: `Not met: ${s.label}`,
      observation: s.detail ?? 'The scorer found this check not met.',
      explanation: g?.why ?? 'This check counts toward the readiness grade.',
      recommendation: g?.fix ?? 'Open the scorecard for this application for the check\'s details.',
      snippet: g?.snippet?.replaceAll('<app>', r.app),
      priority: g?.priority ?? 'medium',
    })
  }
  return out.map((f) => (f.snippet ? { ...f, snippet: f.snippet.replaceAll('<app>', r.app) } : f))
}

/** Recommendations, most important first. */
export function recommendations(findings: Finding[]): Finding[] {
  return findings
    .filter((f) => f.recommendation)
    .sort((a, b) => PRIORITY_ORDER[a.priority ?? 'medium'] - PRIORITY_ORDER[b.priority ?? 'medium'])
}

/* ─────────────────────────── HTML ─────────────────────────── */

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const TONE_COLOR: Record<Tone, string> = { good: '#059669', bad: '#e11d48', warn: '#d97706', none: '#64748b' }
const TONE_LABEL: Record<Tone, string> = { good: 'Pass', bad: 'Fail', warn: 'Watch', none: 'No data' }
const GRADE_COLOR: Record<string, string> = { A: '#059669', B: '#65a30d', C: '#d97706', D: '#ea580c', F: '#e11d48' }

function scoreTone(v: number | null): Tone {
  if (v === null) return 'none'
  return v >= 80 ? 'good' : v >= 60 ? 'warn' : 'bad'
}

function ring(label: string, value: number | null): string {
  const c = 2 * Math.PI * 30
  const pct = value ?? 0
  return `<div class="ring"><svg width="76" height="76" viewBox="0 0 76 76" role="img" aria-label="${esc(label)} ${value ?? 'n/a'}">
<circle cx="38" cy="38" r="30" fill="none" stroke="#e2e8f0" stroke-width="7"/>
<circle cx="38" cy="38" r="30" fill="none" stroke="${TONE_COLOR[scoreTone(value)]}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${((c * pct) / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 38 38)"/>
<text x="38" y="43" text-anchor="middle" font-size="17" font-weight="700" fill="#0f172a">${value ?? 'n/a'}</text></svg><span>${esc(label)}</span></div>`
}

function metricRow(g: Gauge): string {
  const target = g.target !== undefined ? `${g.lowerIsBetter ? '≤' : '≥'} ${esc(fmtGauge({ value: g.target, unit: g.unit }))}` : '—'
  const tone: Tone = g.value === undefined ? 'none' : g.tone
  const bar = g.value === undefined ? '' : `<div class="bar"><i style="width:${Math.round(g.fill * 100)}%;background:${TONE_COLOR[g.tone === 'none' ? 'none' : g.tone]}"></i>${g.target !== undefined ? '<b style="left:66.7%"></b>' : ''}</div>`
  return `<tr><td>${esc(g.label)}${g.note ? `<div class="sub">${esc(g.note)}</div>` : ''}</td><td class="num">${esc(fmtGauge(g))}${bar}</td><td class="num">${target}</td><td>${g.target !== undefined || g.value === undefined ? pill(tone) : '<span class="muted">info</span>'}</td></tr>`
}

function pill(t: Tone, text = TONE_LABEL[t]): string {
  return `<span class="pill" style="color:${TONE_COLOR[t]};border-color:${TONE_COLOR[t]}33;background:${TONE_COLOR[t]}12">${esc(text)}</span>`
}

const PRIORITY_COLOR: Record<Priority, string> = { high: '#e11d48', medium: '#d97706', low: '#0284c7' }

export interface ReportMeta {
  generatedAt: string
  /** Who downloaded it, when known. */
  generatedBy?: string
  /** The console origin, for links back. */
  consoleUrl?: string
}

/** The full report as a standalone HTML document. */
export function reportHtml(r: ReadinessReport, meta: ReportMeta): string {
  const findings = reportFindings(r)
  const recs = recommendations(findings)
  const counts = {
    good: findings.filter((f) => f.tone === 'good').length,
    bad: findings.filter((f) => f.tone === 'bad').length,
    warn: findings.filter((f) => f.tone === 'warn').length,
    none: findings.filter((f) => f.tone === 'none').length,
  }
  const applicable = r.signals.filter((s) => s.applicable)
  const passed = applicable.filter((s) => s.passed).length
  const generated = new Date(meta.generatedAt)
  const genText = Number.isNaN(generated.getTime()) ? meta.generatedAt : generated.toUTCString().replace(' GMT', ' UTC')
  const areas: Finding['area'][] = ['Load test', 'Live service levels', 'Resilience', 'Workload design', 'Team evidence']
  const high = recs.filter((f) => f.priority === 'high').length

  const headline = r.grade === 'A' || r.grade === 'B'
    ? `${esc(r.app)} is production-ready on performance and resilience${counts.bad ? `, with ${counts.bad} issue${counts.bad === 1 ? '' : 's'} to address` : ''}.`
    : `${esc(r.app)} is not yet production-ready: ${counts.bad} issue${counts.bad === 1 ? '' : 's'} need${counts.bad === 1 ? 's' : ''} attention${high ? `, ${high} of them high priority` : ''}.`

  const findingCard = (f: Finding) => `<div class="finding" style="border-left-color:${TONE_COLOR[f.tone]}">
<div class="fhead"><h4>${esc(f.title)}</h4>${pill(f.tone)}</div>
<p><strong>Observation.</strong> ${esc(f.observation)}</p>
<p><strong>What it means.</strong> ${esc(f.explanation)}</p>
${f.recommendation ? `<p class="rec"><strong>Recommendation.</strong> ${esc(f.recommendation)}</p>` : ''}
</div>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Performance Report — ${esc(r.app)}</title>
<style>
:root{--ink:#0f172a;--muted:#475569;--subtle:#94a3b8;--line:#e2e8f0;--soft:#f8fafc;--brand:#4f46e5}
*{box-sizing:border-box}
body{margin:0;background:#f1f5f9;color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:960px;margin:32px auto;background:#fff;border-radius:16px;box-shadow:0 1px 3px #0f172a14,0 12px 32px #0f172a0f;overflow:hidden}
.cover{background:linear-gradient(135deg,#1e1b4b 0%,#4338ca 55%,#6366f1 100%);color:#fff;padding:36px 40px 30px}
.eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;opacity:.75;font-weight:600}
.cover h1{margin:6px 0 4px;font-size:30px;letter-spacing:-.01em}
.cover .meta{font-size:12.5px;opacity:.85}
.cover .meta code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:#ffffff1f;padding:1px 6px;border-radius:4px}
.hero{display:flex;flex-wrap:wrap;align-items:center;gap:28px;margin-top:24px}
.grade{width:84px;height:84px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:40px;font-weight:800;color:#fff;box-shadow:0 0 0 6px #ffffff2e}
.score{font-size:13px;opacity:.9}.score b{display:block;font-size:30px;letter-spacing:-.02em}
.rings{display:flex;gap:18px;margin-left:auto;background:#fff;border-radius:14px;padding:12px 16px}
.ring{display:flex;flex-direction:column;align-items:center;font-size:11.5px;color:var(--muted);gap:2px}
main{padding:8px 40px 36px}
section{margin-top:28px;break-inside:avoid-page}
h2{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--brand);margin:0 0 12px;display:flex;align-items:center;gap:10px}
h2::after{content:"";flex:1;height:1px;background:var(--line)}
h3{font-size:15px;margin:18px 0 8px}
.summary{font-size:16px;line-height:1.6;margin:0 0 14px}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.kpi{border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:var(--soft)}
.kpi b{display:block;font-size:22px;letter-spacing:-.01em}.kpi span{font-size:11.5px;color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--subtle);font-weight:600;padding:8px 10px;border-bottom:1px solid var(--line)}
td{padding:9px 10px;border-bottom:1px solid #f1f5f9;vertical-align:top}
td.num{font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;white-space:nowrap}
.sub{font-size:11px;color:var(--subtle)}
.muted{color:var(--subtle);font-size:12px}
.bar{position:relative;height:5px;border-radius:99px;background:#eef2f7;margin-top:5px;width:120px;overflow:visible}
.bar i{display:block;height:100%;border-radius:99px}.bar b{position:absolute;top:-2px;width:1.5px;height:9px;background:var(--ink)}
.pill{display:inline-block;font-size:11px;font-weight:600;border:1px solid;border-radius:99px;padding:1px 8px;white-space:nowrap}
.finding{border:1px solid var(--line);border-left:4px solid;border-radius:10px;padding:12px 14px;margin:10px 0;break-inside:avoid}
.finding p{margin:5px 0;color:#334155;font-size:13px}
.fhead{display:flex;justify-content:space-between;gap:12px;align-items:baseline}.fhead h4{margin:0;font-size:14px}
.rec{background:#eef2ff;border-radius:8px;padding:8px 10px;color:#312e81!important}
ol.recs{padding:0;margin:0;list-style:none;counter-reset:r}
ol.recs li{counter-increment:r;display:grid;grid-template-columns:30px 1fr;gap:10px;padding:12px 0;border-bottom:1px solid #f1f5f9;break-inside:avoid}
ol.recs li::before{content:counter(r);width:26px;height:26px;border-radius:50%;background:var(--ink);color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center}
.prio{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-right:6px}
pre{background:#0f172a;color:#e2e8f0;border-radius:8px;padding:10px 12px;font-size:11.5px;overflow:auto;margin:8px 0 0}
.checks{display:grid;grid-template-columns:1fr 1fr;gap:6px 22px}
.check{display:flex;gap:8px;font-size:12.5px;padding:4px 0}.check i{width:9px;height:9px;border-radius:50%;margin-top:6px;flex:none}
.check small{display:block;color:var(--muted)}
.note{font-size:12px;color:var(--muted)}
footer{padding:16px 40px 24px;border-top:1px solid var(--line);font-size:11.5px;color:var(--subtle);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
@media (max-width:720px){.cover,main,footer{padding-left:18px;padding-right:18px}.kpis{grid-template-columns:repeat(2,1fr)}.checks{grid-template-columns:1fr}.rings{margin-left:0}.page{margin:0;border-radius:0}}
@media print{body{background:#fff}.page{margin:0;box-shadow:none;border-radius:0;max-width:none}@page{size:A4;margin:14mm}section{break-inside:auto}}
</style>
</head>
<body>
<div class="page">
<header class="cover">
<div class="eyebrow">Adhar · Performance &amp; Resilience Report</div>
<h1>${esc(r.app)}</h1>
<div class="meta">
${r.gradedOn ? `Graded on <code>${esc(r.gradedOn)}</code> · ` : ''}${r.testedIn ? `tested in <code>${esc(r.testedIn)}</code>` : 'not load-tested yet'}${r.testedAt ? ` · ${esc(r.testedAt.slice(0, 16).replace('T', ' '))} UTC` : ''}
${r.image ? `<br>Image <code>${esc(r.image)}</code>` : ''}
</div>
<div class="hero">
<div class="grade" style="background:${GRADE_COLOR[r.grade] ?? '#64748b'}">${esc(r.grade)}</div>
<div class="score"><b>${r.score}/100</b>production readiness</div>
<div class="rings">${ring('Performance', r.performanceScore)}${ring('Resilience', r.resilienceScore)}</div>
</div>
</header>
<main>

<section>
<h2>Executive summary</h2>
<p class="summary">${headline}</p>
<p class="note">${esc(r.verdict)}</p>
<div class="kpis">
<div class="kpi"><b style="color:${TONE_COLOR.good}">${passed}/${applicable.length}</b><span>readiness checks passing</span></div>
<div class="kpi"><b style="color:${TONE_COLOR.bad}">${counts.bad}</b><span>issues found</span></div>
<div class="kpi"><b style="color:${TONE_COLOR.warn}">${counts.warn}</b><span>to watch</span></div>
<div class="kpi"><b style="color:${PRIORITY_COLOR.high}">${high}</b><span>high-priority actions</span></div>
</div>
</section>

<section>
<h2>Key measurements</h2>
<h3>Automated load test ${pill(r.loadTone, r.loadStatus)}</h3>
<p class="note">k6 against ${esc(r.target ?? 'the application Service')}${r.testedIn ? ` in ${esc(r.testedIn)}` : ''}, run hourly by the platform's resilience runner. The marker on each bar is the target.</p>
<table><thead><tr><th>Metric</th><th>Measured</th><th>Target</th><th>Result</th></tr></thead><tbody>
${r.load.map(metricRow).join('\n')}
</tbody></table>
${r.slo.length ? `<h3>Live service levels</h3>
<p class="note">From Prometheus request metrics over the last 24 hours${r.sloEnvironment ? ` in ${esc(r.sloEnvironment)}` : ''}.</p>
<table><thead><tr><th>Metric</th><th>Measured</th><th>Target</th><th>Result</th></tr></thead><tbody>
${r.slo.map(metricRow).join('\n')}
</tbody></table>` : ''}
${r.chaos.length ? `<h3>Chaos suite</h3>
<p class="note">Litmus experiments under a continuous steady-state probe.</p>
<table><thead><tr><th>Fault</th><th>Probe up</th><th>Recovery</th><th>Result</th></tr></thead><tbody>
${r.chaos.map((c) => `<tr><td>${esc(c.title)}<div class="sub">${esc(c.experiment)}</div></td><td class="num">${c.probePct !== undefined ? `${c.probePct}%` : '—'}</td><td class="num">${c.recoverySeconds !== undefined ? `${c.recoverySeconds}s` : '—'}</td><td>${pill(c.tone, c.status)}</td></tr>`).join('\n')}
</tbody></table>` : ''}
</section>

<section>
<h2>Observations</h2>
${areas.map((a) => {
    const list = findings.filter((f) => f.area === a)
    return list.length ? `<h3>${esc(a)}</h3>${list.map(findingCard).join('\n')}` : ''
  }).join('\n')}
</section>

<section>
<h2>Recommendations</h2>
${recs.length
    ? `<ol class="recs">${recs.map((f) => `<li><div><span class="prio" style="color:${PRIORITY_COLOR[f.priority ?? 'medium']}">${esc(f.priority ?? 'medium')}</span><strong>${esc(f.title)}</strong>
<div class="note" style="margin-top:3px">${esc(f.recommendation)}</div>${f.snippet ? `<pre>${esc(f.snippet)}</pre>` : ''}</div></li>`).join('\n')}</ol>`
    : '<p class="note">Nothing to do: every applicable check passes and every measurement is within target.</p>'}
</section>

<section>
<h2>All readiness checks</h2>
<div class="checks">
${r.signals.map((s) => `<div class="check"><i style="background:${!s.applicable ? '#cbd5e1' : s.passed ? TONE_COLOR.good : TONE_COLOR.bad}"></i><div>${esc(s.label)}<small>${!s.applicable ? 'Not applicable — ' : ''}${esc(s.detail ?? (s.passed ? 'Pass' : 'Not met'))}</small></div></div>`).join('\n')}
</div>
</section>

<section>
<h2>How this report was produced</h2>
<p class="note">Every number comes from the Adhar platform scorer, which joins the resilience runner's automated k6 load test and Litmus chaos suite (run hourly in the test environment, never production), live 24-hour service levels from Prometheus, the team's Performance Center gates and game days, and how the workload is built to survive failure. The report adds no measurements of its own; anything not yet measured is shown as missing, with how to measure it.</p>
</section>

</main>
<footer><span>Generated ${esc(genText)}${meta.generatedBy ? ` by ${esc(meta.generatedBy)}` : ''}</span><span>${meta.consoleUrl ? `<a href="${esc(meta.consoleUrl)}" style="color:inherit">${esc(meta.consoleUrl)}</a>` : 'Adhar Console'}</span></footer>
</div>
</body>
</html>
`
}
