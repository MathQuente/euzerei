import { Prisma } from '../database/prisma-client'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { UserService } from './users.service'
import { IGDBService } from './igdb.service'
import { GameCacheService } from './game-cache.service'
import { UserRepository } from '../repositories/users.repository'
import { PaginatedUserGameRow } from '../types/user'
import { RatingRepository } from '../repositories/rating.repository'
import { FollowRepository } from '../repositories/follow.repository'
import { ClientError } from '../errors/client-error'
import { CacheRepository } from '../repositories/cache.repository'
import { CloudinaryService } from './cloudinary.service'

function fakeUserRepository(
  overrides: Partial<UserRepository> = {}
): UserRepository {
  return {
    findUserGameStats: vi.fn().mockResolvedValue({ stats: null }),
    findLibraryIgdbIds: vi.fn().mockResolvedValue([]),
    ...overrides
  } as unknown as UserRepository
}

function fakeRatingRepository(
  overrides: Partial<RatingRepository> = {}
): RatingRepository {
  return { ...overrides } as unknown as RatingRepository
}

function fakeFollowRepository(
  overrides: Partial<FollowRepository> = {}
): FollowRepository {
  return { ...overrides } as unknown as FollowRepository
}

function fakeGameCacheService(
  overrides: Partial<GameCacheService> = {}
): GameCacheService {
  return {
    ensureCached: vi.fn().mockResolvedValue(true),
    cacheMany: vi.fn().mockResolvedValue(undefined),
    findSlug: vi.fn().mockResolvedValue(null),
    suggestsEndless: vi.fn().mockResolvedValue(false),
    assertReleased: vi.fn().mockResolvedValue({ suggestsEndless: false }),
    ...overrides
  } as unknown as GameCacheService
}

function statusCounts(counts: Partial<Record<string, number>>) {
  const all = ['PLAYED', 'PLAYING', 'PAUSED', 'BACKLOG', 'WISHLIST', 'DROPPED']
  return all.map(status => ({
    status,
    _count: { userGames: counts[status] ?? 0 }
  }))
}

describe('UserService.addGameToUserLibrary', () => {
  it('throws ClientError when the igdbId is not a real IGDB game', async () => {
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' })
    })
    const gameCacheService = fakeGameCacheService({
      ensureCached: vi.fn().mockResolvedValue(false)
    })
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      gameCacheService,
      fakeFollowRepository()
    )

    await expect(
      service.addGameToUserLibrary(999999, 'user-1', 1)
    ).rejects.toThrow(ClientError)
  })

  it('adds the game when the igdbId is a real IGDB game', async () => {
    const addGameToUserLibrary = vi.fn().mockResolvedValue({ igdbId: 1022 })
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      findUserGame: vi.fn().mockResolvedValue(null),
      addGameToUserLibrary,
      createUserGameStats: vi.fn().mockResolvedValue({ completions: 0 })
    })
    const gameCacheService = fakeGameCacheService()
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      gameCacheService,
      fakeFollowRepository()
    )

    const result = await service.addGameToUserLibrary(1022, 'user-1', 1)

    expect(addGameToUserLibrary).toHaveBeenCalledWith({
      igdbId: 1022,
      statusIds: 1,
      userId: 'user-1',
      endless: false
    })
    expect(result).toEqual({ igdbId: 1022 })
  })

  it('marks the game as endless when the cached modes suggest it', async () => {
    const addGameToUserLibrary = vi.fn().mockResolvedValue({ igdbId: 7 })
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      findUserGame: vi.fn().mockResolvedValue(null),
      addGameToUserLibrary,
      createUserGameStats: vi.fn().mockResolvedValue(undefined)
    })
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService({
        suggestsEndless: vi.fn().mockResolvedValue(true)
      }),
      fakeFollowRepository()
    )

    await service.addGameToUserLibrary(7, 'user-1', 3)

    expect(addGameToUserLibrary).toHaveBeenCalledWith({
      igdbId: 7,
      statusIds: 3,
      userId: 'user-1',
      endless: true
    })
  })
})

describe('UserService.findUserGameStatus', () => {
  function build(found: unknown) {
    return new UserService(
      fakeUserRepository({
        findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
        findUserGameStatus: vi.fn().mockResolvedValue(found)
      }),
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )
  }

  it('returns the status, the endless mark and the totals', async () => {
    const service = build({
      endless: true,
      UserGamesStatus: { id: 4, status: 'BACKLOG' },
      UserGameStats: {
        hoursPlayed: new Prisma.Decimal('108.5'),
        completions: 4
      }
    })

    await expect(service.findUserGameStatus(7, 'user-1')).resolves.toEqual({
      userGameStatus: { id: 4, status: 'BACKLOG' },
      endless: true,
      hundredPercent: false,
      hoursPlayed: 108.5,
      completions: 4
    })
  })

  it.each([
    [
      'without stats',
      {
        endless: false,
        hundredPercent: false,
        UserGamesStatus: { id: 3, status: 'PLAYING' },
        UserGameStats: null
      }
    ],
    [
      'with null hours',
      {
        endless: false,
        hundredPercent: false,
        UserGamesStatus: { id: 3, status: 'PLAYING' },
        UserGameStats: { hoursPlayed: null, completions: 0 }
      }
    ]
  ])('returns zero totals %s', async (_label, found) => {
    const service = build(found)

    await expect(
      service.findUserGameStatus(7, 'user-1')
    ).resolves.toMatchObject({
      hoursPlayed: 0,
      completions: 0
    })
  })

  it('returns null status and zero totals when the game is not in the library', async () => {
    const service = build(null)

    await expect(service.findUserGameStatus(7, 'user-1')).resolves.toEqual({
      userGameStatus: null,
      endless: false,
      hundredPercent: false,
      hoursPlayed: 0,
      completions: 0
    })
  })
})

describe('UserService.setEndless', () => {
  it('toggles the flag for a game in the library', async () => {
    const setEndless = vi.fn().mockResolvedValue({ igdbId: 7, endless: true })
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      findUserGame: vi.fn().mockResolvedValue({ id: 'ug-7' }),
      setEndless
    })
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )

    const result = await service.setEndless(7, 'user-1', true)

    expect(setEndless).toHaveBeenCalledWith(7, 'user-1', true)
    expect(result).toEqual({ igdbId: 7, endless: true })
  })

  it('throws 404 when the game is not in the library', async () => {
    const setEndless = vi.fn()
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      findUserGame: vi.fn().mockResolvedValue(null),
      setEndless
    })
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )

    await expect(service.setEndless(7, 'user-1', true)).rejects.toThrow(
      ClientError
    )
    expect(setEndless).not.toHaveBeenCalled()
  })
})

describe('UserService.setEndless race', () => {
  it('throws 404 when the game leaves the library between the check and the update', async () => {
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      findUserGame: vi.fn().mockResolvedValue({ id: 'ug-7' }),
      setEndless: vi.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('not found', {
          code: 'P2025',
          clientVersion: 'test'
        })
      )
    })
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )

    await expect(service.setEndless(7, 'user-1', true)).rejects.toMatchObject({
      statusCode: 404
    })
  })
})

