import { describe, it, expect } from 'vitest'
import {
  formatPopularityBackup,
  isInsertedRow,
  parsePopularityBackup
} from './popularity-backup'

describe('popularity backup file', () => {
  it('round-trips updates and insertions', () => {
    const rows = [
      {
        igdbId: 7,
        previous: { hypes: 1, totalRatingCount: 2 },
        next: { hypes: 3, totalRatingCount: 4 }
      },
      { igdbId: 9, inserted: true as const }
    ]

    const parsed = parsePopularityBackup(formatPopularityBackup(rows) + '\n')

    expect(parsed).toEqual(rows)
    expect(parsed.map(isInsertedRow)).toEqual([false, true])
  })

  it.each([
    ['not json', 'oops'],
    ['a non-integer id', '{"igdbId":1.5,"inserted":true}'],
    ['an id of zero', '{"igdbId":0,"inserted":true}'],
    ['an insertion with extra fields', '{"igdbId":1,"inserted":true,"x":1}'],
    [
      'a negative counter',
      '{"igdbId":1,"previous":{"hypes":-1,"totalRatingCount":0},"next":{"hypes":0,"totalRatingCount":0}}'
    ],
    [
      'a missing next',
      '{"igdbId":1,"previous":{"hypes":1,"totalRatingCount":0}}'
    ],
    [
      'a counter that is a string',
      '{"igdbId":1,"previous":{"hypes":"1","totalRatingCount":0},"next":{"hypes":0,"totalRatingCount":0}}'
    ]
  ])('rejects %s', (_label, line) => {
    expect(() => parsePopularityBackup(line)).toThrow(/Invalid backup line/)
  })
})
