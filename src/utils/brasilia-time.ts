const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const BRASILIA_OFFSET_MS = 3 * HOUR_MS

export function startOfBrasiliaDay(now: Date): Date {
  const shifted = now.getTime() - BRASILIA_OFFSET_MS
  const dayStart = Math.floor(shifted / DAY_MS) * DAY_MS
  return new Date(dayStart + BRASILIA_OFFSET_MS)
}

export function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS)
}
