import { ClientError } from '../errors/client-error'
import { IGDBGame } from '../types/igdb'
import { GameCacheRepository } from '../repositories/game-cache.repository'
import { RatingRepository } from '../repositories/rating.repository'
import { UserRepository } from '../repositories/users.repository'
import { IGDBService } from './igdb.service'
import { CacheRepository } from '../repositories/cache.repository'
import { isHiddenFromCatalog } from '../utils/game-status'
import {
  type ReleasePrecision,
  precisionFromFormat,
  releaseDatePrecision
} from '../utils/release-precision'

const TRENDING_WINDOW_DAYS = 30
const GAME_CACHE_TTL_SECONDS = 60 * 60
const RECENT_FEATURED_LIMIT = 9

// The released/coming-soon split changes at midnight in Brazil. The day of the
// cutoff goes into the cache key so a list cached before the turn of the day
// is not served after it; the same cutoff is passed to the query, so key and
// result never disagree.
function releaseCutoffDay(cutoff: number) {
  return new Date(cutoff * 1000).toISOString().slice(0, 10)
}

export class GameService {
  constructor(
    private ratingRepository: RatingRepository,
    private gameCacheRepository: GameCacheRepository,
    private userRepository: UserRepository,
    private cacheRepository: CacheRepository
  ) {}

  private formatGame(
    game: IGDBGame,
    rating: number | null = null,
    slugs: Map<number, string>
  ) {
    const developers = game.involved_companies
      ?.filter(c => c.developer)
      .map(c => c.company.name)
    const publishers = game.involved_companies
      ?.filter(c => c.publisher)
      .map(c => c.company.name)

    const parentGameId = IGDBService.getParentGameId(game)

    const parentGame =
      typeof game.parent_game === 'object' && game.parent_game
        ? {
            igdbId: game.parent_game.id,
            slug: slugs.get(game.parent_game.id) ?? null,
            name: game.parent_game.name,
            coverUrl: IGDBService.formatCoverUrl(game.parent_game.cover?.url)
          }
        : undefined

    const releaseDates = game.release_dates
      ?.filter(rd => rd.platform?.name)
      .reduce<
        Array<{
          platformName: string
          date: number | null
          precision?: ReleasePrecision
        }>
      >((acc, rd) => {
        const platformName = rd.platform?.name as string
        const date = rd.date ?? null
        const precision = precisionFromFormat(rd.date_format)
        const existing = acc.find(r => r.platformName === platformName)

        if (!existing) {
          acc.push({ platformName, date, precision })
        } else if (
          date !== null &&
          (existing.date === null || date < existing.date)
        ) {
          existing.date = date
          existing.precision = precision
        }

        return acc
      }, [])

    return {
      igdbId: game.id,
      slug: slugs.get(game.id) ?? null,
      name: game.name,
      coverUrl: IGDBService.formatCoverUrl(game.cover?.url),
      summary: game.summary,
      genres: game.genres?.map(g => g.name),
      platforms: game.platforms?.map(p => p.name),
      releaseDate: game.first_release_date,
      releaseDatePrecision: releaseDatePrecision(
        game.first_release_date,
        game.release_dates
      ),
      rating,
      developers: developers && developers.length > 0 ? developers : undefined,
      publishers: publishers && publishers.length > 0 ? publishers : undefined,
      category: IGDBService.getGameType(game),
      parentGameId,
      parentGame,
      releaseDates:
        releaseDates && releaseDates.length > 0 ? releaseDates : undefined,
      screenshots: game.screenshots?.map(s => ({
        thumbUrl: IGDBService.formatScreenshotUrl(s.image_id, 'screenshot_big'),
        fullUrl: IGDBService.formatScreenshotUrl(s.image_id, '1080p')
      })),
      videos: game.videos
        ?.filter(v => v.video_id)
        .map(v => ({ videoId: v.video_id, name: v.name ?? 'Trailer' }))
    }
  }

  private idsWithParents(games: IGDBGame[]): number[] {
    const ids = new Set<number>()
    for (const g of games) {
      ids.add(g.id)
      if (typeof g.parent_game === 'object' && g.parent_game) {
        ids.add(g.parent_game.id)
      }
    }
    return [...ids]
  }

  private async enrichWithRatings(games: IGDBGame[]) {
    const igdbIds = games.map(g => g.id)
    const [ratingsMap, slugs] = await Promise.all([
      this.ratingRepository.getAverageRatingsForGames(igdbIds),
      this.gameCacheRepository.findSlugsByIds(this.idsWithParents(games))
    ])
    return games.map(g =>
      this.formatGame(g, ratingsMap.get(g.id) ?? null, slugs)
    )
  }

