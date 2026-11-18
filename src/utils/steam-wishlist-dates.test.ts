import { describe, expect, it } from 'vitest'
import {
  earliestDatePerGame,
  formatDateBackup,
  parseDateBackup,
  planWishlistDates
} from './steam-wishlist-dates'

const IMPORTED = new Date('2026-11-18T03:57:17.000Z')
const row = (id: string, igdbId: number, createdAt = IMPORTED) => ({
  id,
  igdbId,
  createdAt
})

describe('planWishlistDates', () => {
  it('moves each wishlist game to the date Steam says it was added', () => {
    const plan = planWishlistDates(
      [row('a', 1), row('b', 2)],
      [
        { igdbId: 1, dateAdded: 1_700_000_000 },
        { igdbId: 2, dateAdded: 1_790_000_000 }
      ]
    )
    expect(plan.changes).toEqual([
      {
        id: 'a',
        igdbId: 1,
        previous: IMPORTED,
        next: new Date(1_700_000_000 * 1000)
      },
      {
        id: 'b',
        igdbId: 2,
        previous: IMPORTED,
        next: new Date(1_790_000_000 * 1000)
      }
    ])
  })

  it('leaves games that are not on the Steam list alone', () => {
    const plan = planWishlistDates(
      [row('manual', 99)],
      [{ igdbId: 1, dateAdded: 1_700_000_000 }]
    )
    expect(plan.changes).toEqual([])
    expect(plan.notOnSteam).toBe(1)
  })

  it('counts games Steam lists without a date and does not touch them', () => {
    const plan = planWishlistDates([row('a', 1)], [{ igdbId: 1 }])
    expect(plan.changes).toEqual([])
    expect(plan.noDate).toBe(1)
  })

  it('is idempotent: a second run finds nothing left to change', () => {
    const steam = [{ igdbId: 1, dateAdded: 1_700_000_000 }]
    const first = planWishlistDates([row('a', 1)], steam)
    const second = planWishlistDates(
      [row('a', 1, first.changes[0].next)],
      steam
    )
    expect(second.changes).toEqual([])
    expect(second.alreadyRight).toBe(1)
  })
})

describe('earliestDatePerGame', () => {
  it('keeps the earliest date when a game shows up twice', () => {
    const dates = earliestDatePerGame([
      { igdbId: 1, dateAdded: 200 },
      { igdbId: 1, dateAdded: 100 },
      { igdbId: 1 },
      { igdbId: 2 },
      { igdbId: 2, dateAdded: 50 }
    ])
    expect(dates.get(1)).toBe(100)
    expect(dates.get(2)).toBe(50)
  })
})

describe('date backup', () => {
  it('round-trips so the change can be undone', () => {
    const changes = [
      {
        id: 'a',
        igdbId: 1,
        previous: IMPORTED,
        next: new Date(1_700_000_000 * 1000)
      }
    ]
    expect(parseDateBackup(formatDateBackup(changes))).toEqual(changes)
  })

  it('rejects a damaged line instead of guessing', () => {
    expect(() => parseDateBackup('{"id":"a"')).toThrow('Invalid backup line')
    expect(() =>
      parseDateBackup('{"id":"a","igdbId":1,"previous":"x","next":"y"}')
    ).toThrow('Invalid backup line')
  })
})
