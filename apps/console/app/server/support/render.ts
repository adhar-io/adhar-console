import type { NotificationDoc } from '../notify.ts'
import type { IncidentRef } from './classify.ts'
import type { Evidence, MetricResult, Section } from './evidence.ts'

/**
 * Evidence → Plane work item. Plane stores `description_html` / `comment_html`
 * and renders it in its rich-text editor, which keeps headings, lists, links,
 * blockquotes and code blocks — so that is all this emits (no <details>: the
 * editor drops unknown nodes, and a collapsed section that loses its body is
 * worse than a long one). Each evidence section is capped at
 * `maxSectionBytes`; the uncapped evidence goes in the JSON attachment.
 */

export const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const link = (href: string | undefined, text: string) => (href ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(text))

/** Plane priority for a notification severity. */
export function priorityOf(doc: Pick<NotificationDoc, 'severity' | 'kind'>): 'urgent' | 'high' | 'medium' | 'low' {
  switch (doc.severity) {
    case 'critical':
      return 'urgent'
    case 'high':
      return 'high'
    case 'medium':
      return 'medium'
    case 'low':
      return 'low'
    default:
      return doc.kind === 'error' ? 'high' : 'medium'
  }
}

export function titleOf(doc: Pick<NotificationDoc, 'title'>): string {
  return `[incident] ${doc.title}`.slice(0, 255)
}

/** Label names for the work item: what it is, where, and which signal raised it. */
export function labelNamesOf(ref: IncidentRef, ev?: Evidence): string[] {
  const app = ev?.subject.app ?? ref.app
  const env = ev?.subject.env ?? ref.env
  return [
    'incident',
    `source:${ref.family}`,
    ...(env ? [`env:${env}`] : []),
    ...(app ? [`app:${app}`] : []),
  ].map((l) => l.slice(0, 60))
}

/** Truncate a block of text to `max` UTF-8 bytes, saying so. */
export function capText(text: string, max: number): string {
  const enc = new TextEncoder()
  if (enc.encode(text).byteLength <= max) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (enc.encode(text.slice(0, mid)).byteLength <= max - 64) lo = mid
    else hi = mid - 1
  }
  return `${text.slice(0, lo)}\n… [truncated — the full evidence is in the attached JSON]`
}

const pre = (lines: string[], max: number) => `<pre><code>${esc(capText(lines.join('\n'), max))}</code></pre>`

const sectionNote = (s: Section<unknown>) => (s.note ? `<p><em>${esc(s.note)}</em></p>` : '')

const statusWord: Record<string, string> = { ok: '', empty: 'nothing found', error: 'unavailable', skipped: 'not collected' }

/* ─────────────────────────── values ─────────────────────────── */