describe('UserService.addGameToUserLibrary completions', () => {
  it.each([
    ['played', 1, 1],
    ['in the queue', 4, 0],
    ['on the wishlist', 5, 0]
  ])(
    'creates the stats with the right completions when added as %s',
    async (_label, statusId, expected) => {
      const createUserGameStats = vi
        .fn()
        .mockResolvedValue({ completions: expected })
      const userRepository = fakeUserRepository({
        findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
        findUserGame: vi.fn().mockResolvedValue(null),
        addGameToUserLibrary: vi.fn().mockResolvedValue({ igdbId: 1022 }),
        createUserGameStats
      })
      const service = new UserService(
        userRepository,
        fakeRatingRepository(),
        fakeGameCacheService(),
        fakeFollowRepository()
      )

      await service.addGameToUserLibrary(1022, 'user-1', statusId)

      expect(createUserGameStats).toHaveBeenCalledWith('user-1', 1022, expected)
    }
  )
})

describe('UserService.updateGame keeps the completion history', () => {
  function serviceFor(currentStatus: number, completions: number) {
    const ensureAtLeastOneCompletion = vi
      .fn()
      .mockResolvedValue({ completions: Math.max(completions, 1) })
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      findUserGame: vi.fn().mockResolvedValue({
        id: 'ug-1',
        UserGamesStatus: { id: currentStatus },
        _count: { platforms: 0 }
      }),
      updateGameStatus: vi
        .fn()
        .mockImplementation(async (igdbId, _u, statusId) => ({
          igdbId,
          UserGamesStatus: { id: statusId, status: 'X' }
        })),
      findUserGameStats: vi.fn().mockResolvedValue({ stats: { completions } }),
      ensureAtLeastOneCompletion
    })
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )
    return { service, userRepository, ensureAtLeastOneCompletion }
  }

  it.each([
    ['playing', 3],
    ['dropped', 6],
    ['paused', 2]
  ])(
    'keeps the completions when a played game without platforms moves to %s',
    async (_label, statusId) => {
      const { service } = serviceFor(1, 2)

      const result = await service.updateGame(1, 'user-1', statusId)

      expect(result.playedCountUpdated).toBe(2)
    }
  )

  it('keeps a higher count when the game comes back to played', async () => {
    const { service, ensureAtLeastOneCompletion } = serviceFor(3, 2)

    const result = await service.updateGame(1, 'user-1', 1)

    expect(ensureAtLeastOneCompletion).toHaveBeenCalledWith('user-1', 1)
    expect(result.playedCountUpdated).toBe(2)
  })

  it('sets one completion, without adding, when an endless game becomes played', async () => {
    const updateUserGamePlayedCount = vi.fn()
    const ensureAtLeastOneCompletion = vi
      .fn()
      .mockResolvedValue({ completions: 1 })
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      findUserGame: vi.fn().mockResolvedValue({
        id: 'ug-1',
        endless: true,
        UserGamesStatus: { id: 3 },
        _count: { platforms: 0 }
      }),
      updateGameStatus: vi.fn().mockResolvedValue({
        igdbId: 1,
        UserGamesStatus: { id: 1, status: 'PLAYED' }
      }),
      ensureAtLeastOneCompletion,
      updateUserGamePlayedCount
    })
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )

    const result = await service.updateGame(1, 'user-1', 1)

    expect(result.playedCountUpdated).toBe(1)
    expect(ensureAtLeastOneCompletion).toHaveBeenCalledWith('user-1', 1)
    expect(updateUserGamePlayedCount).not.toHaveBeenCalled()
  })

  it('counts one completion when a game with none becomes played', async () => {
    const { service } = serviceFor(3, 0)

    const result = await service.updateGame(1, 'user-1', 1)

    expect(result.playedCountUpdated).toBe(1)
  })
})

