/** CSV export — RFC 4180 quoting, a formula guard, and a browser download. */

export type CsvCell = string | number | boolean | null | undefined

function cell(v: CsvCell): string {
  if (v == null) return ''
  let s = typeof v === 'number' ? (Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '') : String(v)
  // A leading = + - @ makes spreadsheets evaluate the cell; neutralise text that
  // starts with one (numbers are emitted as numbers above and stay numeric).
  if (typeof v !== 'number' && /^[=+\-@]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function isoTime(ms: number | undefined): string {
  return ms == null || !Number.isFinite(ms) ? '' : new Date(ms).toISOString()
}
