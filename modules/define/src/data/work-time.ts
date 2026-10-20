/** Pure time / progress helpers for console-side work data (tested in work-time_test.ts). */

/** Minutes → `1h 30m` (Jira-style; 8h days are NOT assumed). */
export function formatMinutes(min: number | null | undefined): string {
  if (min === null || min === undefined || !Number.isFinite(min)) return '—'
  const m = Math.max(0, Math.round(min))
  const h = Math.floor(m / 60)
  const r = m % 60
  if (!h) return `${r}m`
  return r ? `${h}h ${r}m` : `${h}h`
}

/** `1h 30m`, `90m`, `1.5h`, `2d` (= 2×8h) → minutes; undefined when unreadable. */
export function parseDuration(s: string): number | undefined {
  const t = s.trim().toLowerCase()
  if (!t) return undefined
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 60) // bare number = hours
  let total = 0
  let matched = false
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(d|h|m)/g)) {
    matched = true
    const n = Number(m[1])
    total += m[2] === 'd' ? n * 8 * 60 : m[2] === 'h' ? n * 60 : n
  }
  const leftover = t.replace(/(\d+(?:\.\d+)?)\s*(d|h|m)/g, '').trim()
  return matched && !leftover ? Math.round(total) : undefined
}

/** Checklist progress across all lists. */
export function checklistProgress(doc?: { lists: Array<{ items: Array<{ done: boolean }> }> }): { done: number; total: number } {
  let done = 0
  let total = 0
  for (const l of doc?.lists ?? []) {
    for (const it of l.items) {
      total++
      if (it.done) done++
    }
  }
  return { done, total }
}

/** Today in the viewer's local calendar (`YYYY-MM-DD`) — what a person means by "today". */
export function localDay(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