describe('UserService.findManyUserGames', () => {
  it('throws ClientError when the user does not exist', async () => {
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue(null)
    })
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )

    await expect(
      service.findManyUserGames(
        'missing-user',
        0,
        undefined,
        undefined,
        'gameName',
        'asc'
      )
    ).rejects.toThrow(ClientError)
  })

  it('calls the repository with skip/take derived from pageIndex when a status filter is set', async () => {
    const findManyGamesOfUser = vi.fn().mockResolvedValue([])
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      findManyGamesOfUser,
      findGamesCountByStatus: vi.fn().mockResolvedValue(statusCounts({}))
    })
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )

    await service.findManyUserGames(
      'user-1',
      2,
      'PLAYED',
      undefined,
      'rating',
      'desc'
    )

    expect(findManyGamesOfUser).toHaveBeenCalledWith({
      userId: 'user-1',
      filter: 'PLAYED',
      query: undefined,
      sortBy: 'rating',
      sortOrder: 'desc',
      skip: 96,
      take: 48
    })
  })

  it('fetches a preview per status when no status filter is set, so one large bucket cannot crowd the others out', async () => {
    const findManyGamesOfUser = vi.fn().mockResolvedValue([])
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      findManyGamesOfUser,
      findGamesCountByStatus: vi.fn().mockResolvedValue(statusCounts({}))
    })
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )

    await service.findManyUserGames(
      'user-1',
      0,
      undefined,
      undefined,
      'rating',
      'desc'
    )

    expect(findManyGamesOfUser).toHaveBeenCalledWith({
      userId: 'user-1',
      filter: undefined,
      query: undefined,
      sortBy: 'rating',
      sortOrder: 'desc',
      skip: undefined,
      take: undefined,
      previewPerStatus: 24,
      uncappedStatuses: ['PLAYING']
    })
  })

  it('lists the queue (backlog plus dropped) with the summed total', async () => {
    const findManyGamesOfUser = vi.fn().mockResolvedValue([])
    const service = new UserService(
      fakeUserRepository({
        findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
        findManyGamesOfUser,
        findGamesCountByStatus: vi
          .fn()
          .mockResolvedValue(
            statusCounts({ BACKLOG: 30, DROPPED: 5, PLAYED: 9 })
          )
      }),
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )

    const result = await service.findManyUserGames(
      'user-1',
      1,
      'QUEUE',
      undefined,
      'dateAdded',
      'desc'
    )

    expect(findManyGamesOfUser).toHaveBeenCalledWith(
      expect.objectContaining({ filter: 'QUEUE', skip: 48, take: 48 })
    )
    expect(result.total).toBe(35)
  })

  it('puts every queue row in one group, keeping the order they came in', async () => {
    const entry = (igdbId: number, status: string) => ({
      igdbId,
      status: status as PaginatedUserGameRow['status'],
      name: `Jogo ${igdbId}`,
      slug: `jogo-${igdbId}`,
      coverUrl: null,
      platforms: [],
      releaseDate: null,
      rating: null,
      completions: 0,
      hoursPlayed: 0,
      playedOn: [],
      endless: false,
      hundredPercent: false
    })
    const service = new UserService(
      fakeUserRepository({
        findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
        findManyGamesOfUser: vi
          .fn()
          .mockResolvedValue([
            entry(1, 'BACKLOG'),
            entry(2, 'DROPPED'),
            entry(3, 'BACKLOG')
          ]),
        findGamesCountByStatus: vi
          .fn()
          .mockResolvedValue(statusCounts({ BACKLOG: 2, DROPPED: 1 }))
      }),
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )

    const { games } = await service.findManyUserGames(
      'user-1',
      0,
      'QUEUE',
      undefined
    )

    expect(games.BACKLOG.map(g => [g.igdbId, g.status])).toEqual([
      [1, 'BACKLOG'],
      [2, 'DROPPED'],
      [3, 'BACKLOG']
    ])
    expect(games.DROPPED).toEqual([])
  })

  it('keeps counting a single status on its own', async () => {
    const service = new UserService(
      fakeUserRepository({
        findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
        findManyGamesOfUser: vi.fn().mockResolvedValue([]),
        findGamesCountByStatus: vi
          .fn()
          .mockResolvedValue(statusCounts({ BACKLOG: 30, DROPPED: 5 }))
      }),
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )

    const backlog = await service.findManyUserGames(
      'user-1',
      0,
      'BACKLOG',
      undefined
    )
    const dropped = await service.findManyUserGames(
      'user-1',
      0,
      'DROPPED',
      undefined
    )

    expect(backlog.total).toBe(30)
    expect(dropped.total).toBe(5)
  })

  it('sends the last-change date of each game as an ISO string', async () => {
    const row = {
      igdbId: 7,
      status: 'DROPPED' as PaginatedUserGameRow['status'],
      name: 'Jogo 7',
      slug: 'jogo-7',
      coverUrl: null,
      platforms: [],
      releaseDate: null,
      rating: null,
      completions: 0,
      hoursPlayed: 0,
      playedOn: [],
      endless: false,
      hundredPercent: false,
      updatedAt: new Date('2026-11-10T12:00:00.000Z')
    }
    const service = new UserService(
      fakeUserRepository({
        findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
        findManyGamesOfUser: vi.fn().mockResolvedValue([row]),
        findGamesCountByStatus: vi
          .fn()
          .mockResolvedValue(statusCounts({ DROPPED: 1 }))
      }),
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )

    const { games } = await service.findManyUserGames(
      'user-1',
      0,
      undefined,
      undefined
    )

    expect(games.DROPPED[0].updatedAt).toBe('2026-11-10T12:00:00.000Z')
  })

  it('groups the paginated rows by status', async () => {
    const rows: PaginatedUserGameRow[] = [
      {
        igdbId: 1,
        status: 'PLAYED' as PaginatedUserGameRow['status'],
        name: 'Game A',
        slug: null,
        coverUrl: null,
        platforms: ['PC'],
        releaseDate: 100,
        rating: 4,
        completions: 0,
        hoursPlayed: 0,
        playedOn: [],
        endless: false,
        hundredPercent: false
      },
      {
        igdbId: 2,
        status: 'BACKLOG' as PaginatedUserGameRow['status'],
        name: 'Game B',
        slug: null,
        coverUrl: null,
        platforms: [],
        releaseDate: 200,
        rating: null,
        completions: 0,
        hoursPlayed: 0,
        playedOn: [],
        endless: false,
        hundredPercent: false
      }
    ]
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      findManyGamesOfUser: vi.fn().mockResolvedValue(rows),
      findGamesCountByStatus: vi
        .fn()
        .mockResolvedValue(statusCounts({ PLAYED: 1, BACKLOG: 1 }))
    })
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )

    const result = await service.findManyUserGames(
      'user-1',
      0,
      undefined,
      undefined,
      'gameName',
      'asc'
    )

    expect(result.games.PLAYED.map(g => g.igdbId)).toEqual([1])
    expect(result.games.BACKLOG.map(g => g.igdbId)).toEqual([2])
    expect(result.total).toBe(2)
  })

  it('backfills name/coverUrl/releaseDate from IGDB only for rows missing games_cache data', async () => {
    const rows: PaginatedUserGameRow[] = [
      {
        igdbId: 1,
        status: 'PLAYED' as PaginatedUserGameRow['status'],
        name: 'Cached Game',
        slug: null,
        coverUrl: 'https://img/cached.jpg',
        platforms: ['PC'],
        releaseDate: 100,
        rating: 4,
        completions: 0,
        hoursPlayed: 0,
        playedOn: [],
        endless: false,
        hundredPercent: false
      },
      {
        igdbId: 99,
        status: 'BACKLOG' as PaginatedUserGameRow['status'],
        name: null,
        slug: null,
        coverUrl: null,
        platforms: null,
        releaseDate: null,
        rating: null,
        completions: 0,
        hoursPlayed: 0,
        playedOn: [],
        endless: false,
        hundredPercent: false
      }
    ]
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      findManyGamesOfUser: vi.fn().mockResolvedValue(rows),
      findGamesCountByStatus: vi
        .fn()
        .mockResolvedValue(statusCounts({ PLAYED: 1, BACKLOG: 1 }))
    })
    const getGamesByIds = vi
      .spyOn(IGDBService, 'getGamesByIds')
      .mockResolvedValue([
        {
          id: 99,
          name: 'Fetched Game',
          cover: { url: '//img/thumb.jpg' },
          platforms: [{ name: 'Switch' }],
          first_release_date: 555
        }
      ] as Awaited<ReturnType<typeof IGDBService.getGamesByIds>>)
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )

    const result = await service.findManyUserGames(
      'user-1',
      0,
      undefined,
      undefined,
      'gameName',
      'asc'
    )

    expect(getGamesByIds).toHaveBeenCalledWith([99])
    expect(result.games.BACKLOG[0]).toMatchObject({
      igdbId: 99,
      name: 'Fetched Game',
      releaseDate: 555
    })

    getGamesByIds.mockRestore()
  })

  it('maps a null releaseDate from the repository to undefined in the response', async () => {
    const rows: PaginatedUserGameRow[] = [
      {
        igdbId: 1,
        status: 'WISHLIST' as PaginatedUserGameRow['status'],
        name: 'No Release Date',
        slug: null,
        coverUrl: null,
        platforms: [],
        releaseDate: null,
        rating: null,
        completions: 0,
        hoursPlayed: 0,
        playedOn: [],
        endless: false,
        hundredPercent: false
      }
    ]
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      findManyGamesOfUser: vi.fn().mockResolvedValue(rows),
      findGamesCountByStatus: vi
        .fn()
        .mockResolvedValue(statusCounts({ WISHLIST: 1 }))
    })
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )

    const result = await service.findManyUserGames(
      'user-1',
      0,
      undefined,
      undefined,
      'gameName',
      'asc'
    )

    expect(result.games.WISHLIST[0].releaseDate).toBeUndefined()
  })
})

