/**
 * Cron expressions, as the Kubernetes CronJob controller reads them.
 *
 * The console has to answer "when does this run next?" without asking the
 * cluster — the CronJob status only records the LAST schedule time. So the
 * standard five-field syntax is parsed and stepped here: minute, hour,
 * day-of-month, month, day-of-week, with lists, ranges, steps, names
 * (`MON`, `JAN`) and the `@daily`-style macros the controller accepts.
 *
 * Day-of-month and day-of-week follow classic cron: when BOTH are
 * restricted, a day matching EITHER fires. That is surprising, it is also
 * what the controller does, and a preview that disagreed with the cluster
 * would be worse than none.
 *
 * Pure: no React, no network. Time zones go through `Intl`, so the preview
 * matches `spec.timeZone`.
 */

export interface CronSpec {
  minutes: Set<number>
  hours: Set<number>
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  /** Whether day-of-month / day-of-week were `*` — decides AND vs OR. */
  anyDay: boolean
  anyWeekday: boolean
}

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

function parseField(
  field: string,
  min: number,
  max: number,
  names?: string[],
  nameBase = 0,
): Set<number> {
  const out = new Set<number>()
  const value = (s: string): number => {
    const up = s.toUpperCase()
    if (names) {
      const i = names.indexOf(up)
      if (i >= 0) return i + nameBase
    }
    if (!/^\d+$/.test(s)) throw new Error(`“${s}” is not a number`)
    return Number(s)
  }
  for (const part of field.split(',')) {
    if (!part) throw new Error('empty list item')
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step “${stepPart}”`)
    let lo: number
    let hi: number
    if (rangePart === '*' || rangePart === '?') {
      lo = min
      hi = max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-')
      lo = value(a)
      hi = value(b)
    } else {
      lo = value(rangePart)
      // `5/15` means "from 5, every 15" — to the end of the range.
      hi = stepPart === undefined ? lo : max
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`“${part}” is outside ${min}–${max}`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

/** Parse a cron expression; throws with a readable message when it is wrong. */
export function parseCron(expr: string): CronSpec {
  const trimmed = expr.trim()
  const src = MACROS[trimmed.toLowerCase()] ?? trimmed
  if (src.startsWith('@')) throw new Error(`unknown macro “${trimmed}”`)
  const parts = src.split(/\s+/)
  if (parts.length !== 5) throw new Error('expected five fields: minute hour day-of-month month day-of-week')
  const [mi, h, dom, mo, dow] = parts
  const weekdays = parseField(dow, 0, 7, DAYS)
  // 7 is Sunday too.
  if (weekdays.has(7)) {
    weekdays.delete(7)
    weekdays.add(0)
  }
  return {
    minutes: parseField(mi, 0, 59),
    hours: parseField(h, 0, 23),
    days: parseField(dom, 1, 31),
    months: parseField(mo, 1, 12, MONTHS, 1),
    weekdays,
    anyDay: dom === '*' || dom === '?',
    anyWeekday: dow === '*' || dow === '?',
  }
}

export function cronError(expr: string): string | null {
  if (!expr.trim()) return 'A schedule is required.'
  try {
    parseCron(expr)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

interface Wall {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const formatters = new Map<string, Intl.DateTimeFormat>()

/** Wall-clock fields of an instant in a time zone (UTC when unset). */
function wall(ms: number, timeZone?: string): Wall {
  const tz = timeZone || 'UTC'
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    })
    formatters.set(tz, f)
  }
  const parts: Record<string, string> = {}
  for (const p of f.formatToParts(new Date(ms))) parts[p.type] = p.value
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
  }
}

function dayMatches(spec: CronSpec, w: Wall): boolean {
  const dom = spec.days.has(w.day)
  const dow = spec.weekdays.has(w.weekday)
  if (spec.anyDay && spec.anyWeekday) return true
  if (spec.anyDay) return dow
  if (spec.anyWeekday) return dom
  return dom || dow
}

const MINUTE = 60_000

/**
 * The next `count` fire times strictly after `fromMs`.
 *
 * Steps through wall-clock time in the schedule's zone, jumping a whole day
 * or hour at a time when that field cannot match, so even a yearly schedule
 * resolves in a few hundred iterations. Recomputing the wall clock on every
 * step is what keeps DST transitions right without special cases.
 */
export function nextRuns(expr: string, fromMs: number, count = 1, timeZone?: string): number[] {
  let spec: CronSpec
  try {
    spec = parseCron(expr)
  } catch {
    return []
  }
  const out: number[] = []
  // Start at the next whole minute.
  let t = Math.floor(fromMs / MINUTE) * MINUTE + MINUTE
  // Five years of days is the most a valid expression can need (Feb 29).
  const limit = fromMs + 5 * 366 * 24 * 60 * MINUTE
  while (out.length < count && t <= limit) {
    const w = wall(t, timeZone)
    if (!spec.months.has(w.month) || !dayMatches(spec, w)) {
      t += ((23 - w.hour) * 60 + (60 - w.minute)) * MINUTE
      continue
    }
    if (!spec.hours.has(w.hour)) {
      t += (60 - w.minute) * MINUTE
      continue
    }
    if (!spec.minutes.has(w.minute)) {
      t += MINUTE
      continue
    }
    out.push(t)
    t += MINUTE
  }
  return out
}

/** A plain-English reading of the commonest shapes; falls back to the expression. */
export function describeCron(expr: string): string {
  const e = expr.trim()
  const macro = e.toLowerCase()
  if (macro === '@hourly') return 'Every hour'
  if (macro === '@daily' || macro === '@midnight') return 'Every day at 00:00'
  if (macro === '@weekly') return 'Every Sunday at 00:00'
  if (macro === '@monthly') return 'On the 1st of every month at 00:00'
  if (macro === '@yearly' || macro === '@annually') return 'Every 1 January at 00:00'
  const parts = e.split(/\s+/)
  if (parts.length !== 5 || cronError(e)) return e
  const [mi, h, dom, mo, dow] = parts
  const pad = (s: string) => s.padStart(2, '0')
  const fixed = (s: string) => /^\d+$/.test(s)
  const at = fixed(mi) && fixed(h) ? `at ${pad(h)}:${pad(mi)}` : null

  if (/^\*\/\d+$/.test(mi) && h === '*' && dom === '*' && mo === '*' && dow === '*') {
    return `Every ${mi.slice(2)} minutes`
  }
  if (fixed(mi) && h === '*' && dom === '*' && mo === '*' && dow === '*') return `Every hour at :${pad(mi)}`
  if (fixed(mi) && /^\*\/\d+$/.test(h) && dom === '*' && mo === '*' && dow === '*') {
    return `Every ${h.slice(2)} hours at :${pad(mi)}`
  }
  if (at && dom === '*' && mo === '*') {
    if (dow === '*') return `Every day ${at}`
    if (dow === '1-5' || dow.toUpperCase() === 'MON-FRI') return `Weekdays ${at}`
    try {
      const days = [...parseCron(e).weekdays].sort().map((d) => DAYS[d][0] + DAYS[d].slice(1).toLowerCase())
      return `Every ${days.join(', ')} ${at}`
    } catch {
      return e
    }
  }
  if (at && fixed(dom) && mo === '*' && dow === '*') return `Monthly on day ${dom} ${at}`

  // Repeating times restricted to some weekdays — `0 */6 * * 1-5` read as
  // "Every 6 hours at :00, on weekdays" instead of echoing the expression.
  if (dom === '*' && mo === '*' && dow !== '*') {
    const time = /^\*\/\d+$/.test(mi) && h === '*'
      ? `Every ${mi.slice(2)} minutes`
      : fixed(mi) && h === '*'
      ? `Every hour at :${pad(mi)}`
      : fixed(mi) && /^\*\/\d+$/.test(h)
      ? `Every ${h.slice(2)} hours at :${pad(mi)}`
      : fixed(mi) && /^\d+(,\d+)+$/.test(h)
      ? `At ${h.split(',').map((x) => `${pad(x)}:${pad(mi)}`).join(', ')}`
      : null
    if (time) {
      if (dow === '1-5' || dow.toUpperCase() === 'MON-FRI') return `${time}, on weekdays`
      if (dow === '0,6' || dow === '6,0' || dow.toUpperCase() === 'SAT,SUN') return `${time}, at weekends`
      try {
        const days = [...parseCron(e).weekdays].sort().map((d) => DAYS[d][0] + DAYS[d].slice(1).toLowerCase())
        return `${time}, on ${days.join(', ')}`
      } catch {
        return e
      }
    }
  }
  // Several fixed hours every day: `0 8,20 * * *` → "Every day at 08:00, 20:00".
  if (fixed(mi) && /^\d+(,\d+)+$/.test(h) && dom === '*' && mo === '*' && dow === '*') {
    return `Every day at ${h.split(',').map((x) => `${pad(x)}:${pad(mi)}`).join(', ')}`
  }
  return e
}

export const CRON_PRESETS: Array<{ label: string; cron: string }> = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Nightly at 02:00', cron: '0 2 * * *' },
  { label: 'Weekdays at 06:00', cron: '0 6 * * 1-5' },
  { label: 'Weekly, Sunday 03:00', cron: '0 3 * * 0' },
]
