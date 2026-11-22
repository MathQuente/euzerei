import { describe, it, expect } from 'vitest'
import {
  CATALOG_MAX_DAYS,
  CatalogGameParamsSchema,
  CatalogSearchQuerySchema,
  CatalogTopAddedQuerySchema
} from './admin-catalog.schema'

describe('CatalogSearchQuerySchema', () => {
  it('trims the query', () => {
    expect(CatalogSearchQuerySchema.parse({ q: '  hades ' })).toEqual({
      q: 'hades'
    })
  })

  it.each([{}, { q: '' }, { q: '   ' }, { q: 'a'.repeat(101) }])(
    'refuses %o',
    query => {
      expect(CatalogSearchQuerySchema.safeParse(query).success).toBe(false)
    }
  )

  it('accepts 100 characters', () => {
    expect(
      CatalogSearchQuerySchema.safeParse({ q: 'a'.repeat(100) }).success
    ).toBe(true)
  })
})

describe('CatalogGameParamsSchema', () => {
  it('reads an id', () => {
    expect(CatalogGameParamsSchema.parse({ igdbId: '7346' })).toEqual({
      igdbId: 7346
    })
  })

  it.each(['0', '-1', '1.5', 'abc', '2147483648', ''])('refuses %s', igdbId => {
    expect(CatalogGameParamsSchema.safeParse({ igdbId }).success).toBe(false)
  })
})

describe('CatalogTopAddedQuerySchema', () => {
  it('defaults to 7 days, also for a blank value', () => {
    expect(CatalogTopAddedQuerySchema.parse({}).days).toBe(7)
    expect(CatalogTopAddedQuerySchema.parse({ days: '' }).days).toBe(7)
  })

  it('reads days up to the cap', () => {
    expect(CatalogTopAddedQuerySchema.parse({ days: '30' }).days).toBe(
      CATALOG_MAX_DAYS
    )
  })

  it.each(['0', '31', '-1', '1.5', 'abc'])('refuses days=%s', days => {
    expect(CatalogTopAddedQuerySchema.safeParse({ days }).success).toBe(false)
  })
})