describe('UserService.findManyUserGames overview', () => {
  function build(overrides: Partial<UserRepository> = {}) {
    const findManyGamesOfUser = vi.fn().mockResolvedValue([])
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      findManyGamesOfUser,
      findGamesCountByStatus: vi
        .fn()
        .mockResolvedValue(statusCounts({ PLAYED: 40, BACKLOG: 266 })),
      findLibraryIgdbIds: vi.fn().mockResolvedValue([1, 2, 3]),
      ...overrides
    })
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )
    return { service, findManyGamesOfUser, userRepository }
  }

  it('returns the exact totals and the ids of the whole library next to the preview', async () => {
    const { service } = build()

    const result = await service.findManyUserGames(
      'user-1',
      0,
      undefined,
      undefined
    )

    expect(result.total).toBe(306)
    expect(result.totalPerStatus.find(t => t.status === 'BACKLOG')).toEqual({
      status: 'BACKLOG',
      totalGames: 266
    })
    expect(result.libraryIgdbIds).toEqual([1, 2, 3])
  })

  it('does not return the library ids for a filtered page', async () => {
    const { service, userRepository } = build()

    const result = await service.findManyUserGames(
      'user-1',
      0,
      'PLAYED',
      undefined
    )

    expect(result).not.toHaveProperty('libraryIgdbIds')
    expect(userRepository.findLibraryIgdbIds).not.toHaveBeenCalled()
  })

  it('never cuts the playing shelf, so the now and endless tabs see every game', async () => {
    const { service, findManyGamesOfUser } = build()

    await service.findManyUserGames('user-1', 0, undefined, undefined)

    expect(findManyGamesOfUser).toHaveBeenCalledWith(
      expect.objectContaining({ uncappedStatuses: ['PLAYING'] })
    )
  })

  it('does not cut a search that has no status filter', async () => {
    const { service, findManyGamesOfUser } = build()

    const result = await service.findManyUserGames(
      'user-1',
      0,
      undefined,
      'zelda'
    )

    expect(findManyGamesOfUser).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'zelda', previewPerStatus: undefined })
    )
    expect(result).not.toHaveProperty('libraryIgdbIds')
  })

  it('treats an empty search like no search', async () => {
    const { service, findManyGamesOfUser } = build()

    await service.findManyUserGames('user-1', 0, undefined, '')

    expect(findManyGamesOfUser).toHaveBeenCalledWith(
      expect.objectContaining({ previewPerStatus: 24 })
    )
  })

  it('only completes the games of the preview from IGDB', async () => {
    const getGamesByIds = vi
      .spyOn(IGDBService, 'getGamesByIds')
      .mockResolvedValue([])
    const { service } = build({
      findManyGamesOfUser: vi.fn().mockResolvedValue([
        {
          igdbId: 7,
          status: 'BACKLOG',
          name: null,
          slug: null,
          coverUrl: null,
          platforms: null,
          releaseDate: null,
          rating: null,
          completions: 0,
          hoursPlayed: 0,
          playedOn: [],
          endless: false,
          hundredPercent: false
        }
      ])
    })

    await service.findManyUserGames('user-1', 0, undefined, undefined)

    expect(getGamesByIds).toHaveBeenCalledWith([7])
    getGamesByIds.mockRestore()
  })
})

describe('UserService.findPublicUserGames', () => {
  it('asks the repository for 6 games per status and returns no library ids', async () => {
    const findManyGamesOfUser = vi.fn().mockResolvedValue([])
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      findManyGamesOfUser,
      findGamesCountByStatus: vi.fn().mockResolvedValue(statusCounts({})),
      findLibraryIgdbIds: vi.fn().mockResolvedValue([1])
    })
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )

    const result = await service.findPublicUserGames('user-1')

    expect(findManyGamesOfUser).toHaveBeenCalledWith(
      expect.objectContaining({
        sortBy: 'completedAt',
        sortOrder: 'desc',
        previewPerStatus: 6,
        uncappedStatuses: ['PLAYING']
      })
    )
    expect(result).not.toHaveProperty('libraryIgdbIds')
    expect(userRepository.findLibraryIgdbIds).not.toHaveBeenCalled()
  })
})

describe('UserService.findGamesToDisplay', () => {
  function serviceWithLibrary(rows: Array<{ igdbId: number; status: string }>) {
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      findManyGamesOfUser: vi.fn().mockResolvedValue(rows)
    })
    return new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )
  }

  it('suggests a paused game before any backlog game', async () => {
    const getGameById = vi
      .spyOn(IGDBService, 'getGameById')
      .mockResolvedValue({ id: 20, name: 'Paused game' })
    const service = serviceWithLibrary([
      { igdbId: 10, status: 'BACKLOG' },
      { igdbId: 20, status: 'PAUSED' },
      { igdbId: 30, status: 'DROPPED' }
    ])

    const result = await service.findGamesToDisplay('user-1')

    expect(getGameById).toHaveBeenCalledWith(20)
    expect(result.game?.igdbId).toBe(20)
    expect(result.message).toBe('Que tal retomar este?')
    getGameById.mockRestore()
  })

  it('falls back to the backlog when nothing is paused', async () => {
    const getGameById = vi
      .spyOn(IGDBService, 'getGameById')
      .mockResolvedValue({ id: 10, name: 'Backlog game' })
    const service = serviceWithLibrary([
      { igdbId: 10, status: 'BACKLOG' },
      { igdbId: 30, status: 'DROPPED' }
    ])

    const result = await service.findGamesToDisplay('user-1')

    expect(getGameById).toHaveBeenCalledWith(10)
    expect(result.message).toBe('Tire a poeira desses jogos esquecidos.')
    getGameById.mockRestore()
  })

  it('returns no game when the picked one cannot be fetched from IGDB', async () => {
    const getGameById = vi
      .spyOn(IGDBService, 'getGameById')
      .mockResolvedValue(null)
    const service = serviceWithLibrary([{ igdbId: 10, status: 'PAUSED' }])

    const result = await service.findGamesToDisplay('user-1')

    expect(result).toEqual({ game: null, message: 'Que tal retomar este?' })
    getGameById.mockRestore()
  })

  it('suggests a recent release the user does not own when nothing is paused or in the backlog', async () => {
    const recent = vi
      .spyOn(IGDBService, 'getRecentlyReleasedGames')
      .mockResolvedValue([
        { id: 1, name: 'Owned' },
        { id: 2, name: 'New one' }
      ] as never)
    const service = serviceWithLibrary([
      { igdbId: 1, status: 'PLAYED' },
      { igdbId: 30, status: 'DROPPED' }
    ])

    const result = await service.findGamesToDisplay('user-1')

    expect(result.game?.igdbId).toBe(2)
    expect(result.message).toBe(
      'Que tal adicionar um novo jogo a sua biblioteca?'
    )
    recent.mockRestore()
  })

  it('congratulates the user when every recent release is already in the library', async () => {
    const recent = vi
      .spyOn(IGDBService, 'getRecentlyReleasedGames')
      .mockResolvedValue([{ id: 1, name: 'Owned' }] as never)
    const service = serviceWithLibrary([{ igdbId: 1, status: 'PLAYED' }])

    const result = await service.findGamesToDisplay('user-1')

    expect(result).toEqual({
      game: null,
      message: 'Parabéns! Você jogou todos.'
    })
    recent.mockRestore()
  })
})

describe('UserService.updateGame', () => {
  it('moves to WISHLIST through moveToWishlist, not a plain status update', async () => {
    const moveToWishlist = vi.fn().mockResolvedValue({
      igdbId: 11133,
      UserGamesStatus: { id: 5, status: 'WISHLIST' }
    })
    const updateGameStatus = vi.fn()
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      findUserGame: vi.fn().mockResolvedValue({
        id: 'ug-1',
        UserGamesStatus: { id: 3 },
        _count: { platforms: 2 }
      }),
      moveToWishlist,
      updateGameStatus
    })
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )

    const result = await service.updateGame(11133, 'user-1', 5)

    expect(moveToWishlist).toHaveBeenCalledWith(11133, 'user-1', 5)
    expect(updateGameStatus).not.toHaveBeenCalled()
    expect(result).toEqual({
      igdbId: 11133,
      userGameStatus: { id: 5, status: 'WISHLIST' },
      playedCountUpdated: 0
    })
  })

  it('keeps the plain status update when the game is already on the WISHLIST', async () => {
    const moveToWishlist = vi.fn()
    const updateGameStatus = vi.fn().mockResolvedValue({
      igdbId: 11133,
      UserGamesStatus: { id: 5, status: 'WISHLIST' }
    })
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      findUserGame: vi.fn().mockResolvedValue({ UserGamesStatus: { id: 5 } }),
      moveToWishlist,
      updateGameStatus
    })
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )

    await service.updateGame(11133, 'user-1', 5)

    expect(moveToWishlist).not.toHaveBeenCalled()
    expect(updateGameStatus).toHaveBeenCalled()
  })

  it('does not touch the rating when moving to a non-WISHLIST status', async () => {
    const findUniqueByUserGame = vi.fn()
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      findUserGame: vi.fn().mockResolvedValue({ UserGamesStatus: { id: 5 } }),
      updateGameStatus: vi.fn().mockResolvedValue({
        igdbId: 11133,
        UserGamesStatus: { id: 4, status: 'BACKLOG' }
      })
    })
    const ratingRepository = fakeRatingRepository({ findUniqueByUserGame })
    const service = new UserService(
      userRepository,
      ratingRepository,
      fakeGameCacheService(),
      fakeFollowRepository()
    )

    await service.updateGame(11133, 'user-1', 4)

    expect(findUniqueByUserGame).not.toHaveBeenCalled()
  })
})

