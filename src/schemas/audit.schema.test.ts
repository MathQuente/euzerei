import { describe, it, expect } from 'vitest'
import {
  AUDIT_MAX_PAGE,
  AUDIT_MAX_QUERY_LENGTH,
  AuditListQuerySchema
} from './audit.schema'

const parse = (query: Record<string, string>) =>
  AuditListQuerySchema.safeParse(query)

describe('AuditListQuerySchema', () => {
  it('defaults to page 1 and the last 7 days, matching the board', () => {
    const result = parse({})

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ page: 1, period: 7 })
    expect(result.data?.area).toBeUndefined()
    expect(result.data?.q).toBeUndefined()
  })

  it('reads every parameter and turns period into a number', () => {
    expect(
      parse({ area: 'catalog', q: 'capas', page: '3', period: '30' })
    ).toMatchObject({
      success: true,
      data: { area: 'catalog', q: 'capas', page: 3, period: 30 }
    })
  })

  it('trims the search', () => {
    expect(parse({ q: '  kenzo  ' })).toMatchObject({
      data: { q: 'kenzo' }
    })
  })

  it('treats blank area and blank search as absent', () => {
    const result = parse({ area: '', q: '   ' })

    expect(result.success).toBe(true)
    expect(result.data?.area).toBeUndefined()
    expect(result.data?.q).toBeUndefined()
  })

  it.each(['users', 'imports', 'catalog', 'moderation', 'system'])(
    'accepts the area %s',
    area => {
      expect(parse({ area }).success).toBe(true)
    }
  )

  it.each([
    ['an unknown area', { area: 'banana' }],
    ['an upper case area', { area: 'USERS' }],
    ['page 0', { page: '0' }],
    ['a negative page', { page: '-1' }],
    ['a fractional page', { page: '1.5' }],
    ['a non numeric page', { page: 'abc' }],
    ['a page above the cap', { page: String(AUDIT_MAX_PAGE + 1) }],
    ['a period that is not offered', { period: '14' }],
    ['a period of 0', { period: '0' }],
    ['a search above the limit', { q: 'x'.repeat(AUDIT_MAX_QUERY_LENGTH + 1) }]
  ])('refuses %s', (_label, query) => {
    expect(parse(query).success).toBe(false)
  })

  it('accepts the page cap and the longest search', () => {
    expect(parse({ page: String(AUDIT_MAX_PAGE) }).success).toBe(true)
    expect(parse({ q: 'x'.repeat(AUDIT_MAX_QUERY_LENGTH) }).success).toBe(true)
  })
})
