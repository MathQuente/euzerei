import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AdminUsersService } from './admin-users.service'
import { ADMIN_USERS_PAGE_SIZE } from '../schemas/admin-users.schema'
import { TERMS_VERSION } from '../utils/terms'
import type { AdminUsersRepository } from '../repositories/admin-users.repository'

const repository = {
  findPage: vi.fn(),
  lastSeen: vi.fn(),
  summaryCounts: vi.fn(),
  findDetail: vi.fn()
}
const service = new AdminUsersService(
  repository as unknown as AdminUsersRepository
)

const NOW = new Date('2026-11-20T14:00:00Z')
const FORBIDDEN = [
  'password',
  'googleId',
  'discordId',
  'externalId',
  'tokenHash',
  'refreshToken'
]

function pageUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    userName: 'kenzo',
    email: 'kenzo@exemplo.com',
    emailVerifiedAt: new Date('2026-09-02T10:00:00Z'),
    role: 'USER',
    termsVersion: TERMS_VERSION,
    createdAt: new Date('2026-09-02T10:00:00Z'),
    _count: { userGames: 134 },
    accounts: [
      { platform: 'XBOX' },
      { platform: 'STEAM' },
      { platform: 'XBOX' }
    ],
    ...overrides
  }
}

function detailRows(overrides: Record<string, unknown> = {}) {
  return [
    {
      id: 'u1',
      userName: 'kenzo',
      email: 'kenzo@exemplo.com',
      emailVerifiedAt: null,
      role: 'ADMIN',
      hasPassword: true,
      googleId: 'g-secret',
      discordId: null,
      termsAcceptedAt: null,
      termsVersion: null,
      createdAt: new Date('2026-09-02T10:00:00Z'),
      ...overrides
    },
    [
      { userGamesStatusId: 7, _count: { id: 5 } },
      { userGamesStatusId: 9, _count: { id: 2 } }
    ],
    [
      { id: 7, status: 'PLAYED' },
      { id: 9, status: 'DROPPED' },
      { id: 11, status: 'BACKLOG' }
    ],
    { _sum: { hoursPlayed: { toString: () => '12.34' } } },
    2,
    [
      {
        platform: 'STEAM',
        displayName: 'kz',
        createdAt: new Date('2026-09-03T10:00:00Z'),
        statsSyncedAt: null
      }
    ],
    { _max: { createdAt: new Date('2026-11-20T13:00:00Z') } }
  ]
}

beforeEach(() => {
  repository.findPage.mockReset().mockResolvedValue([0, []])
  repository.lastSeen.mockReset().mockResolvedValue(new Map())
  repository.summaryCounts.mockReset().mockResolvedValue([72, 4])
  repository.findDetail.mockReset().mockResolvedValue(detailRows())
})

describe('AdminUsersService.list', () => {
  it('reads the page with the fixed size and the offset of the requested page', async () => {
    await service.list({ filter: 'all', page: 3 })

    expect(repository.findPage).toHaveBeenCalledWith(
      expect.any(Object),
      2 * ADMIN_USERS_PAGE_SIZE,
      ADMIN_USERS_PAGE_SIZE
    )
  })

  it('maps a row without leaking anything sensitive', async () => {
    repository.findPage.mockResolvedValue([
      1,
      [pageUser({ password: 'hash', googleId: 'g', discordId: 'd' })]
    ])
    repository.lastSeen.mockResolvedValue(
      new Map([['u1', new Date('2026-11-20T13:00:00Z')]])
    )

    const result = await service.list({ filter: 'all', page: 1 })

    expect(result).toEqual({
      items: [
        {
          id: 'u1',
          handle: 'kenzo',
          email: 'kenzo@exemplo.com',
          emailVerified: true,
          role: 'user',
          suspended: false,
          stores: ['steam', 'xbox'],
          games: 134,
          lastSeenAt: '2026-11-20T13:00:00.000Z',
          termsAccepted: true
        }
      ],
      page: 1,
      pageSize: ADMIN_USERS_PAGE_SIZE,
      total: 1
    })
    const json = JSON.stringify(result)
    FORBIDDEN.forEach(key => expect(json).not.toContain(key))
  })

  it('a user with no session has no last access, and an old terms version is not accepted', async () => {
    repository.findPage.mockResolvedValue([
      1,
      [pageUser({ termsVersion: null, emailVerifiedAt: null, accounts: [] })]
    ])

    const { items } = await service.list({ filter: 'all', page: 1 })

    expect(items[0]).toMatchObject({
      lastSeenAt: null,
      termsAccepted: false,
      emailVerified: false,
      stores: []
    })
  })

  it('an out-of-range page is an empty list that still carries the total', async () => {
    repository.findPage.mockResolvedValue([41, []])

    const result = await service.list({ filter: 'all', page: 9999 })

    expect(result).toMatchObject({ items: [], total: 41, page: 9999 })
  })

  it('does not look for sessions when the page is empty', async () => {
    await service.list({ filter: 'all', page: 1 })

    expect(repository.lastSeen).toHaveBeenCalledWith([])
  })
})

describe('AdminUsersService.summary', () => {
  it('counts activity over the last 7 days', async () => {
    const result = await service.summary(NOW)

    expect(result).toEqual({ total: 72, active7d: 4 })
    expect(repository.summaryCounts).toHaveBeenCalledWith(
      new Date('2026-11-13T14:00:00Z')
    )
  })
})

describe('AdminUsersService.detail', () => {
  it('answers 404 for an unknown user', async () => {
    repository.findDetail.mockResolvedValue([null, [], [], {}, 0, [], {}])

    await expect(service.detail('nope', NOW)).rejects.toMatchObject({
      statusCode: 404
    })
  })

  it('maps the library by status name, not by id, and totals every game', async () => {
    const result = await service.detail('u1', NOW)

    expect(result.library).toEqual({
      total: 7,
      played: 5,
      playing: 0,
      paused: 0,
      backlog: 0,
      wishlist: 0,
      dropped: 2
    })
  })

  it('derives booleans for the sign-in methods and exposes no provider id', async () => {
    const result = await service.detail('u1', NOW)

    expect(result.login).toEqual({
      hasPassword: true,
      hasGoogle: true,
      hasDiscord: false
    })
    const json = JSON.stringify(result)
    FORBIDDEN.forEach(key => expect(json).not.toContain(key))
    expect(json).not.toContain('g-secret')
  })

  it('rounds the hours, counts the active sessions and reports terms and last access', async () => {
    const result = await service.detail('u1', NOW)

    expect(result).toMatchObject({
      hours: 12.3,
      sessions: { active: 2 },
      lastSeenAt: '2026-11-20T13:00:00.000Z',
      emailVerifiedAt: null,
      role: 'admin',
      terms: { acceptedAt: null, version: null, current: false },
      accounts: [{ platform: 'steam', displayName: 'kz', syncedAt: null }]
    })
  })

  it('zero hours when the user has no account hours', async () => {
    const rows = detailRows() as unknown[]
    rows[3] = { _sum: { hoursPlayed: null } }
    repository.findDetail.mockResolvedValue(rows)

    const result = await service.detail('u1', NOW)

    expect(result.hours).toBe(0)
  })
})