describe('UserService.findById', () => {
  it('returns the full profile, without linked accounts, including follow counts', async () => {
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({
        id: 'user-1',
        userName: 'matheus',
        profilePicture: 'pic.png',
        userBanner: 'banner.png',
        steamId: '12345',
        psnOnlineId: 'psn-user',
        _count: { userGames: 3 }
      }),
      countUserGames: vi.fn().mockResolvedValue({ _count: { userGames: 3 } }),
      sumUserHoursPlayed: vi.fn().mockResolvedValue(12.5)
    })
    const followRepository = fakeFollowRepository({
      countFollowers: vi.fn().mockResolvedValue(2),
      countFollowing: vi.fn().mockResolvedValue(5)
    })
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      followRepository
    )

    const { user } = await service.findById('user-1')

    expect(user).toEqual({
      id: 'user-1',
      profilePicture: 'pic.png',
      userBanner: 'banner.png',
      userName: 'matheus',
      gamesAmount: 3,
      totalHoursPlayed: 12.5,
      followersCount: 2,
      followingCount: 5
    })
    expect(user).not.toHaveProperty('steamId')
    expect(user).not.toHaveProperty('psnOnlineId')
  })
})

describe('UserService.findMe', () => {
  function build(
    accounts: unknown[] = [],
    cache: CacheRepository = {
      get: vi.fn().mockResolvedValue(null)
    } as unknown as CacheRepository
  ) {
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({
        id: 'user-1',
        userName: 'matheus',
        email: 'matheus@a.com',
        emailVerifiedAt: null,
        profilePicture: 'pic.png',
        userBanner: 'banner.png',
        accounts,
        _count: { userGames: 3 }
      }),
      sumUserHoursPlayed: vi.fn().mockResolvedValue(12.5)
    })
    const followRepository = fakeFollowRepository({
      countFollowers: vi.fn().mockResolvedValue(2),
      countFollowing: vi.fn().mockResolvedValue(5)
    })
    return new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      followRepository,
      undefined,
      cache
    )
  }

  it('returns the full self profile, with each linked account listed under its own platform', async () => {
    const service = build([
      {
        id: 'x-1',
        platform: 'XBOX',
        externalId: 'xuid-1',
        displayName: 'Gamer',
        preferredConsole: 'XBOX_SERIES'
      },
      {
        id: 's-1',
        platform: 'STEAM',
        externalId: '76561197960287930',
        displayName: 'MathQuente'
      },
      {
        id: 's-2',
        platform: 'STEAM',
        externalId: '76561197960287931',
        displayName: 'Alt'
      },
      {
        id: 'p-1',
        platform: 'PLAYSTATION',
        externalId: 'psn-1',
        displayName: 'Player_1'
      }
    ])

    const { user } = await service.findMe('user-1')

    expect(user).toEqual({
      id: 'user-1',
      profilePicture: 'pic.png',
      userBanner: 'banner.png',
      userName: 'matheus',
      email: 'matheus@a.com',
      emailVerified: false,
      googleLinked: false,
      discordLinked: false,
      pendingEmail: null,
      gamesAmount: 3,
      totalHoursPlayed: 12.5,
      steamAccounts: [
        { id: 's-1', steamId: '76561197960287930', personaName: 'MathQuente' },
        { id: 's-2', steamId: '76561197960287931', personaName: 'Alt' }
      ],
      psnAccounts: [{ id: 'p-1', onlineId: 'Player_1' }],
      xboxAccounts: [
        { id: 'x-1', gamertag: 'Gamer', preferredConsole: 'XBOX_SERIES' }
      ],
      followersCount: 2,
      followingCount: 5
    })
  })

  it('returns empty lists when no account is linked', async () => {
    const { user } = await build().findMe('user-1')

    expect(user.steamAccounts).toEqual([])
    expect(user.psnAccounts).toEqual([])
    expect(user.xboxAccounts).toEqual([])
  })

  it('tells which sign-in providers are linked without exposing their ids', async () => {
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({
        id: 'user-1',
        userName: 'matheus',
        email: 'matheus@a.com',
        emailVerifiedAt: null,
        googleId: 'g-123',
        discordId: null,
        accounts: [],
        _count: { userGames: 0 }
      }),
      sumUserHoursPlayed: vi.fn().mockResolvedValue(0)
    })
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository({
        countFollowers: vi.fn().mockResolvedValue(0),
        countFollowing: vi.fn().mockResolvedValue(0)
      }),
      undefined,
      { get: vi.fn().mockResolvedValue(null) } as unknown as CacheRepository
    )

    const { user } = await service.findMe('user-1')

    expect(user.googleLinked).toBe(true)
    expect(user.discordLinked).toBe(false)
    expect(JSON.stringify(user)).not.toContain('g-123')
  })

  it('shows the e-mail waiting for confirmation', async () => {
    const cache = {
      get: vi.fn().mockResolvedValue({ tokenHash: 'h', newEmail: 'novo@a.com' })
    } as unknown as CacheRepository

    const { user } = await build([], cache).findMe('user-1')

    expect(user.pendingEmail).toBe('novo@a.com')
    expect(cache.get).toHaveBeenCalledWith('email-change-current:user-1')
  })

  it('still answers when the cache fails, with nothing pending', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const cache = {
      get: vi.fn().mockRejectedValue(new Error('redis down'))
    } as unknown as CacheRepository

    const { user } = await build([], cache).findMe('user-1')

    expect(user.pendingEmail).toBeNull()
    vi.restoreAllMocks()
  })
})

