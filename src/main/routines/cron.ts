/** Small, dependency-free five-field cron matcher for routine scheduling. */

interface Field {
  values: Set<number>
  wildcard: boolean
}

export interface ScheduleOptions { tz?: string; earlyMinutes?: number; lateMinutes?: number }
export function isValidScheduleOptions(options: ScheduleOptions | Record<string, unknown>): boolean {
  if (![options.earlyMinutes, options.lateMinutes].every(value => value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 366 * 24 * 60))) return false
  if (options.tz !== undefined) {
    if (typeof options.tz !== 'string' || !options.tz.trim()) return false
    try { new Intl.DateTimeFormat('en-US', { timeZone: options.tz }).format(0) } catch { return false }
  }
  return true
}

export interface ParsedCron {
  minute: Field
  hour: Field
  day: Field
  month: Field
  weekday: Field
}

const LIMITS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7]
] as const

/*
 * `7` means Sunday, and ONLY in the weekday field.
 *
 * Cron accepts both 0 and 7 for Sunday, so the weekday field folds 7 down to 0.
 * That fold used to live here, where every field passes through: `0 7 * * *`
 * parsed its hour as midnight, so "every day at 07:00" ran at 00:00; `0 9 7 * *`
 * lost the 7th of the month and never fired at all; and a plain `* * * * *`
 * skipped seven minutes past every hour. Only the caller knows which field it
 * is holding, so only the caller may ask for the fold.
 */
function addRange(values: Set<number>, start: number, end: number, step: number, sundayAlias: boolean): boolean {
  if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(step) || step <= 0 || start > end) return false
  for (let value = start; value <= end; value += step) values.add(sundayAlias && value === 7 ? 0 : value)
  return true
}

function parseField(source: string, min: number, max: number, sundayAlias = false): Field | null {
  const values = new Set<number>()
  const wildcard = source.split(',').some((part) => part.split('/')[0] === '*')
  for (const part of source.split(',')) {
    if (!part) return null
    const [rangeSource, stepSource] = part.split('/')
    if (part.split('/').length > 2) return null
    const step = stepSource === undefined ? 1 : Number(stepSource)
    let start: number
    let end: number
    if (rangeSource === '*') {
      start = min
      end = max
    } else if (rangeSource?.includes('-')) {
      const pieces = rangeSource.split('-')
      if (pieces.length !== 2) return null
      start = Number(pieces[0])
      end = Number(pieces[1])
    } else {
      start = Number(rangeSource)
      // `5/15` means every 15 units starting at 5, through the field's maximum.
      // Without a slash, a lone value still means exactly that value.
      end = stepSource === undefined ? start : max
    }
    if (start < min || end > max || !addRange(values, start, end, step, sundayAlias)) return null
  }
  return values.size > 0 ? { values, wildcard } : null
}

export function parseCron(source: string): ParsedCron | null {
  const parts = source.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const fields = parts.map((part, index) => {
    const [min, max] = LIMITS[index]!
    // Index 4 is the weekday field: the only one where 7 means Sunday.
    return parseField(part!, min, max, index === 4)
  })
  if (fields.some((field) => field === null)) return null
  return {
    minute: fields[0]!,
    hour: fields[1]!,
    day: fields[2]!,
    month: fields[3]!,
    weekday: fields[4]!
  }
}

