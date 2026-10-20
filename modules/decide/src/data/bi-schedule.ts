import type * as metabase from './mb-types.ts'

/**
 * Subscription / alert schedules.
 *
 * Metabase stores a schedule as four channel fields — `schedule_type`
 * (hourly / daily / weekly / monthly), `schedule_hour`, `schedule_day` and
 * `schedule_frame` (first / mid / last) — evaluated in Metabase's report
 * timezone, not the viewer's. This module maps a friendly model to those
 * fields and back, describes it in words, and computes the next send time in
 * that timezone so "next run" is honest for a viewer elsewhere.
 */

export type Day = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'
export type Frame = 'first' | 'mid' | 'last'

export interface Schedule {
  type: metabase.MbScheduleType
  /** 0–23, report timezone. Ignored for hourly. */
  hour: number
  /** Weekly: the weekday. Monthly: optional weekday ("first Monday"); null = calendar day. */
  day: Day | null
  /** Monthly only. */
  frame: Frame
}

export const DAYS: Day[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
export const DAY_LABEL: Record<Day, string> = {
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
}

export const DEFAULT_SCHEDULE: Schedule = { type: 'daily', hour: 8, day: 'mon', frame: 'first' }

/** The channel fields Metabase stores for a schedule. */
export function toChannelSchedule(s: Schedule): Pick<metabase.MbChannel, 'schedule_type' | 'schedule_hour' | 'schedule_day' | 'schedule_frame'> {
  switch (s.type) {
    case 'hourly':
      return { schedule_type: 'hourly', schedule_hour: null, schedule_day: null, schedule_frame: null }
    case 'daily':
      return { schedule_type: 'daily', schedule_hour: clampHour(s.hour), schedule_day: null, schedule_frame: null }
    case 'weekly':
      return { schedule_type: 'weekly', schedule_hour: clampHour(s.hour), schedule_day: s.day ?? 'mon', schedule_frame: null }
    case 'monthly':
      return {
        schedule_type: 'monthly',
        schedule_hour: clampHour(s.hour),
        // "Mid-month" is always the 15th — Metabase has no "mid Monday".
        schedule_day: s.frame === 'mid' ? null : s.day,
        schedule_frame: s.frame,
      }
  }
}

/** Read a channel back into the model, filling sensible defaults. */
export function fromChannel(ch?: Partial<metabase.MbChannel> | null): Schedule {
  if (!ch?.schedule_type) return { ...DEFAULT_SCHEDULE }
  return {
    type: ch.schedule_type,
    hour: ch.schedule_hour ?? DEFAULT_SCHEDULE.hour,
    day: (ch.schedule_day as Day | null | undefined) ?? (ch.schedule_type === 'weekly' ? 'mon' : null),
    frame: (ch.schedule_frame as Frame | null | undefined) ?? 'first',
  }
}

function clampHour(h: number): number {
  return Math.max(0, Math.min(23, Math.round(Number.isFinite(h) ? h : 0)))
}

export function formatHour(h: number): string {
  const hh = clampHour(h)
  const suffix = hh < 12 ? 'AM' : 'PM'
  const h12 = hh % 12 === 0 ? 12 : hh % 12
  return `${h12}:00 ${suffix}`
}

/** "Weekly on Monday at 8:00 AM". */
export function describeSchedule(s: Schedule): string {
  const at = `at ${formatHour(s.hour)}`
  switch (s.type) {
    case 'hourly':
      return 'Every hour'
    case 'daily':
      return `Daily ${at}`
    case 'weekly':
      return `Weekly on ${DAY_LABEL[s.day ?? 'mon']} ${at}`
    case 'monthly': {
      if (s.frame === 'mid') return `Monthly on the 15th ${at}`
      if (s.day) return `Monthly on the ${s.frame} ${DAY_LABEL[s.day]} ${at}`
      return s.frame === 'first' ? `Monthly on the 1st ${at}` : `Monthly on the last day ${at}`
    }
  }
}

/* ─────────── next run ─────────── */

/** Offset of `tz` from UTC at `instant`, in ms (wall − utc). */
export function tzOffsetMs(instant: number, tz?: string): number {
  if (!tz) return -new Date(instant).getTimezoneOffset() * 60_000
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(instant))
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
    const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
    return wall - Math.floor(instant / 1000) * 1000
  } catch {
    return -new Date(instant).getTimezoneOffset() * 60_000
  }
}

/** Wall-clock fields (as a UTC epoch) → the real instant in `tz`. */
function wallToInstant(wall: number, tz?: string): number {
  // Two passes settle DST transitions.
  let guess = wall - tzOffsetMs(wall, tz)
  guess = wall - tzOffsetMs(guess, tz)
  return guess
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
}

/** Does the schedule fire on this wall-clock date (UTC-encoded)? */
export function firesOn(s: Schedule, wallDate: Date): boolean {
  const y = wallDate.getUTCFullYear()
  const m = wallDate.getUTCMonth()
  const d = wallDate.getUTCDate()
  const dow = DAYS[wallDate.getUTCDay()]
  switch (s.type) {
    case 'hourly':
    case 'daily':
      return true
    case 'weekly':
      return dow === (s.day ?? 'mon')
    case 'monthly': {
      if (s.frame === 'mid') return d === 15
      if (!s.day) return s.frame === 'first' ? d === 1 : d === lastDayOfMonth(y, m)
      if (dow !== s.day) return false
      return s.frame === 'first' ? d <= 7 : d > lastDayOfMonth(y, m) - 7
    }
  }
}

/** The next instant (epoch ms) the schedule sends after `now`, in `tz` (Metabase's report timezone). */
export function nextRun(s: Schedule, now: number, tz?: string): number {
  const wallNow = now + tzOffsetMs(now, tz)
  if (s.type === 'hourly') {
    const nextWall = Math.floor(wallNow / 3_600_000) * 3_600_000 + 3_600_000
    return wallToInstant(nextWall, tz)
  }
  const day0 = Math.floor(wallNow / 86_400_000) * 86_400_000
  for (let i = 0; i < 400; i++) {
    const dayStart = day0 + i * 86_400_000
    if (!firesOn(s, new Date(dayStart))) continue
    const wall = dayStart + clampHour(s.hour) * 3_600_000
    if (wall > wallNow) return wallToInstant(wall, tz)
  }
  return NaN
}