describe('UserService.delete', () => {
  function build(cacheSet: ReturnType<typeof vi.fn>) {
    const deleteUser = vi
      .fn()
      .mockResolvedValue({ id: 'user-1', userName: 'someone' })
    const service = new UserService(
      fakeUserRepository({
        findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
        deleteUser
      }),
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository(),
      undefined,
      { set: cacheSet } as unknown as CacheRepository
    )
    return { service, deleteUser }
  }

  it('deletes the account and then revokes the sessions that were already issued', async () => {
    const set = vi.fn().mockResolvedValue(undefined)
    const { service, deleteUser } = build(set)

    const result = await service.delete('user-1')

    expect(deleteUser).toHaveBeenCalledWith('user-1')
    expect(set).toHaveBeenCalledWith(
      'sessions-revoked-at:user-1',
      expect.any(Number),
      expect.any(Number)
    )
    expect(deleteUser.mock.invocationCallOrder[0]).toBeLessThan(
      set.mock.invocationCallOrder[0]
    )
    expect(result).toEqual({ user: { id: 'user-1', userName: 'someone' } })
  })

  it('does not revoke the sessions when the account cannot be deleted', async () => {
    const set = vi.fn().mockResolvedValue(undefined)
    const { service, deleteUser } = build(set)
    deleteUser.mockRejectedValue(new Error('db down'))

    await expect(service.delete('user-1')).rejects.toThrow('db down')
    expect(set).not.toHaveBeenCalled()
  })

  it('still reports the deletion when the revocation cannot be stored', async () => {
    const { service } = build(
      vi.fn().mockRejectedValue(new Error('redis down'))
    )
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(service.delete('user-1')).resolves.toEqual({
      user: { id: 'user-1', userName: 'someone' }
    })
  })
})

