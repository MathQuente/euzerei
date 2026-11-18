import { describe, it, expect, vi, afterEach } from 'vitest'
import { GameService } from './games.service'
import { IGDBService } from './igdb.service'
import { RatingRepository } from '../repositories/rating.repository'
import { GameCacheRepository } from '../repositories/game-cache.repository'
import { UserRepository } from '../repositories/users.repository'
import { CacheRepository } from '../repositories/cache.repository'
import { IGDBGame } from '../types/igdb'

afterEach(() => {
  vi.restoreAllMocks()
})

function setup() {
  const cacheRepository = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined)
  }
  const service = new GameService(
    {
      getAverageRatingsForGames: vi.fn().mockResolvedValue(new Map())
    } as unknown as RatingRepository,
    {
      findSlugsByIds: vi.fn().mockResolvedValue(new Map([[1, 'one']])),
      findIdBySlug: vi.fn().mockResolvedValue(null)
    } as unknown as GameCacheRepository,
    {} as UserRepository,
    cacheRepository as unknown as CacheRepository
  )
  return { service, cacheRepository }
}

describe('GameService.findSimilarGames', () => {
  it('hides rumored games and cancelled games with no date, and caches only what it shows', async () => {
    const { service, cacheRepository } = setup()
    vi.spyOn(IGDBService, 'getSimilarGames').mockResolvedValue([
      {
        id: 1,
        name: 'Released',
        game_status: 0,
        first_release_date: 1_500_000_000
      },
      { id: 2, name: 'No status' },
      { id: 3, name: 'Rumored', game_status: 7 },
      { id: 4, name: 'Cancelled without date', game_status: 6 },
      {
        id: 5,
        name: 'Cancelled with date',
        game_status: 6,
        first_release_date: 1_400_000_000
      }
    ] as IGDBGame[])

    const result = await service.findSimilarGames(10)

    expect(result.map(g => g.igdbId)).toEqual([1, 2, 5])
    const cached = cacheRepository.set.mock.calls[0][1] as { games: IGDBGame[] }
    expect(cached.games.map(g => g.id)).toEqual([1, 2, 5])
  })

  it('fills the list up to twelve after dropping hidden games', async () => {
    const { service } = setup()
    vi.spyOn(IGDBService, 'getSimilarGames').mockResolvedValue([
      ...[1, 2, 3].map(id => ({ id, name: `Rumored ${id}`, game_status: 7 })),
      ...Array.from({ length: 14 }, (_, i) => i + 4).map(id => ({
        id,
        name: `Game ${id}`
      }))
    ] as IGDBGame[])

    const result = await service.findSimilarGames(10)

    expect(result.map(g => g.igdbId)).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
    ])
  })
})

describe('GameService.findFeaturedGames', () => {
  it('drops hidden games from trending and most rated', async () => {
    const cacheRepository = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined)
    }
    const service = new GameService(
      {
        getAverageRatingsForGames: vi.fn().mockResolvedValue(new Map()),
        findTopRatedIgdbIds: vi
          .fn()
          .mockResolvedValue([{ igdbId: 3, avgRating: 9 }])
      } as unknown as RatingRepository,
      {
        findSlugsByIds: vi.fn().mockResolvedValue(new Map([[1, 'one']])),
        findIdBySlug: vi.fn().mockResolvedValue(null)
      } as unknown as GameCacheRepository,
      {
        findTrendingIgdbIds: vi.fn().mockResolvedValue([
          { igdbId: 1, playingCount: 2 },
          { igdbId: 2, playingCount: 1 }
        ])
      } as unknown as UserRepository,
      cacheRepository as unknown as CacheRepository
    )
    vi.spyOn(IGDBService, 'getGamesByIds').mockImplementation(
      async ids =>
        ids.map(id => ({
          id,
          name: `Game ${id}`,
          first_release_date: 1_400_000_000,
          game_status: id === 2 ? 7 : id === 3 ? 6 : 0
        })) as IGDBGame[]
    )
    vi.spyOn(IGDBService, 'getRecentlyReleasedGames').mockResolvedValue([])
    vi.spyOn(service, 'findComingSoonGames').mockResolvedValue({
      games: [],
      total: 0
    } as never)

    const result = await service.findFeaturedGames()

    expect(result.trendingGames.map(g => g.igdbId)).toEqual([1])
    expect(result.mostRatedGames.map(g => g.igdbId)).toEqual([3])
  })
})

