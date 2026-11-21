import { describe, it, expect } from 'vitest'
import { buildAdminUsersWhere } from './admin-users-where'
import { TERMS_VERSION } from './terms'

describe('buildAdminUsersWhere', () => {
  it('has no criteria beyond an empty filter when nothing is asked', () => {
    expect(buildAdminUsersWhere({ filter: 'all' })).toEqual({ AND: [{}] })
  })

  it('email pending means no verification date', () => {
    expect(buildAdminUsersWhere({ filter: 'emailPending' })).toEqual({
      AND: [{ emailVerifiedAt: null }]
    })
  })

  it('no store means no platform account at all', () => {
    expect(buildAdminUsersWhere({ filter: 'noStore' })).toEqual({
      AND: [{ accounts: { none: {} } }]
    })
  })

  it('no terms includes the users whose version is null, which `not` alone would skip', () => {
    expect(buildAdminUsersWhere({ filter: 'noTerms' })).toEqual({
      AND: [
        {
          OR: [{ termsVersion: null }, { termsVersion: { not: TERMS_VERSION } }]
        }
      ]
    })
  })

  it('searches handle and email, case-insensitive', () => {
    const where = buildAdminUsersWhere({ filter: 'all', q: 'Kenzo' })

    expect(where.AND).toContainEqual({
      OR: [
        { userName: { contains: 'Kenzo', mode: 'insensitive' } },
        { email: { contains: 'Kenzo', mode: 'insensitive' } }
      ]
    })
  })

  it('escapes %, _ and backslash so they are searched literally', () => {
    const where = buildAdminUsersWhere({ filter: 'all', q: '50%_a\\b' })

    expect(where.AND).toContainEqual({
      OR: [
        { userName: { contains: '50\\%\\_a\\\\b', mode: 'insensitive' } },
        { email: { contains: '50\\%\\_a\\\\b', mode: 'insensitive' } }
      ]
    })
  })

  it('drops a leading @ and ignores a search that was only @', () => {
    const withAt = buildAdminUsersWhere({ filter: 'all', q: '@kenzo' })
    const onlyAt = buildAdminUsersWhere({ filter: 'all', q: '@' })

    expect(JSON.stringify(withAt)).toContain('"contains":"kenzo"')
    expect(onlyAt).toEqual({ AND: [{}] })
  })

  it('combines the filter and the search', () => {
    const where = buildAdminUsersWhere({ filter: 'emailPending', q: 'a' })

    expect(where.AND).toHaveLength(2)
  })
})
