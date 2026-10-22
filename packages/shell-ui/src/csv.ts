/**
 * CSV for the table export — RFC 4180 quoting plus the two things a file that
 * people open in Excel/Sheets needs on top.
 *
 * - Formula injection: a cell that starts with `=`, `+`, `-`, `@` (or a tab/CR)
 *   is evaluated as a formula by spreadsheet apps. Table values come from
 *   cluster and tool data anyone with write access can shape (a label, a
 *   commit message, an issue title), so `=HYPERLINK(...)` in a pod annotation
 *   would become a live link in the auditor's export. Such cells get a leading
 *   `'`, the OWASP-recommended neutraliser. Plain numbers (`-12`, `+3.5`) are
 *   left as they are so negative values stay numeric.
 * - A UTF-8 BOM, without which Excel decodes the file as the local code page
 *   and every non-ASCII name turns to mojibake.
 */

const FORMULA_START = /^[=+\-@\t\r]/
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i

export function csvCell(raw: string): string {
  const s = FORMULA_START.test(raw) && !PLAIN_NUMBER.test(raw) ? `'${raw}` : raw
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Rows of cells → CSV text with a BOM and CRLF line ends (RFC 4180). */
export function toCsv(rows: string[][]): string {
  return '﻿' + rows.map((line) => line.map(csvCell).join(',')).join('\r\n')
}
