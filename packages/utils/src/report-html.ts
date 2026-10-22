/**
 * The building blocks of the console's downloadable reports: one look for
 * every standalone HTML report (the Performance Report, the Chaos Engineering
 * run report), so a team that attaches both to a change record gets two
 * documents that read as one set.
 *
 * Everything is inline — CSS as a string, rings as SVG — because a report has
 * to open offline, attach to a ticket as a single file, and print to A4 / PDF
 * cleanly. Pure: no React, no DOM.
 */

export type ReportTone = 'good' | 'bad' | 'warn' | 'none'

export const REPORT_TONE_COLOR: Record<ReportTone, string> = { good: '#059669', bad: '#e11d48', warn: '#d97706', none: '#64748b' }
export const REPORT_TONE_LABEL: Record<ReportTone, string> = { good: 'Pass', bad: 'Fail', warn: 'Watch', none: 'No data' }
export const REPORT_GRADE_COLOR: Record<string, string> = { A: '#059669', B: '#65a30d', C: '#d97706', D: '#ea580c', F: '#e11d48' }
export const REPORT_PRIORITY_COLOR: Record<'high' | 'medium' | 'low', string> = { high: '#e11d48', medium: '#d97706', low: '#0284c7' }

/** HTML-escape anything that came from data. */
export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** 0–100 → tone: 80+ good, 60+ watch, below that bad; null = not measured. */
export function scoreTone(v: number | null): ReportTone {
  if (v === null) return 'none'
  return v >= 80 ? 'good' : v >= 60 ? 'warn' : 'bad'
}

/** A small outlined status pill. */
export function reportPill(t: ReportTone, text = REPORT_TONE_LABEL[t]): string {
  const c = REPORT_TONE_COLOR[t]
  return `<span class="pill" style="color:${c};border-color:${c}33;background:${c}12">${escapeHtml(text)}</span>`
}

/** A 0–100 score ring with its label underneath. */
export function reportRing(label: string, value: number | null): string {
  const c = 2 * Math.PI * 30
  const pct = value ?? 0
  return `<div class="ring"><svg width="76" height="76" viewBox="0 0 76 76" role="img" aria-label="${escapeHtml(label)} ${value ?? 'n/a'}">
<circle cx="38" cy="38" r="30" fill="none" stroke="#e2e8f0" stroke-width="7"/>
<circle cx="38" cy="38" r="30" fill="none" stroke="${REPORT_TONE_COLOR[scoreTone(value)]}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${((c * pct) / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 38 38)"/>
<text x="38" y="43" text-anchor="middle" font-size="17" font-weight="700" fill="#0f172a">${value ?? 'n/a'}</text></svg><span>${escapeHtml(label)}</span></div>`
}

/** An ISO timestamp as `Thu, 22 Oct 2026 10:00:00 UTC`; anything unparseable as itself. */
export function reportTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toUTCString().replace(' GMT', ' UTC')
}

/**
 * The shared stylesheet: page card, gradient cover with grade badge and rings,
 * section headings, KPI tiles, tables, pills, finding cards with their
 * recommendation callout, the ranked recommendation list, the checks grid, the
 * footer, and the print rules (A4, no shadows, colours kept).
 */
export const REPORT_CSS = `:root{--ink:#0f172a;--muted:#475569;--subtle:#94a3b8;--line:#e2e8f0;--soft:#f8fafc;--brand:#4f46e5}
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
@media print{body{background:#fff}.page{margin:0;box-shadow:none;border-radius:0;max-width:none}@page{size:A4;margin:14mm}section{break-inside:auto}}`