export function isValidCron(source: string): boolean {
  return parseCron(source) !== null
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>()
export function cronMatches(parsed: ParsedCron, date: Date, tz?: string): boolean {
  let minute = date.getMinutes(), hour = date.getHours(), month = date.getMonth() + 1, day = date.getDate(), weekday = date.getDay()
  if (tz) {
    let formatter = zoneFormats.get(tz)
    if (!formatter) { formatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, minute: 'numeric', hour: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hourCycle: 'h23' }); zoneFormats.set(tz, formatter) }
    const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]))
    minute = Number(parts.minute); hour = Number(parts.hour); month = Number(parts.month); day = Number(parts.day)
    weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday ?? '')
  }
  if (!parsed.minute.values.has(minute)) return false
  if (!parsed.hour.values.has(hour)) return false
  if (!parsed.month.values.has(month)) return false
  const dayMatch = parsed.day.values.has(day)
  const weekdayMatch = parsed.weekday.values.has(weekday)
  // Traditional cron treats day-of-month and weekday as OR when both are
  // restricted, and as ordinary wildcard conjunction otherwise.
  const calendarMatch = !parsed.day.wildcard && !parsed.weekday.wildcard
    ? dayMatch || weekdayMatch
    : dayMatch && weekdayMatch
  return calendarMatch
}

const MINUTE_MS = 60_000
const MAX_CATCH_UP_MS = 366 * 24 * 60 * MINUTE_MS

/** Separate the current due minute from historical misses; never replay misses implicitly. */
export function cronDueWindow(source: string, since: number, now: number, options: ScheduleOptions = {}): {
  scheduledAt?: number
  missed?: { firstAt: number; lastAt: number; count: number }
  historyTruncated: boolean
} {
  const result: ReturnType<typeof cronDueWindow> = { historyTruncated: false }
  const parsed = parseCron(source)
  if (!parsed || !isValidScheduleOptions(options) || !Number.isFinite(since) || !Number.isFinite(now)) return result
  const last = Math.floor(now / MINUTE_MS) * MINUTE_MS
  const until = last + (options.earlyMinutes ?? 0) * MINUTE_MS
  const eligibleFrom = last - (options.lateMinutes ?? 0) * MINUTE_MS
  if (since >= until + MINUTE_MS) return result
  const earliest = Math.floor(since / MINUTE_MS) * MINUTE_MS + MINUTE_MS
  const first = Math.max(earliest, last - MAX_CATCH_UP_MS)
  result.historyTruncated = first > earliest
  const miss = (at: number): void => {
    if (!result.missed) result.missed = { firstAt: at, lastAt: at, count: 1 }
    else { result.missed.lastAt = at; result.missed.count++ }
  }
  for (let at = first; at <= until; at += MINUTE_MS) {
    if (!cronMatches(parsed, new Date(at), options.tz)) continue
    if (at < eligibleFrom) miss(at)
    else if (at <= last) {
      if (result.scheduledAt !== undefined) miss(result.scheduledAt)
      result.scheduledAt = at
    } else if (result.scheduledAt === undefined) result.scheduledAt = at
  }
  return result
}

/** Once uses the existing current-minute window; explicit late extends it. */
export function onceDueWindow(at: number, since: number | undefined, now: number, lateMinutes = 0): 'pending' | 'due' | 'missed' | 'claimed' {
  if (!Number.isSafeInteger(at) || at < 0 || !Number.isFinite(now) || !isValidScheduleOptions({ lateMinutes })) return 'pending'
  if (since !== undefined && since >= at) return 'claimed'
  if (now < at) return 'pending'
  return Math.floor(now / MINUTE_MS) <= Math.floor(at / MINUTE_MS) + lateMinutes ? 'due' : 'missed'
}

/** Whether at least one scheduled minute has elapsed since the last attempt. */
export function cronIsDue(source: string, since: number, now: number): boolean {
  const parsed = parseCron(source)
  if (!parsed || !Number.isFinite(since) || !Number.isFinite(now) || since >= now) return false
  const first = Math.max(
    Math.floor(since / MINUTE_MS) * MINUTE_MS + MINUTE_MS,
    Math.floor((now - MAX_CATCH_UP_MS) / MINUTE_MS) * MINUTE_MS
  )
  const last = Math.floor(now / MINUTE_MS) * MINUTE_MS
  for (let at = first; at <= last; at += MINUTE_MS) {
    if (cronMatches(parsed, new Date(at))) return true
  }
  return false
}