describe('GameService.findGameBySlug', () => {
  function slugSetup() {
    const { service } = setup()
    const spy = vi
      .spyOn(service, 'findGameById')
      .mockResolvedValue({ game: { igdbId: 1 }, relatedGames: [] } as never)
    return { service, spy }
  }

  it('resolves a slug through the cache and loads that game', async () => {
    const cacheRepository = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn()
    }
    const findIdBySlug = vi.fn().mockResolvedValue(62151)
    const service = new GameService(
      {} as unknown as RatingRepository,
      { findIdBySlug } as unknown as GameCacheRepository,
      {} as UserRepository,
      cacheRepository as unknown as CacheRepository
    )
    const spy = vi
      .spyOn(service, 'findGameById')
      .mockResolvedValue({ game: {}, relatedGames: [] } as never)

    await service.findGameBySlug('the-witcher-3-wild-hunt')

    expect(findIdBySlug).toHaveBeenCalledWith('the-witcher-3-wild-hunt')
    expect(spy).toHaveBeenCalledWith(62151)
  })

  it('treats an all-digit slug as an id without hitting the cache', async () => {
    const { service, spy } = slugSetup()
    await service.findGameBySlug('62151')
    expect(spy).toHaveBeenCalledWith(62151)
  })

  it('answers 404 for an unknown slug', async () => {
    const { service } = setup()
    await expect(service.findGameBySlug('nope')).rejects.toMatchObject({
      statusCode: 404
    })
  })

  it('lowercases the slug before the lookup', async () => {
    const findIdBySlug = vi.fn().mockResolvedValue(7)
    const service = new GameService(
      {} as unknown as RatingRepository,
      { findIdBySlug } as unknown as GameCacheRepository,
      {} as UserRepository,
      {} as unknown as CacheRepository
    )
    vi.spyOn(service, 'findGameById').mockResolvedValue({} as never)

    await service.findGameBySlug('The-Witcher-3')

    expect(findIdBySlug).toHaveBeenCalledWith('the-witcher-3')
  })
})

describe('GameService.findGameById slug', () => {
  function detailSetup(slugs: Map<number, string>) {
    const upsertMany = vi.fn().mockResolvedValue(undefined)
    const service = new GameService(
      {
        getAverageRatingsForGames: vi.fn().mockResolvedValue(new Map())
      } as unknown as RatingRepository,
      {
        findSlugsByIds: vi.fn().mockResolvedValue(slugs),
        upsertMany
      } as unknown as GameCacheRepository,
      {} as UserRepository,
      {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined)
      } as unknown as CacheRepository
    )
    vi.spyOn(IGDBService, 'getGameById').mockResolvedValue({
      id: 5,
      name: 'Doom'
    } as never)
    vi.spyOn(IGDBService, 'getRelatedGames').mockResolvedValue([])
    return { service, upsertMany }
  }

  it('returns the cached slug', async () => {
    const { service } = detailSetup(new Map([[5, 'doom']]))
    const { game } = await service.findGameById(5)
    expect(game.slug).toBe('doom')
  })

  it('returns a null slug and never writes to games_cache for an uncached game', async () => {
    const { service, upsertMany } = detailSetup(new Map())
    const { game } = await service.findGameById(5)
    expect(game.slug).toBeNull()
    expect(upsertMany).not.toHaveBeenCalled()
  })
})
