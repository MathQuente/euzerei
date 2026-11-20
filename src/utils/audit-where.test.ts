import { describe, it, expect } from 'vitest'
import { buildAuditWhere } from './audit-where'

const since = new Date('2026-11-13T12:00:00Z')

describe('buildAuditWhere', () => {
  it('only limits the period when there are no filters', () => {
    expect(buildAuditWhere({ since })).toEqual({ createdAt: { gte: since } })
  })

  it('maps the area from the query value to the database enum', () => {
    expect(buildAuditWhere({ since, area: 'moderation' })).toEqual({
      createdAt: { gte: since },
      area: 'MODERATION'
    })
  })

  it('searches action, target and detail, ignoring case', () => {
    const where = buildAuditWhere({ since, q: 'kenzo' })

    expect(where.OR).toEqual([
      { action: { contains: 'kenzo', mode: 'insensitive' } },
      { target: { contains: 'kenzo', mode: 'insensitive' } },
      { detail: { contains: 'kenzo', mode: 'insensitive' } }
    ])
  })

  it('escapes wildcards because Prisma does not (checked on 7.10.1 against Postgres)', () => {
    const where = buildAuditWhere({ since, q: '100%_a\\b' })

    expect(where.OR).toEqual([
      { action: { contains: '100\\%\\_a\\\\b', mode: 'insensitive' } },
      { target: { contains: '100\\%\\_a\\\\b', mode: 'insensitive' } },
      { detail: { contains: '100\\%\\_a\\\\b', mode: 'insensitive' } }
    ])
  })

  it('combines the area, the search and the period', () => {
    const where = buildAuditWhere({ since, area: 'users', q: 'senha' })

    expect(where).toMatchObject({
      createdAt: { gte: since },
      area: 'USERS'
    })
    expect(where.OR).toHaveLength(3)
  })
})
