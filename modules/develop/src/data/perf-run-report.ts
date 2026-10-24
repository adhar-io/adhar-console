/**
 * A self-contained HTML report for ONE k6 run — what someone attaches to a
 * ticket or prints to PDF. Everything in it comes from the run itself: the
 * lifecycle the cluster recorded, the plan the script declared, and the
 * end-of-test summary k6 printed. Every interpolated value is escaped; the
 * report never embeds raw log text as markup.
 */

import type { K6Summary } from './k6-summary.ts'
import type { LoadPlan } from './perf-plan.ts'
import type { RunMetrics } from './perf-results.ts'
import { fmtSecs, type Lifecycle, type PodDetail } from './perf-run-model.ts'
import type { LogGroup } from './perf-live.ts'

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export interface RunReportInput {
  name: string
  namespace: string
  test?: string
  commit?: string
  application?: string
  stage: string
  parallelism: number
  lifecycle: Lifecycle
  plan?: LoadPlan
  summary?: K6Summary
  metrics?: RunMetrics
  pods: PodDetail[]
  logGroups?: LogGroup[]
  link?: string
  generatedAt: Date
}

const OUTCOME_TEXT: Record<Lifecycle['outcome'], string> = {
  'in-progress': 'In progress',
  passed: 'Passed',
  'thresholds-failed': 'Thresholds failed',
  failed: 'Failed',
  aborted: 'Aborted',
  unknown: 'Finished',
}

const fmtTime = (ms: number | undefined) => (ms === undefined ? '—' : new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC'))

const num = (v: number | undefined, unit = '', digits = 1) => (v === undefined ? '—' : `${v.toFixed(v >= 100 ? 0 : digits)}${unit}`)

export function runReportHtml(r: RunReportInput): string {
  const e = escapeHtml
  const lc = r.lifecycle
  const m = r.metrics
  const outcome = OUTCOME_TEXT[lc.outcome]
  const tone = lc.outcome === 'passed' ? '#047857' : lc.outcome === 'in-progress' || lc.outcome === 'unknown' ? '#475569' : '#be123c'
  const elapsed = lc.loadStartMs !== undefined && lc.loadEndMs !== undefined ? (lc.loadEndMs - lc.loadStartMs) / 1000 : undefined

  const kpis: Array<[string, string]> = [
    ['Requests / s', num(m?.rps)],
    ['p95 latency', num(m?.p95Ms, ' ms')],
    ['p99 latency', num(m?.p99Ms, ' ms')],
    ['Median latency', num(m?.medMs, ' ms', 2)],
    ['Failed requests', num(m?.errorRatePct, '%', 2)],
    ['Checks passed', num(m?.checksPct, '%', 2)],
    ['Requests', m?.requests === undefined ? '—' : String(m.requests)],
    ['Peak VUs', m?.vusMax === undefined ? '—' : String(m.vusMax)],
  ]

  const thresholds = r.summary?.thresholds ?? []
  const declared = r.plan?.thresholds ?? []

  const rows = (xs: Array<[string, string]>) => xs.map(([k, v]) => `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>`).join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(r.test ?? r.name)} — k6 run report</title>
<style>
  :root { color-scheme: light; --ink:#0f172a; --muted:#475569; --line:#e2e8f0; }
  body { font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); margin: 0; background: #fff; }
  main { max-width: 880px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 14px; margin: 28px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
  .muted { color: var(--muted); } .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; color: #fff; background: ${tone}; font-weight: 600; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
  .kpi { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; } .kpi b { display: block; font-size: 16px; }
  table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; width: 34%; }
  .pass { color: #047857; } .fail { color: #be123c; }
  @media print { main { padding: 0; } .kpi { break-inside: avoid; } }
  @media (max-width: 600px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style></head><body><main>
<h1>${e(r.test ?? r.name)}</h1>
<div class="muted">k6 run <span class="mono">${e(r.namespace)}/${e(r.name)}</span>${r.commit ? ` · commit <span class="mono">${e(r.commit.slice(0, 12))}</span>` : ''}${r.application ? ` · application ${e(r.application)}` : ''}</div>
<p><span class="badge">${e(outcome)}</span> ${lc.outcomeDetail ? `<span class="muted">${e(lc.outcomeDetail)}</span>` : ''}</p>

<h2>Headline</h2>
${m ? `<div class="grid">${kpis.map(([k, v]) => `<div class="kpi"><span class="muted">${e(k)}</span><b>${e(v)}</b></div>`).join('')}</div>` : '<p class="muted">No end-of-test summary was available for this run.</p>'}

<h2>Thresholds</h2>
${
    thresholds.length
      ? `<table>${thresholds.map((t) => `<tr><th class="mono">${e(t.metric)}</th><td class="mono ${t.passed ? 'pass' : 'fail'}">${t.passed ? '✓' : '✗'} ${e(t.expression)}${t.actual ? ` <span class="muted">(${e(t.actual)})</span>` : ''}</td></tr>`).join('')}</table>`
      : declared.length
      ? `<p class="muted">Declared but not yet evaluated:</p><table>${declared.map((t) => `<tr><th class="mono">${e(t.metric)}</th><td class="mono">${e(t.expression)}</td></tr>`).join('')}</table>`
      : '<p class="muted">The script declares no thresholds.</p>'
  }

<h2>Timeline</h2>
<table>${rows(lc.phases.map((p) => [p.label, `${fmtTime(p.startMs)}${p.endMs !== undefined && p.startMs !== undefined ? ` → ${fmtSecs((p.endMs - p.startMs) / 1000)}` : ''}${p.detail ? ` — ${p.detail}` : ''}`]))}</table>

<h2>Plan and execution</h2>
<table>${
    rows([
      ['Runners (parallelism)', String(r.parallelism)],
      ['Planned duration', r.plan?.totalSecs !== undefined ? `${r.plan.totalIsUpperBound ? 'up to ' : ''}${fmtSecs(r.plan.totalSecs)}` : 'unknown'],
      ['Planned peak VUs', r.plan?.maxVus !== undefined ? String(r.plan.maxVus) : 'unknown'],
      ['Load generated for', fmtSecs(elapsed)],
      ['Scenarios', r.plan?.scenarios.map((s) => `${s.name} (${s.executor})`).join(', ') || '—'],
      ['Operator stage', r.stage],
    ])
  }</table>

<h2>Pods</h2>
<table>${rows(r.pods.map((p) => [p.name, `${p.role} · ${p.state}${p.exitCode !== undefined ? ` · exit ${p.exitCode}` : ''}${p.reason ? ` · ${p.reason}` : ''}`]))}</table>
${
    r.logGroups?.length
      ? `<h2>Most frequent log warnings and errors</h2><table>${r.logGroups.map((g) => `<tr><th>${e(g.count)} × ${e(g.level)}</th><td class="mono">${e(g.msg)}${g.detail && g.detail !== g.msg ? ` — ${e(g.detail)}` : ''}</td></tr>`).join('')}</table>`
      : ''
  }
${
    r.summary?.metrics.length
      ? `<h2>All metrics</h2><table>${r.summary.metrics.map((x) => `<tr><th class="mono">${e(x.name)}</th><td class="mono">${e(x.raw)}</td></tr>`).join('')}</table>`
      : ''
  }
<p class="muted" style="margin-top:28px">Generated ${e(r.generatedAt.toISOString())} by the Adhar Performance Center${r.link ? ` · <a href="${e(r.link)}">open the run</a>` : ''}.</p>
</main></body></html>`
}
