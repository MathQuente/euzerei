import { describe, expect, it } from 'vitest'
import {
  decidePrecision,
  formatPrecisionBackup,
  parsePrecisionBackup
} from './release-precision-backfill'

const YEAR_END = 1798675200 // 2026-12-31
const DAY = 1795046400 // 2026-11-19

const row = (releaseDate: number | null, precision: string | null = null) => ({
  igdbId: 1,
  releaseDate,
  releaseDatePrecision: precision
})

describe('decidePrecision', () => {
  it('sets the precision of the date the cache has', () => {
    expect(
      decidePrecision(row(YEAR_END), {
        releaseDate: YEAR_END,
        releaseDates: [{ date: YEAR_END, date_format: 2 }]
      })
    ).toEqual({ kind: 'change', next: 'year' })
  })

  it('does nothing when the row already has it (idempotent)', () => {
    expect(
      decidePrecision(row(DAY, 'day'), {
        releaseDate: DAY,
        releaseDates: [{ date: DAY, date_format: 0 }]
      })
    ).toEqual({ kind: 'same' })
  })

  it('corrects a precision that no longer matches IGDB', () => {
    expect(
      decidePrecision(row(DAY, 'year'), {
        releaseDate: DAY,
        releaseDates: [{ date: DAY, date_format: 0 }]
      })
    ).toEqual({ kind: 'change', next: 'day' })
  })

  it('leaves the row alone when the cache date is not the IGDB date', () => {
    expect(
      decidePrecision(row(DAY), {
        releaseDate: YEAR_END,
        releaseDates: [{ date: YEAR_END, date_format: 2 }]
      })
    ).toEqual({ kind: 'stale_date' })
  })

  it('skips rows with no date, games IGDB did not return and games without date_format', () => {
    expect(decidePrecision(row(null), undefined)).toEqual({ kind: 'no_date' })
    expect(decidePrecision(row(DAY), undefined)).toEqual({ kind: 'not_found' })
    expect(
      decidePrecision(row(DAY), {
        releaseDate: DAY,
        releaseDates: [{ date: DAY }]
      })
    ).toEqual({ kind: 'unknown' })
    expect(decidePrecision(row(DAY), { releaseDate: DAY })).toEqual({
      kind: 'unknown'
    })
  })

  it('is "tbd" when no platform date matches the first release date', () => {
    expect(
      decidePrecision(row(YEAR_END), {
        releaseDate: YEAR_END,
        releaseDates: [{ date: DAY, date_format: 0 }]
      })
    ).toEqual({ kind: 'change', next: 'tbd' })
  })
})

describe('precision backup', () => {
  it('round-trips, with NULL as an empty field', () => {
    const rows = [
      { igdbId: 1, previous: null, next: 'year' },
      { igdbId: 2, previous: 'month', next: 'day' }
    ]
    expect(parsePrecisionBackup(formatPrecisionBackup(rows))).toEqual(rows)
  })

  it('rejects a precision that does not exist and tolerates stray spaces', () => {
    expect(() =>
      parsePrecisionBackup('igdb_id,precisao_antiga,precisao_nova\n1,,yaer')
    ).toThrow(/Invalid backup line/)
    expect(
      parsePrecisionBackup(
        'igdb_id,precisao_antiga,precisao_nova \n 1,month,year \n'
      )
    ).toEqual([{ igdbId: 1, previous: 'month', next: 'year' }])
  })

  it('rejects another file and broken lines', () => {
    expect(() =>
      parsePrecisionBackup(
        'igdb_id,release_date_antiga,release_date_nova\n1,,2'
      )
    ).toThrow(/precision backup/)
    expect(() =>
      parsePrecisionBackup('igdb_id,precisao_antiga,precisao_nova\nabc,,year')
    ).toThrow(/Invalid backup line/)
  })
})