  private async enrichWithUserLibraryData<T extends { igdbId: number }>(
    games: T[],
    userId: string | undefined
  ): Promise<
    Array<T & { status?: string; completions?: number; hoursPlayed?: number }>
  > {
    if (!userId || games.length === 0) return games

    const statusMap = await this.userRepository.findUserGameStatusesForGames(
      userId,
      games.map(g => g.igdbId)
    )

    return games.map(g => {
      const entry = statusMap.get(g.igdbId)
      if (!entry) return g
      return { ...g, ...entry }
    })
  }

  async findAllGames(
    query: string | undefined,
    limit: number,
    pageIndex: number,
    sortBy: 'name' | 'release_date' | 'rating' | 'relevance',
    sortOrder: 'asc' | 'desc',
    userId?: string
  ) {
    const { games: cached, total } = await this.gameCacheRepository.findMany({
      limit,
      pageIndex,
      sortBy,
      sortOrder,
      query
    })

    const igdbIds = cached.map(g => g.igdbId)
    const ratingsMap =
      await this.ratingRepository.getAverageRatingsForGames(igdbIds)

    const games = cached.map(g => ({
      igdbId: g.igdbId,
      slug: g.slug ?? null,
      name: g.name,
      coverUrl: g.coverUrl ?? null,
      summary: g.summary ?? undefined,
      genres: g.genres.length > 0 ? g.genres : undefined,
      platforms: g.platforms.length > 0 ? g.platforms : undefined,
      releaseDate: g.releaseDate ?? undefined,
      rating: ratingsMap.get(g.igdbId) ?? null,
      category: g.category ?? -1,
      parentGameId: g.parentGameId ?? null
    }))

    return { games: await this.enrichWithUserLibraryData(games, userId), total }
  }

  async findGameById(igdbId: number) {
    const key = `game:${igdbId}`

    const cached = await this.cacheRepository.get(key)

    let game: IGDBGame | null
    let relatedGames: IGDBGame[]

    if (cached !== null) {
      const parsed = cached as { game: IGDBGame; relatedGames: IGDBGame[] }
      game = parsed.game
      relatedGames = parsed.relatedGames
    } else {
      game = await IGDBService.getGameById(igdbId)

      if (!game) {
        throw new ClientError('Jogo não encontrado.', 404)
      }

      relatedGames = await IGDBService.getRelatedGames(igdbId)

      await this.cacheRepository.set(
        key,
        { game, relatedGames },
        GAME_CACHE_TTL_SECONDS
      )
    }

    const [ratingsMap, slugs] = await Promise.all([
      this.ratingRepository.getAverageRatingsForGames([
        igdbId,
        ...relatedGames.map(g => g.id)
      ]),
      this.slugsForDetail(game, relatedGames)
    ])

    return {
      game: this.formatGame(game, ratingsMap.get(igdbId) ?? null, slugs),
      relatedGames: relatedGames.map(g =>
        this.formatGame(g, ratingsMap.get(g.id) ?? null, slugs)
      )
    }
  }

  async findGameBySlug(slug: string) {
    const normalized = slug.toLowerCase()
    const igdbId = /^\d+$/.test(normalized)
      ? Number(normalized)
      : await this.gameCacheRepository.findIdBySlug(normalized)

    if (igdbId === null || !Number.isSafeInteger(igdbId)) {
      throw new ClientError('Jogo não encontrado.', 404)
    }

    return this.findGameById(igdbId)
  }

  private slugsForDetail(game: IGDBGame, relatedGames: IGDBGame[]) {
    return this.gameCacheRepository.findSlugsByIds(
      this.idsWithParents([game, ...relatedGames])
    )
  }

  async findFeaturedGames(userId?: string) {
    const [trending, mostRated, recent, future] = await Promise.all([
      this.findTrendingGames(6),
      this.findMostRatedGames(6),
      this.findRecentlyReleasedGames(RECENT_FEATURED_LIMIT),
      this.findComingSoonGames(6, 0, userId)
    ])

    const enriched = await this.enrichWithUserLibraryData(
      [...trending.games, ...mostRated.games, ...recent.games],
      userId
    )

    const trendingGames = enriched.slice(0, trending.games.length)
    const mostRatedGames = enriched.slice(
      trending.games.length,
      trending.games.length + mostRated.games.length
    )
    const recentGames = enriched.slice(
      trending.games.length + mostRated.games.length
    )

    return {
      mostRatedGames,
      trendingGames,
      recentGames,
      futureGames: future.games
    }
  }

