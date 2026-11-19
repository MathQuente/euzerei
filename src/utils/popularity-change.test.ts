import { describe, it, expect } from 'vitest'
import { classifyPopularityChange } from './popularity-change'
import { isPopular } from './catalog-popularity'

const classify = (
  cache: { hypes: number | null; totalRatingCount: number | null } | null,
  hypes: number,
  totalRatingCount: number
) => classifyPopularityChange({ cache, igdb: { hypes, totalRatingCount } })

describe('isPopular', () => {
  it.each([
    [9, 0, false],
    [10, 0, true],
    [0, 4, false],
    [0, 5, true],
    [9, 4, false],
    [null, null, false],
    [undefined, 5, true]
  ])('rating count %s, hypes %s -> %s', (count, hypes, expected) => {
    expect(isPopular(count, hypes)).toBe(expected)
  })
})

describe('classifyPopularityChange', () => {
  it('inserts a game the cache does not have', () => {
    expect(classify(null, 3, 40)).toEqual({
      kind: 'inserir',
      writes: true,
      next: { hypes: 3, totalRatingCount: 40 }
    })
  })

  it('does not write equal counters', () => {
    expect(classify({ hypes: 3, totalRatingCount: 40 }, 3, 40)).toMatchObject({
      kind: 'igual',
      writes: false
    })
  })

  it('treats a NULL counter in the cache as 0, so it is not a change when IGDB says 0', () => {
    expect(
      classify({ hypes: null, totalRatingCount: null }, 0, 0)
    ).toMatchObject({ kind: 'igual', writes: false })
  })

  it('normalizes a NULL cache counter to 0 before comparing, in both directions', () => {
    expect(
      classify({ hypes: null, totalRatingCount: 12 }, 0, 12)
    ).toMatchObject({
      kind: 'igual',
      writes: false
    })
    expect(
      classify({ hypes: null, totalRatingCount: 12 }, 2, 12)
    ).toMatchObject({
      kind: 'so_valor',
      writes: true
    })
  })

  it.each([
    [
      'enters through the rating count',
      { hypes: 0, totalRatingCount: 9 },
      0,
      10,
      'entra_no_filtro'
    ],
    [
      'enters through the hypes',
      { hypes: 4, totalRatingCount: 0 },
      5,
      0,
      'entra_no_filtro'
    ],
    [
      'leaves when both drop below',
      { hypes: 5, totalRatingCount: 0 },
      4,
      0,
      'sai_do_filtro'
    ],
    [
      'leaves when the count drops below',
      { hypes: 0, totalRatingCount: 10 },
      0,
      9,
      'sai_do_filtro'
    ],
    [
      'changes value but stays in',
      { hypes: 0, totalRatingCount: 30 },
      0,
      31,
      'so_valor'
    ],
    [
      'changes value but stays out',
      { hypes: 1, totalRatingCount: 2 },
      2,
      3,
      'so_valor'
    ],
    [
      'stays in when one criterion replaces the other',
      { hypes: 8, totalRatingCount: 0 },
      0,
      12,
      'so_valor'
    ]
  ])('%s', (_label, cache, hypes, count, kind) => {
    const result = classify(cache, hypes, count)

    expect(result.kind).toBe(kind)
    expect(result.writes).toBe(true)
    expect(result.next).toEqual({ hypes, totalRatingCount: count })
  })
})
