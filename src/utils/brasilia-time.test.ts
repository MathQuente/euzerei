import { describe, it, expect } from 'vitest'
import { daysAgo, startOfBrasiliaDay } from './brasilia-time'

const iso = (date: Date) => date.toISOString()

describe('startOfBrasiliaDay', () => {
  it('is midnight in Brasília (03:00 UTC) of the same day during the afternoon', () => {
    expect(iso(startOfBrasiliaDay(new Date('2026-11-20T14:00:00Z')))).toBe(
      '2026-11-20T03:00:00.000Z'
    )
  })

  it('starts exactly at 03:00 UTC', () => {
    expect(iso(startOfBrasiliaDay(new Date('2026-11-20T03:00:00Z')))).toBe(
      '2026-11-20T03:00:00.000Z'
    )
  })

  it('still belongs to the previous Brasília day one millisecond before 03:00 UTC', () => {
    expect(iso(startOfBrasiliaDay(new Date('2026-11-20T02:59:59.999Z')))).toBe(
      '2026-11-19T03:00:00.000Z'
    )
  })

  it('uses the Brasília date, not the UTC one, at 21:00 in Brasília (already tomorrow in UTC)', () => {
    expect(iso(startOfBrasiliaDay(new Date('2026-11-21T00:00:00Z')))).toBe(
      '2026-11-20T03:00:00.000Z'
    )
  })

  it('uses the Brasília date, not the UTC one, at 23:30 in Brasília', () => {
    expect(iso(startOfBrasiliaDay(new Date('2026-11-20T02:30:00Z')))).toBe(
      '2026-11-19T03:00:00.000Z'
    )
  })

  it('works across a month boundary', () => {
    expect(iso(startOfBrasiliaDay(new Date('2026-12-01T01:00:00Z')))).toBe(
      '2026-11-30T03:00:00.000Z'
    )
  })
})

describe('daysAgo', () => {
  it('goes back whole 24 hour days', () => {
    expect(iso(daysAgo(new Date('2026-11-20T12:00:00Z'), 7))).toBe(
      '2026-11-13T12:00:00.000Z'
    )
  })
})