describe('UserService.delete image cleanup', () => {
  const PHOTO =
    'https://res.cloudinary.com/mycloud/image/upload/v1/images/photo.png'
  const BANNER =
    'https://res.cloudinary.com/mycloud/image/upload/v1/images/banner.png'

  function build(
    user: { profilePicture: string | null; userBanner: string | null },
    inUse = false
  ) {
    const deleteUser = vi
      .fn()
      .mockResolvedValue({ id: 'user-1', userName: 'someone' })
    const findImageUrlsInUse = vi
      .fn()
      .mockImplementation(async (urls: string[]) => (inUse ? urls : []))
    const service = new UserService(
      fakeUserRepository({
        findUserById: vi.fn().mockResolvedValue({ id: 'user-1', ...user }),
        deleteUser,
        findImageUrlsInUse
      }),
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository(),
      undefined,
      {
        set: vi.fn().mockResolvedValue(undefined)
      } as unknown as CacheRepository
    )
    return { service, deleteUser, findImageUrlsInUse }
  }

  beforeEach(() => {
    vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'mycloud')
    vi.stubEnv('CLOUDINARY_API_KEY', 'key')
    vi.stubEnv('CLOUDINARY_API_SECRET', 'secret')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('destroys the photo and the banner after the account row is gone', async () => {
    const destroy = vi.spyOn(CloudinaryService, 'destroy').mockResolvedValue()
    const { service, deleteUser } = build({
      profilePicture: PHOTO,
      userBanner: BANNER
    })

    await service.delete('user-1')

    expect(destroy).toHaveBeenCalledTimes(2)
    expect(destroy).toHaveBeenCalledWith('images/photo')
    expect(destroy).toHaveBeenCalledWith('images/banner')
    expect(deleteUser.mock.invocationCallOrder[0]).toBeLessThan(
      destroy.mock.invocationCallOrder[0]
    )
  })

  it('destroys a shared photo and banner url only once', async () => {
    const destroy = vi.spyOn(CloudinaryService, 'destroy').mockResolvedValue()
    const { service } = build({ profilePicture: PHOTO, userBanner: PHOTO })

    await service.delete('user-1')

    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('skips urls that are not from our Cloudinary cloud', async () => {
    const destroy = vi.spyOn(CloudinaryService, 'destroy').mockResolvedValue()
    const { service } = build({
      profilePicture: 'https://lh3.googleusercontent.com/a/abc',
      userBanner: 'https://res.cloudinary.com/other/image/upload/b.png'
    })

    await service.delete('user-1')

    expect(destroy).not.toHaveBeenCalled()
  })

  it('skips an image that another user still uses', async () => {
    const destroy = vi.spyOn(CloudinaryService, 'destroy').mockResolvedValue()
    const { service } = build({ profilePicture: PHOTO, userBanner: null }, true)

    await service.delete('user-1')

    expect(destroy).not.toHaveBeenCalled()
  })

  it('does nothing when the account cannot be deleted', async () => {
    const destroy = vi.spyOn(CloudinaryService, 'destroy').mockResolvedValue()
    const { service, deleteUser } = build({
      profilePicture: PHOTO,
      userBanner: null
    })
    deleteUser.mockRejectedValue(new Error('db down'))

    await expect(service.delete('user-1')).rejects.toThrow('db down')
    expect(destroy).not.toHaveBeenCalled()
  })

  it('still reports the deletion when Cloudinary fails and keeps going', async () => {
    const destroy = vi
      .spyOn(CloudinaryService, 'destroy')
      .mockRejectedValueOnce(new Error('cloudinary down'))
      .mockResolvedValue()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { service } = build({ profilePicture: PHOTO, userBanner: BANNER })

    await expect(service.delete('user-1')).resolves.toEqual({
      user: { id: 'user-1', userName: 'someone' }
    })
    expect(destroy).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(error.mock.calls)).not.toContain('res.cloudinary.com')
  })

  it('still reports the deletion when the in-use lookup fails', async () => {
    const destroy = vi.spyOn(CloudinaryService, 'destroy').mockResolvedValue()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { service, findImageUrlsInUse } = build({
      profilePicture: PHOTO,
      userBanner: null
    })
    findImageUrlsInUse.mockRejectedValue(new Error('db down'))

    await expect(service.delete('user-1')).resolves.toEqual({
      user: { id: 'user-1', userName: 'someone' }
    })
    expect(destroy).not.toHaveBeenCalled()
  })

  it('makes no Cloudinary call without credentials', async () => {
    vi.stubEnv('CLOUDINARY_API_SECRET', '')
    const destroy = vi.spyOn(CloudinaryService, 'destroy').mockResolvedValue()
    const { service, findImageUrlsInUse } = build({
      profilePicture: PHOTO,
      userBanner: null
    })

    await service.delete('user-1')

    expect(destroy).not.toHaveBeenCalled()
    expect(findImageUrlsInUse).not.toHaveBeenCalled()
  })
})

describe('UserService.update image cleanup', () => {
  const OLD_PHOTO =
    'https://res.cloudinary.com/mycloud/image/upload/v1/images/old.png'
  const NEW_PHOTO =
    'https://res.cloudinary.com/mycloud/image/upload/v2/images/new.png'
  const OLD_BANNER =
    'https://res.cloudinary.com/mycloud/image/upload/v1/images/banner.png'

  function build(
    current: { profilePicture: string | null; userBanner: string | null },
    inUse: boolean | ((url: string) => boolean) = false
  ) {
    const updateUser = vi.fn().mockResolvedValue({ id: 'user-1' })
    const findImageUrlsInUse = vi
      .fn()
      .mockImplementation(async (urls: string[]) =>
        typeof inUse === 'function'
          ? urls.filter(url => inUse(url))
          : inUse
            ? urls
            : []
      )
    const service = new UserService(
      fakeUserRepository({
        findUserById: vi.fn().mockResolvedValue({ id: 'user-1', ...current }),
        updateUser,
        findImageUrlsInUse
      }),
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )
    return { service, updateUser, findImageUrlsInUse }
  }

  beforeEach(() => {
    vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'mycloud')
    vi.stubEnv('CLOUDINARY_API_KEY', 'key')
    vi.stubEnv('CLOUDINARY_API_SECRET', 'secret')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('destroys the previous photo after the new one is saved', async () => {
    const destroy = vi.spyOn(CloudinaryService, 'destroy').mockResolvedValue()
    const { service, updateUser } = build({
      profilePicture: OLD_PHOTO,
      userBanner: null
    })

    await service.update('user-1', { profilePicture: NEW_PHOTO })

    expect(destroy).toHaveBeenCalledTimes(1)
    expect(destroy).toHaveBeenCalledWith('images/old')
    expect(updateUser.mock.invocationCallOrder[0]).toBeLessThan(
      destroy.mock.invocationCallOrder[0]
    )
  })

  it('destroys the previous banner when it is removed', async () => {
    const destroy = vi.spyOn(CloudinaryService, 'destroy').mockResolvedValue()
    const { service } = build({ profilePicture: null, userBanner: OLD_BANNER })

    await service.update('user-1', { userBanner: null })

    expect(destroy).toHaveBeenCalledWith('images/banner')
  })

  it('keeps the images when the same url is sent again', async () => {
    const destroy = vi.spyOn(CloudinaryService, 'destroy').mockResolvedValue()
    const { service } = build({ profilePicture: OLD_PHOTO, userBanner: null })

    await service.update('user-1', { profilePicture: OLD_PHOTO })

    expect(destroy).not.toHaveBeenCalled()
  })

  it('keeps the images when the fields are not part of the update', async () => {
    const destroy = vi.spyOn(CloudinaryService, 'destroy').mockResolvedValue()
    const { service } = build({
      profilePicture: OLD_PHOTO,
      userBanner: OLD_BANNER
    })

    await service.update('user-1', { userName: 'new name' })

    expect(destroy).not.toHaveBeenCalled()
  })

  it('keeps an image that another user still uses', async () => {
    const destroy = vi.spyOn(CloudinaryService, 'destroy').mockResolvedValue()
    const { service } = build(
      { profilePicture: OLD_PHOTO, userBanner: null },
      true
    )

    await service.update('user-1', { profilePicture: NEW_PHOTO })

    expect(destroy).not.toHaveBeenCalled()
  })

  it('keeps an image this same user still uses in the other field', async () => {
    const destroy = vi.spyOn(CloudinaryService, 'destroy').mockResolvedValue()
    const { service } = build(
      { profilePicture: OLD_PHOTO, userBanner: OLD_PHOTO },
      url => url === OLD_PHOTO
    )

    await service.update('user-1', { profilePicture: NEW_PHOTO })

    expect(destroy).not.toHaveBeenCalled()
  })

  it('skips provider avatars and other clouds', async () => {
    const destroy = vi.spyOn(CloudinaryService, 'destroy').mockResolvedValue()
    const { service } = build({
      profilePicture: 'https://lh3.googleusercontent.com/a/abc',
      userBanner: 'https://res.cloudinary.com/other/image/upload/v1/b.png'
    })

    await service.update('user-1', {
      profilePicture: NEW_PHOTO,
      userBanner: null
    })

    expect(destroy).not.toHaveBeenCalled()
  })

  it('still returns the user when Cloudinary fails', async () => {
    vi.spyOn(CloudinaryService, 'destroy').mockRejectedValue(
      new Error('cloudinary down')
    )
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { service } = build({ profilePicture: OLD_PHOTO, userBanner: null })

    await expect(
      service.update('user-1', { profilePicture: NEW_PHOTO })
    ).resolves.toEqual({ user: { id: 'user-1' } })
  })

  it('destroys nothing when the update cannot be saved', async () => {
    const destroy = vi.spyOn(CloudinaryService, 'destroy').mockResolvedValue()
    const { service, updateUser } = build({
      profilePicture: OLD_PHOTO,
      userBanner: null
    })
    updateUser.mockRejectedValue(new Error('db down'))

    await expect(
      service.update('user-1', { profilePicture: NEW_PHOTO })
    ).rejects.toThrow('db down')
    expect(destroy).not.toHaveBeenCalled()
  })

  it('makes no Cloudinary call without credentials', async () => {
    vi.stubEnv('CLOUDINARY_API_KEY', '')
    const destroy = vi.spyOn(CloudinaryService, 'destroy').mockResolvedValue()
    const { service, findImageUrlsInUse } = build({
      profilePicture: OLD_PHOTO,
      userBanner: null
    })

    await service.update('user-1', { profilePicture: NEW_PHOTO })

    expect(destroy).not.toHaveBeenCalled()
    expect(findImageUrlsInUse).not.toHaveBeenCalled()
  })
})

describe('UserService.updateUserGamePlayedCount', () => {
  function serviceFor(statusId: number, completions: number, endless = false) {
    const updateUserGamePlayedCount = vi
      .fn()
      .mockImplementation(async (_u, _g, inc) => ({
        completions: completions + inc
      }))
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      findUserGame: vi.fn().mockResolvedValue({
        endless,
        UserGamesStatus: { id: statusId },
        _count: { platforms: 0 }
      }),
      findUserGameStats: vi.fn().mockResolvedValue({ stats: { completions } }),
      updateUserGamePlayedCount
    })
    const service = new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(),
      fakeFollowRepository()
    )
    return { service, updateUserGamePlayedCount }
  }

  it('lets a game that is not played go down to zero completions', async () => {
    const { service } = serviceFor(3, 1)

    await expect(
      service.updateUserGamePlayedCount('user-1', 1, -1)
    ).resolves.toEqual({
      playedCount: 0
    })
  })

  it('does not go below zero', async () => {
    const { service, updateUserGamePlayedCount } = serviceFor(3, 0)

    await expect(
      service.updateUserGamePlayedCount('user-1', 1, -1)
    ).rejects.toThrow(ClientError)
    expect(updateUserGamePlayedCount).not.toHaveBeenCalled()
  })

  it('keeps at least one completion on a played game', async () => {
    const { service } = serviceFor(1, 1)

    await expect(
      service.updateUserGamePlayedCount('user-1', 1, -1)
    ).rejects.toThrow(ClientError)
  })

  it('rejects adding a completion to an endless game', async () => {
    const { service, updateUserGamePlayedCount } = serviceFor(3, 0, true)

    await expect(
      service.updateUserGamePlayedCount('user-1', 1, 1)
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'Jogo infinito não conta vezes zerado.'
    })
    expect(updateUserGamePlayedCount).not.toHaveBeenCalled()
  })

  it('still lets an endless game go down by one', async () => {
    const { service } = serviceFor(3, 1, true)

    await expect(
      service.updateUserGamePlayedCount('user-1', 1, -1)
    ).resolves.toEqual({ playedCount: 0 })
  })

  it('adds a completion to a game being replayed', async () => {
    const { service } = serviceFor(3, 2)

    await expect(
      service.updateUserGamePlayedCount('user-1', 1, 1)
    ).resolves.toEqual({
      playedCount: 3
    })
  })

  describe('UserService.setHundredPercent', () => {
    function build(
      statusId: number | null,
      update = vi.fn().mockResolvedValue({ igdbId: 7, hundredPercent: true })
    ) {
      const userRepository = fakeUserRepository({
        findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
        findUserGameStatus: vi
          .fn()
          .mockResolvedValue(
            statusId === null
              ? null
              : { UserGamesStatus: { id: statusId, status: 'X' } }
          ),
        setHundredPercent: update
      })
      const service = new UserService(
        userRepository,
        fakeRatingRepository(),
        fakeGameCacheService(),
        fakeFollowRepository()
      )
      return { service, update }
    }

    it('marks a played game and locks the mark', async () => {
      const { service, update } = build(1)

      await expect(
        service.setHundredPercent(7, 'user-1', true)
      ).resolves.toEqual({
        igdbId: 7,
        hundredPercent: true
      })
      expect(update).toHaveBeenCalledWith(7, 'user-1', true)
    })

    it('refuses the mark on a game that is not played', async () => {
      const { service, update } = build(3)

      await expect(
        service.setHundredPercent(7, 'user-1', true)
      ).rejects.toMatchObject({ statusCode: 409 })
      expect(update).not.toHaveBeenCalled()
    })

    it('lets the mark be removed from a game in any status', async () => {
      const { service, update } = build(
        3,
        vi.fn().mockResolvedValue({ igdbId: 7, hundredPercent: false })
      )

      await expect(
        service.setHundredPercent(7, 'user-1', false)
      ).resolves.toEqual({
        igdbId: 7,
        hundredPercent: false
      })
      expect(update).toHaveBeenCalledWith(7, 'user-1', false)
    })

    it('answers 409 when the game stopped being played before the write', async () => {
      const { service } = build(1, vi.fn().mockResolvedValue(null))

      await expect(
        service.setHundredPercent(7, 'user-1', true)
      ).rejects.toMatchObject({ statusCode: 409 })
    })

    it('answers 404 for a game that is not in the library', async () => {
      const { service } = build(null)

      await expect(
        service.setHundredPercent(7, 'user-1', true)
      ).rejects.toMatchObject({ statusCode: 404 })
    })
  })
})