export function formatValue(v: number, unit: MetricResult['unit']): string {
  if (!Number.isFinite(v)) return String(v)
  switch (unit) {
    case 'bytes':
      return v >= 1024 ** 3 ? `${(v / 1024 ** 3).toFixed(2)} GiB` : `${(v / 1024 ** 2).toFixed(1)} MiB`
    case 'cores':
      return v < 1 ? `${Math.round(v * 1000)}m` : `${v.toFixed(2)} cores`
    case 'ratio':
      return `${(v * 100).toFixed(1)}%`
    case 'seconds':
      return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`
    case 'count':
      return Number.isInteger(v) ? String(v) : v.toFixed(1)
    default:
      return Number.isInteger(v) ? String(v) : v.toPrecision(4)
  }
}

const labelText = (l: Record<string, string>) => {
  const parts = Object.entries(l).filter(([k]) => k !== 'namespace' && k !== 'container').map(([k, v]) => (k === 'pod' ? v : `${k}=${v}`))
  return parts.join(' · ') || 'total'
}

/* ─────────────────────────── sections ─────────────────────────── */

function k8sHtml(ev: Evidence, max: number): string {
  const s = ev.k8s
  const out = ['<h2>Kubernetes</h2>', sectionNote(s)]
  if (!s.data) return out.join('') + `<p>${esc(statusWord[s.status])}</p>`
  if (s.data.pods.length) {
    out.push('<h3>Pods</h3><ul>')
    for (const p of s.data.pods) {
      const c = p.containers.find((x) => x.lastTermination || x.waiting) ?? p.containers[0]
      const why = [c?.waiting ? `waiting: ${c.waiting}` : '', c?.lastTermination ? `last exit: ${c.lastTermination.reason ?? '?'} (code ${c.lastTermination.exitCode ?? '?'}) at ${c.lastTermination.finishedAt ?? '?'}` : '']
        .filter(Boolean).join('; ')
      out.push(`<li><code>${esc(p.name)}</code> — ${esc(p.phase ?? '?')}, ${p.ready ? 'ready' : '<strong>not ready</strong>'}, ${p.restarts} restart(s)${why ? ` — ${esc(why)}` : ''}${p.node ? ` · node ${esc(p.node)}` : ''}</li>`)
    }
    out.push('</ul>')
  }
  if (s.data.events.length) {
    out.push('<h3>Recent events</h3>')
    out.push(pre(s.data.events.map((e) => `${e.at ?? ''}  ${e.type ?? ''}  ${e.reason ?? ''}  ${e.object}${e.count && e.count > 1 ? ` (×${e.count})` : ''}  ${e.message ?? ''}`), max / 2))
  }
  if (s.data.object) {
    out.push('<h3>Object status</h3>')
    out.push(pre([JSON.stringify(s.data.object, null, 2)], max / 2))
  }
  return out.join('')
}

function logsHtml(ev: Evidence, max: number): string {
  const s = ev.logs
  const out = ['<h2>Logs</h2>', sectionNote(s)]
  if (!s.data) return out.join('') + (s.note ? '' : `<p>${esc(statusWord[s.status])}</p>`)
  out.push(`<p>Source: ${s.data.source === 'loki' ? 'Loki' : 'Kubernetes API (current + previous containers)'}${s.data.query ? ` · <code>${esc(s.data.query)}</code>` : ''}${s.data.exploreUrl ? ` · ${link(s.data.exploreUrl, 'open in Grafana Explore')}` : ''}</p>`)
  if (s.data.errorLines.length) {
    out.push(`<h3>Error lines (${s.data.errorLines.length})</h3>`, pre(s.data.errorLines, max / 2))
  }
  if (s.data.lines.length) {
    out.push(`<h3>Most recent lines (${s.data.lines.length})</h3>`, pre(s.data.lines, max / 2))
  }
  return out.join('')
}

function metricsHtml(ev: Evidence): string {
  const s = ev.metrics
  const out = ['<h2>Metrics</h2>', sectionNote(s)]
  if (!s.data) return out.join('') + (s.note ? '' : `<p>${esc(statusWord[s.status])}</p>`)
  out.push(`<p>Snapshot at ${esc(ev.collectedAt)}; windows are the last ${ev.windowMinutes} minutes.</p><ul>`)
  for (const m of s.data.results) {
    const vals = m.error
      ? `<em>query failed: ${esc(m.error)}</em>`
      : m.values.length
      ? m.values.map((v) => `${esc(labelText(v.labels))}: <strong>${esc(formatValue(v.value, m.unit))}</strong>`).join(', ')
      : '<em>no data (the workload may not expose this metric)</em>'
    out.push(`<li>${esc(m.title)} — ${vals}${m.exploreUrl ? ` · ${link(m.exploreUrl, 'Explore')}` : ''}</li>`)
  }
  out.push('</ul>')
  return out.join('')
}

function tracesHtml(ev: Evidence): string {
  const s = ev.traces
  const out = ['<h2>Traces</h2>', sectionNote(s)]
  if (!s.data) return out.join('') + (s.note ? '' : `<p>${esc(statusWord[s.status])}</p>`)
  if (s.data.traces.length) {
    out.push('<ul>')
    for (const t of s.data.traces) {
      out.push(`<li>${link(t.url, t.traceId)} — ${esc(t.service ?? '')} ${esc(t.name ?? '')}${t.durationMs !== undefined ? ` · ${t.durationMs} ms` : ''}${t.start ? ` · ${esc(t.start)}` : ''}</li>`)
    }
    out.push('</ul>')
  }
  out.push(`<p><code>${esc(s.data.query)}</code>${s.data.exploreUrl ? ` · ${link(s.data.exploreUrl, 'search in Grafana Explore')}` : ''}</p>`)
  return out.join('')
}

function deliveryHtml(ev: Evidence): string {
  const s = ev.delivery
  const out = ['<h2>Delivery</h2>', sectionNote(s)]
  const d = s.data
  if (!d) return out.join('') + (s.note ? '' : `<p>${esc(statusWord[s.status])}</p>`)
  if (d.argo) {
    const a = d.argo
    out.push('<h3>Argo CD</h3><ul>')
    out.push(`<li>Application ${link(ev.links.argocd, `${a.namespace}/${a.name}`)} (project ${esc(a.project ?? '?')})</li>`)
    out.push(`<li>Health <strong>${esc(a.health ?? '?')}</strong>${a.healthMessage ? ` — ${esc(a.healthMessage)}` : ''}; sync ${esc(a.sync ?? '?')} at <code>${esc((a.revision ?? '').slice(0, 12))}</code></li>`)
    out.push(`<li>Source ${esc(a.repo ?? '')} ${a.path ? `path <code>${esc(a.path)}</code>` : ''} @ ${esc(a.targetRevision ?? '')}</li>`)
    if (a.lastOperation) {
      const o = a.lastOperation
      out.push(`<li>Last sync ${esc(o.phase ?? '?')} (${esc(o.startedAt ?? '')} → ${esc(o.finishedAt ?? '')}) by ${esc(o.initiatedBy ?? '?')}${o.promotion ? ` for promotion <code>${esc(o.promotion)}</code>` : ''}: ${esc(o.message ?? '')}</li>`)
    }
    if (a.images.length) out.push(`<li>Images: ${a.images.map((i) => `<code>${esc(i)}</code>`).join(', ')}</li>`)
    out.push('</ul>')
  }
  if (d.kargo) {
    out.push('<h3>Kargo</h3><ul>')
    const p = d.kargo.promotion
    if (p) {
      out.push(`<li>Promotion <code>${esc(p.namespace)}/${esc(p.name)}</code> to ${esc(p.stage ?? '?')}: <strong>${esc(p.phase ?? '?')}</strong>${p.message ? ` — ${esc(p.message)}` : ''}</li>`)
      if (p.images.length || p.commits.length) out.push(`<li>Freight <code>${esc(p.freight ?? '')}</code>: ${[...p.images, ...p.commits].map((x) => `<code>${esc(x)}</code>`).join(', ')}</li>`)
    }
    const v = d.kargo.verification
    if (v) {
      out.push(`<li>Stage ${link(ev.links.kargo, v.stage)}${v.health ? ` health <strong>${esc(v.health)}</strong>` : ''}; verification: <strong>${esc(v.phase ?? 'none recorded')}</strong>${v.message ? ` — ${esc(v.message)}` : ''}${v.analysisRun ? ` (AnalysisRun <code>${esc(v.analysisRun)}</code>)` : ''}</li>`)
      for (const i of v.issues ?? []) out.push(`<li>Stage issue: ${esc(i)}</li>`)
    }
    out.push('</ul>')
  }
  if (d.commit) out.push(`<p>Commit: <code>${esc(d.commit)}</code></p>`)
  return out.join('')
}

/* ─────────────────────────── documents ─────────────────────────── */

export interface PreviousTicket { key?: string; url?: string; resolvedAt?: string }

export function descriptionHtml(
  doc: NotificationDoc,
  ref: IncidentRef,
  ev: Evidence,
  opts: { maxSectionBytes: number; previous?: PreviousTicket; attached?: boolean },
): string {
  const s = ev.subject
  const out: string[] = []
  if (opts.previous) {
    out.push(`<blockquote>Recurrence of ${link(opts.previous.url, opts.previous.key ?? 'a previous ticket')}${opts.previous.resolvedAt ? `, resolved ${esc(opts.previous.resolvedAt)}` : ''}.</blockquote>`)
  }
  out.push('<h2>Summary</h2>')
  out.push(`<p><strong>${esc(doc.title)}</strong></p><ul>`)
  out.push(`<li>Signal: ${esc(ref.family)} (${esc(ref.source)}) · severity ${esc(doc.severity ?? (doc.kind === 'error' ? 'high' : 'medium'))}</li>`)
  if (s.app || s.env) out.push(`<li>Application: <strong>${esc(s.app ?? '?')}</strong>${s.env ? ` · environment <strong>${esc(s.env)}</strong>` : ''}${s.project ? ` · project ${esc(s.project)}` : ''}</li>`)
  if (s.objectKind || s.name) out.push(`<li>Object: <code>${esc(s.objectKind ?? '')} ${esc(s.namespace ? `${s.namespace}/` : '')}${esc(s.name ?? '')}</code>${s.workloadNamespace && s.workloadNamespace !== s.namespace ? ` · workload namespace <code>${esc(s.workloadNamespace)}</code>` : ''}</li>`)
  out.push(`<li>First seen: ${esc(doc.at)}</li>`)
  out.push(`<li>Incident: <code>${esc(ref.incidentId)}</code></li></ul>`)
  out.push('<h2>What happened</h2>')
  out.push(`<p>${esc(doc.description ?? doc.title)}</p>`)
  if (doc.prompt) {
    out.push('<h2>Suggested investigation</h2>')
    out.push(`<blockquote>${esc(doc.prompt)}</blockquote><p>Ask Adhar AI with this prompt from the notification in the console.</p>`)
  }
  const links = [
    ev.links.console ? link(ev.links.console, 'Open in Adhar Console') : '',
    ev.links.argocd ? link(ev.links.argocd, 'Argo CD application') : '',
    ev.links.kargo ? link(ev.links.kargo, 'Kargo stage') : '',
    ev.logs.data?.exploreUrl ? link(ev.logs.data.exploreUrl, 'Logs (Grafana Explore)') : '',
    ev.traces.data?.exploreUrl ? link(ev.traces.data.exploreUrl, 'Traces (Grafana Explore)') : '',
  ].filter(Boolean)
  if (links.length) out.push(`<h2>Links</h2><ul>${links.map((l) => `<li>${l}</li>`).join('')}</ul>`)
  out.push(k8sHtml(ev, opts.maxSectionBytes))
  out.push(logsHtml(ev, opts.maxSectionBytes))
  out.push(metricsHtml(ev))
  out.push(tracesHtml(ev))
  out.push(deliveryHtml(ev))
  out.push(`<p><em>Collected by Adhar Console at ${esc(ev.collectedAt)}. Secrets, tokens and credentials were redacted before leaving the cluster.${opts.attached ? ' The full evidence is attached as JSON.' : ''}</em></p>`)
  return out.join('')
}

/** A short evidence digest for a recurrence comment. */
export function recurrenceCommentHtml(doc: NotificationDoc, ev: Evidence | undefined, occurrences: number): string {
  const out = [`<p><strong>Recurred</strong> (${occurrences} occurrences) at ${esc(doc.at)}: ${esc(doc.title)}</p>`]
  if (doc.description) out.push(`<p>${esc(doc.description)}</p>`)
  if (ev) {
    const pods = ev.k8s.data?.pods ?? []
    if (pods.length) out.push(`<ul>${pods.slice(0, 5).map((p) => `<li><code>${esc(p.name)}</code> ${esc(p.phase ?? '')}, ${p.restarts} restart(s)</li>`).join('')}</ul>`)
    const errs = ev.logs.data?.errorLines ?? []
    if (errs.length) out.push(pre(errs.slice(0, 15), 6_000))
    if (ev.logs.data?.exploreUrl) out.push(`<p>${link(ev.logs.data.exploreUrl, 'Logs in Grafana Explore')}</p>`)
  }
  return out.join('')
}

export function resolutionCommentHtml(doc: NotificationDoc, moved: boolean): string {
  return `<p><strong>Recovered</strong> at ${esc(doc.at)}: ${esc(doc.title)}.${moved ? ' Moved to done by Adhar Console; reopen if the problem persists.' : ''}</p>${doc.description ? `<p>${esc(doc.description)}</p>` : ''}`
}