  private async findRecentlyReleasedGames(limit = 6) {
    const cutoff = IGDBService.getReleaseCutoffEpoch()
    const key = `games:recent:${releaseCutoffDay(cutoff)}:${limit}`
    let games: IGDBGame[]
    const cached = await this.cacheRepository.get(key)

    if (cached !== null) {
      games = (cached as { games: IGDBGame[] }).games
    } else {
      games = await IGDBService.getRecentlyReleasedGames(limit, cutoff)
      await this.cacheRepository.set(key, { games }, GAME_CACHE_TTL_SECONDS)
    }

    return { games: await this.enrichWithRatings(games) }
  }

  async findComingSoonGames(limit = 20, pageIndex = 0, userId?: string) {
    const cutoff = IGDBService.getReleaseCutoffEpoch()
    const key = `games:comingSoon:${releaseCutoffDay(cutoff)}:${limit}:${pageIndex}`
    let games: IGDBGame[]
    let total: number
    const cached = await this.cacheRepository.get(key)

    if (cached !== null) {
      const parsed = cached as { games: IGDBGame[]; total: number }
      games = parsed.games
      total = parsed.total
    } else {
      const results = await IGDBService.getComingSoonGames(
        limit,
        pageIndex,
        cutoff
      )

      games = results.games
      total = results.total

      await this.cacheRepository.set(
        key,
        { games, total },
        GAME_CACHE_TTL_SECONDS
      )
    }

    return {
      games: await this.enrichWithUserLibraryData(
        await this.enrichWithRatings(games),
        userId
      ),
      total
    }
  }

  private async findReleasedGamesByRankedIds(
    rankedIds: number[],
    ratings: Map<number, number | null>
  ) {
    const cutoff = IGDBService.getReleaseCutoffEpoch()
    const keys = rankedIds.map(id => `game:meta:${id}`)
    const cachedResults = await Promise.all(
      keys.map(key => this.cacheRepository.get(key))
    )

    const cachedGames: IGDBGame[] = []
    const missingIds: number[] = []

    rankedIds.forEach((id, i) => {
      const cached = cachedResults[i]
      if (cached !== null) {
        cachedGames.push(cached as IGDBGame)
      } else {
        missingIds.push(id)
      }
    })

    const fetched = await IGDBService.getGamesByIds(missingIds)

    await Promise.all(
      fetched.map(g =>
        this.cacheRepository.set(`game:meta:${g.id}`, g, GAME_CACHE_TTL_SECONDS)
      )
    )

    const games = [...cachedGames, ...fetched]
    const gamesById = new Map(games.map(g => [g.id, g]))

    const ordered = rankedIds
      .map(id => gamesById.get(id))
      .filter(
        (g): g is IGDBGame =>
          !!g &&
          g.first_release_date != null &&
          g.first_release_date < cutoff &&
          !isHiddenFromCatalog(g.game_status, g.first_release_date)
      )

    const slugs = await this.gameCacheRepository.findSlugsByIds(
      this.idsWithParents(ordered)
    )
    return ordered.map(g =>
      this.formatGame(g, ratings.get(g.id) ?? null, slugs)
    )
  }

  private async findTrendingGames(limit = 20) {
    const since = new Date(
      Date.now() - TRENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000
    )
    const trending = await this.userRepository.findTrendingIgdbIds(limit, since)
    if (trending.length === 0) return { games: [], total: 0 }

    const igdbIds = trending.map(t => t.igdbId)
    const ratingsMap =
      await this.ratingRepository.getAverageRatingsForGames(igdbIds)
    const games = await this.findReleasedGamesByRankedIds(igdbIds, ratingsMap)

    return { games, total: games.length }
  }

  private async findMostRatedGames(limit = 20) {
    const topRated = await this.ratingRepository.findTopRatedIgdbIds(limit)
    if (topRated.length === 0) return { games: [], total: 0 }

    const igdbIds = topRated.map(r => r.igdbId)
    const ratingsMap = new Map<number, number | null>(
      topRated.map(r => [r.igdbId, r.avgRating])
    )
    const games = await this.findReleasedGamesByRankedIds(igdbIds, ratingsMap)

    return { games, total: games.length }
  }

  async findSimilarGames(igdbId: number, userId?: string) {
    const key = `game:similar:${igdbId}`

    const cached = await this.cacheRepository.get(key)

    let games: IGDBGame[]

    if (cached !== null) {
      const parsed = cached as { games: IGDBGame[] }

      games = parsed.games
    } else {
      games = (await IGDBService.getSimilarGames(igdbId))
        .filter(g => !isHiddenFromCatalog(g.game_status, g.first_release_date))
        .slice(0, 12)

      await this.cacheRepository.set(key, { games }, GAME_CACHE_TTL_SECONDS)
    }

    return this.enrichWithUserLibraryData(
      await this.enrichWithRatings(games),
      userId
    )
  }
}