describe('UserService favorites', () => {
  function build(
    overrides: Partial<UserRepository> = {},
    cache: Partial<GameCacheService> = {}
  ) {
    const userRepository = fakeUserRepository({
      findUserById: vi.fn().mockResolvedValue({ id: 'user-1' }),
      ...overrides
    })
    return new UserService(
      userRepository,
      fakeRatingRepository(),
      fakeGameCacheService(cache),
      fakeFollowRepository()
    )
  }

  const row = (
    igdbId: number,
    status: string | null = 'PLAYED',
    isMain = false
  ) => ({
    igdbId,
    isMain,
    status,
    name: `Jogo ${igdbId}`,
    slug: `jogo-${igdbId}`,
    coverUrl: null,
    platforms: [],
    releaseDate: null,
    rating: null,
    completions: 0,
    hoursPlayed: 0,
    playedOn: [],
    endless: false,
    hundredPercent: false
  })

  it('returns the favorites in the order of the rows, with no status for games outside the library', async () => {
    const service = build({
      findFavoriteGameRows: vi
        .fn()
        .mockResolvedValue([row(30, null), row(10), row(20, 'WISHLIST')])
    })

    const { games } = await service.getFavorites('user-1')

    expect(games.map(g => [g.igdbId, g.status])).toEqual([
      [30, null],
      [10, 'PLAYED'],
      [20, 'WISHLIST']
    ])
  })

  it('marks only the crowned game, going through the real card mapper', async () => {
    const service = build({
      findFavoriteGameRows: vi
        .fn()
        .mockResolvedValue([row(30, null), row(10, 'PLAYED', true), row(20)])
    })

    const { games } = await service.getFavorites('user-1')

    expect(games.map(g => [g.igdbId, g.isMain])).toEqual([
      [30, false],
      [10, true],
      [20, false]
    ])
  })

  it('has no crowned game when none is marked', async () => {
    const service = build({
      findFavoriteGameRows: vi.fn().mockResolvedValue([row(1), row(2)])
    })

    const { games } = await service.getFavorites('user-1')

    expect(games.every(g => g.isMain === false)).toBe(true)
  })

  it('saves the crowned game along with the list', async () => {
    const replaceFavorites = vi.fn().mockResolvedValue(undefined)
    const service = build({
      replaceFavorites,
      findFavoriteGameRows: vi
        .fn()
        .mockResolvedValue([row(2), row(1, 'PLAYED', true)])
    })

    const { games } = await service.setFavorites('user-1', [2, 1], 1)

    expect(replaceFavorites).toHaveBeenCalledWith('user-1', [2, 1], 1)
    expect(games.map(g => g.isMain)).toEqual([false, true])
  })

  it('refuses a crown on a game that is not in the list', async () => {
    const replaceFavorites = vi.fn()
    const service = build({ replaceFavorites })

    await expect(
      service.setFavorites('user-1', [1, 2], 3)
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(replaceFavorites).not.toHaveBeenCalled()
  })

  it('saves without a crown when none is given', async () => {
    const replaceFavorites = vi.fn().mockResolvedValue(undefined)
    const service = build({
      replaceFavorites,
      findFavoriteGameRows: vi.fn().mockResolvedValue([row(1)])
    })

    await service.setFavorites('user-1', [1])

    expect(replaceFavorites).toHaveBeenCalledWith('user-1', [1], null)
  })

  it('answers an empty list when there are no favorites', async () => {
    const service = build({
      findFavoriteGameRows: vi.fn().mockResolvedValue([])
    })

    await expect(service.getFavorites('user-1')).resolves.toEqual({
      games: []
    })
  })

  it('saves any game of the catalog, even outside the library', async () => {
    const replaceFavorites = vi.fn().mockResolvedValue(undefined)
    const ensureCached = vi.fn().mockResolvedValue(true)
    const service = build(
      {
        replaceFavorites,
        findFavoriteGameRows: vi.fn().mockResolvedValue([row(2, null), row(1)])
      },
      { ensureCached }
    )

    const { games } = await service.setFavorites('user-1', [2, 1])

    expect(ensureCached).toHaveBeenCalledWith(2)
    expect(ensureCached).toHaveBeenCalledWith(1)
    expect(replaceFavorites).toHaveBeenCalledWith('user-1', [2, 1], null)
    expect(games.map(g => g.igdbId)).toEqual([2, 1])
  })

  it('refuses a game that does not exist in the catalog', async () => {
    const replaceFavorites = vi.fn()
    const service = build(
      { replaceFavorites },
      {
        ensureCached: vi
          .fn()
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false)
      }
    )

    await expect(
      service.setFavorites('user-1', [1, 999])
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(replaceFavorites).not.toHaveBeenCalled()
  })

  it('refuses more than four or repeated games', async () => {
    const replaceFavorites = vi.fn()
    const service = build({ replaceFavorites })

    await expect(
      service.setFavorites('user-1', [1, 2, 3, 4, 5])
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(service.setFavorites('user-1', [1, 1])).rejects.toMatchObject({
      statusCode: 400
    })
    expect(replaceFavorites).not.toHaveBeenCalled()
  })

  it('answers 409 when two saves collide on the position', async () => {
    const service = build({
      replaceFavorites: vi.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test'
        })
      )
    })

    await expect(service.setFavorites('user-1', [1])).rejects.toMatchObject({
      statusCode: 409
    })
  })

  it('accepts clearing every favorite', async () => {
    const replaceFavorites = vi.fn().mockResolvedValue(undefined)
    const service = build({
      replaceFavorites,
      findFavoriteGameRows: vi.fn().mockResolvedValue([])
    })

    await expect(service.setFavorites('user-1', [])).resolves.toEqual({
      games: []
    })
    expect(replaceFavorites).toHaveBeenCalledWith('user-1', [], null)
  })
})
