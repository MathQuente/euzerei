import { Prisma } from '../database/prisma-client'
import { isValidCoverUrl } from '../utils/cover-url-change'
import { prisma } from '../database/db'
import { GameCacheSortBy, GameCacheSortOrder } from '../types/game-cache'
import { GAME_STATUS } from '../utils/game-status'
import { isUniqueViolation } from '../utils/prisma-errors'
import { slugCandidates, uniqueSlug } from '../utils/game-slug'
import type { ReleasePrecision } from '../utils/release-precision'
import { MIN_HYPES, MIN_TOTAL_RATING_COUNT } from '../utils/catalog-popularity'

const HIDDEN_STATUS_IDS = [GAME_STATUS.CANCELLED, GAME_STATUS.RUMORED]

export function catalogPopularityWhere(): Prisma.GameCacheWhereInput {
  return {
    OR: [
      { totalRatingCount: { gte: MIN_TOTAL_RATING_COUNT } },
      { hypes: { gte: MIN_HYPES } }
    ]
  }
}

export function catalogPopularitySql() {
  return Prisma.sql`(gc.total_rating_count >= ${MIN_TOTAL_RATING_COUNT} OR gc.hypes >= ${MIN_HYPES})`
}

export function catalogVisibilityWhere(): Prisma.GameCacheWhereInput {
  return {
    OR: [
      { gameStatus: null },
      { gameStatus: { notIn: HIDDEN_STATUS_IDS } },
      { gameStatus: GAME_STATUS.CANCELLED, releaseDate: { not: null } }
    ]
  }
}

export function catalogVisibilitySql() {
  return Prisma.sql`(gc.game_status IS NULL OR gc.game_status NOT IN (${Prisma.join(HIDDEN_STATUS_IDS)}) OR (gc.game_status = ${GAME_STATUS.CANCELLED} AND gc.release_date IS NOT NULL))`
}

export function normalizeSearchTerm(query: string | undefined) {
  return query?.trim().replace(/\s+/g, ' ') ?? ''
}

export function escapeLike(term: string) {
  return term.replace(/[\\%_]/g, '\\$&')
}

const FOLDED_NAME = Prisma.sql`unaccent(lower(gc.name))`

export function relevanceMatchSql(query: string) {
  return Prisma.sql`${FOLDED_NAME} LIKE unaccent(lower(${`%${escapeLike(query)}%`})) ESCAPE '\\'`
}

export function relevanceOrderSql(query: string) {
  const term = escapeLike(query)
  return Prisma.sql`CASE
      WHEN ${FOLDED_NAME} = unaccent(lower(${query})) THEN 0
      WHEN ${FOLDED_NAME} LIKE unaccent(lower(${`${term}%`})) ESCAPE '\\' THEN 1
      WHEN ${FOLDED_NAME} LIKE unaccent(lower(${`% ${term}%`})) ESCAPE '\\' THEN 2
      ELSE 3
    END,
    (gc.parent_game_id IS NOT NULL),
    gc.total_rating_count DESC NULLS LAST,
    gc.hypes DESC NULLS LAST,
    gc.name ASC,
    gc.igdb_id ASC`
}

export class GameCacheRepository {
  async findMany({
    limit = 20,
    pageIndex = 0,
    sortBy = 'release_date' as GameCacheSortBy,
    sortOrder = 'desc' as GameCacheSortOrder,
    query
  }: {
    limit?: number
    pageIndex?: number
    sortBy?: GameCacheSortBy
    sortOrder?: GameCacheSortOrder
    query?: string
  }) {
    const offset = pageIndex * limit

    if (sortBy === 'rating') {
      return this.findManyByRating({ limit, offset, sortOrder, query })
    }

    const searchTerm = normalizeSearchTerm(query)
    if (sortBy === 'relevance' && searchTerm) {
      return this.findManyByRelevance({ limit, offset, query: searchTerm })
    }

    const where: Prisma.GameCacheWhereInput = {
      AND: [catalogPopularityWhere(), catalogVisibilityWhere()],
      ...(query ? { name: { contains: query, mode: 'insensitive' } } : {})
    }

    const orderBy: Prisma.GameCacheOrderByWithRelationInput =
      sortBy === 'name'
        ? { name: sortOrder }
        : { releaseDate: { sort: sortOrder, nulls: 'last' } }

    const [games, total] = await Promise.all([
      prisma.gameCache.findMany({
        where,
        orderBy,
        skip: offset,
        take: limit,
        select: {
          igdbId: true,
          slug: true,
          name: true,
          coverUrl: true,
          summary: true,
          genres: true,
          platforms: true,
          releaseDate: true,
          releaseDatePrecision: true,
          category: true,
          parentGameId: true
        }
      }),
      prisma.gameCache.count({ where })
    ])

    return { games, total }
  }

  private async findManyByRelevance({
    limit,
    offset,
    query
  }: {
    limit: number
    offset: number
    query: string
  }) {
    const where = Prisma.sql`WHERE ${catalogPopularitySql()} AND ${catalogVisibilitySql()} AND ${relevanceMatchSql(query)}`

    const [games, countResult] = await Promise.all([
      prisma.$queryRaw<
        Array<{
          igdb_id: number
          slug: string | null
          name: string
          cover_url: string | null
          summary: string | null
          genres: string[]
          platforms: string[]
          release_date: number | null
          release_date_precision: string | null
          category: number | null
          parent_game_id: number | null
        }>
      >(Prisma.sql`
        SELECT gc.igdb_id, gc.slug, gc.name, gc.cover_url, gc.summary, gc.genres, gc.platforms, gc.release_date,
               gc.release_date_precision, gc.category, gc.parent_game_id
        FROM games_cache gc
        ${where}
        ORDER BY ${relevanceOrderSql(query)}
        LIMIT ${limit} OFFSET ${offset}
      `),
      prisma.$queryRaw<[{ count: bigint }]>(Prisma.sql`
        SELECT COUNT(*) FROM games_cache gc ${where}
      `)
    ])

    return {
      games: games.map(g => ({
        igdbId: g.igdb_id,
        slug: g.slug,
        name: g.name,
        coverUrl: g.cover_url,
        summary: g.summary,
        genres: g.genres,
        platforms: g.platforms,
        releaseDate: g.release_date,
        releaseDatePrecision: g.release_date_precision,
        category: g.category,
        parentGameId: g.parent_game_id
      })),
      total: Number(countResult[0].count)
    }
  }

  private async findManyByRating({
    limit,
    offset,
    sortOrder,
    query
  }: {
    limit: number
    offset: number
    sortOrder: GameCacheSortOrder
    query?: string
  }) {
    const direction = sortOrder === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`
    const nameFilter = query
      ? Prisma.sql`AND gc.name ILIKE ${`%${query}%`}`
      : Prisma.empty
    const where = Prisma.sql`WHERE ${catalogPopularitySql()} AND ${catalogVisibilitySql()} ${nameFilter}`

    const [games, countResult] = await Promise.all([
      prisma.$queryRaw<
        Array<{
          igdb_id: number
          slug: string | null
          name: string
          cover_url: string | null
          summary: string | null
          genres: string[]
          platforms: string[]
          release_date: number | null
          release_date_precision: string | null
          category: number | null
          parent_game_id: number | null
        }>
      >(Prisma.sql`
        SELECT gc.igdb_id, gc.slug, gc.name, gc.cover_url, gc.summary, gc.genres, gc.platforms, gc.release_date,
               gc.release_date_precision, gc.category, gc.parent_game_id,
               AVG(r.value) as avg_rating
        FROM games_cache gc
        LEFT JOIN ratings r ON r.igdb_id = gc.igdb_id
        ${where}
        GROUP BY gc.igdb_id
        ORDER BY avg_rating ${direction} NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
      `),
      prisma.$queryRaw<[{ count: bigint }]>(Prisma.sql`
        SELECT COUNT(*) FROM games_cache gc ${where}
      `)
    ])

    return {
      games: games.map(g => ({
        igdbId: g.igdb_id,
        slug: g.slug,
        name: g.name,
        coverUrl: g.cover_url,
        summary: g.summary,
        genres: g.genres,
        platforms: g.platforms,
        releaseDate: g.release_date,
        releaseDatePrecision: g.release_date_precision,
        category: g.category,
        parentGameId: g.parent_game_id
      })),
      total: Number(countResult[0].count)
    }
  }

  async upsertMany(
    games: Array<{
      igdbId: number
      name: string
      coverUrl: string | null
      summary?: string
      genres: string[]
      platforms: string[]
      releaseDate?: number
      releaseDatePrecision?: ReleasePrecision
      hypes?: number
      totalRatingCount?: number
      category?: number
      parentGameId?: number | null
      gameModes?: number[]
      gameStatus?: number | null
    }>
  ) {
    await prisma.gameCache.createMany({
      data: games.map(g => ({
        igdbId: g.igdbId,
        name: g.name,
        coverUrl: g.coverUrl,
        summary: g.summary ?? null,
        genres: g.genres,
        platforms: g.platforms,
        releaseDate: g.releaseDate ?? null,
        releaseDatePrecision: g.releaseDatePrecision ?? null,
        hypes: g.hypes ?? 0,
        totalRatingCount: g.totalRatingCount ?? 0,
        category: g.category ?? -1,
        parentGameId: g.parentGameId ?? null,
        gameModes: g.gameModes ?? [],
        gameModesCheckedAt: g.gameModes ? new Date() : null,
        gameStatus: g.gameStatus ?? null
      })),
      skipDuplicates: true
    })
    await this.assignMissingSlugs(games.map(g => g.igdbId)).catch(error =>
      console.error('[GameCache] assignMissingSlugs failed', error)
    )
  }

  async assignMissingSlugs(igdbIds: number[]): Promise<number> {
    if (igdbIds.length === 0) return 0
    const rows = await prisma.gameCache.findMany({
      where: { igdbId: { in: igdbIds }, slug: null },
      orderBy: { igdbId: 'asc' },
      select: { igdbId: true, name: true }
    })
    if (rows.length === 0) return 0

    const taken = await this.findTakenSlugs(
      rows.flatMap(r => slugCandidates(r.name, r.igdbId))
    )
    const updates = rows.map(r => ({
      igdbId: r.igdbId,
      slug: this.claimSlug(r, taken)
    }))

    try {
      return await this.updateSlugs(updates)
    } catch (error) {
      console.warn(
        '[GameCache] batch slug update failed, retrying row by row',
        error
      )
    }

    let written = 0
    for (const row of rows) {
      written += await this.assignSlugOneByOne(row)
    }
    return written
  }

  private async assignSlugOneByOne(row: {
    igdbId: number
    name: string
  }): Promise<number> {
    for (const candidate of [
      ...slugCandidates(row.name, row.igdbId),
      String(row.igdbId)
    ]) {
      try {
        const result = await prisma.gameCache.updateMany({
          where: { igdbId: row.igdbId, slug: null },
          data: { slug: candidate }
        })
        return result.count
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
      }
    }
    return 0
  }

  private async findTakenSlugs(candidates: string[]): Promise<Set<string>> {
    const rows = await prisma.gameCache.findMany({
      where: { slug: { in: candidates } },
      select: { slug: true }
    })
    return new Set(rows.map(r => r.slug as string))
  }

  private claimSlug(
    game: { igdbId: number; name: string },
    taken: Set<string>
  ): string {
    const slug = uniqueSlug(game.name, game.igdbId, s => taken.has(s))
    taken.add(slug)
    return slug
  }

  async findSlugsByIds(igdbIds: number[]): Promise<Map<number, string>> {
    if (igdbIds.length === 0) return new Map()
    const rows = await prisma.gameCache.findMany({
      where: { igdbId: { in: igdbIds }, slug: { not: null } },
      select: { igdbId: true, slug: true }
    })
    return new Map(rows.map(r => [r.igdbId, r.slug as string]))
  }

  async findIdBySlug(slug: string): Promise<number | null> {
    const row = await prisma.gameCache.findUnique({
      where: { slug },
      select: { igdbId: true }
    })
    return row?.igdbId ?? null
  }

  async findSlugBackfillBatchAfter(afterId: number, limit: number) {
    return prisma.gameCache.findMany({
      where: { igdbId: { gt: afterId } },
      orderBy: { igdbId: 'asc' },
      take: limit,
      select: { igdbId: true, name: true, slug: true }
    })
  }

  async findAllSlugs(): Promise<string[]> {
    const rows = await prisma.gameCache.findMany({
      where: { slug: { not: null } },
      select: { slug: true }
    })
    return rows.map(r => r.slug as string)
  }

  async updateSlugs(
    updates: Array<{ igdbId: number; slug: string }>
  ): Promise<number> {
    if (updates.length === 0) return 0
    const rows = JSON.stringify(
      updates.map(u => ({ id: u.igdbId, slug: u.slug }))
    )
    return prisma.$executeRaw(Prisma.sql`
      UPDATE games_cache gc
      SET slug = v.slug
      FROM jsonb_to_recordset(${rows}::jsonb) AS v(id int, slug text)
      WHERE gc.igdb_id = v.id
        AND gc.slug IS NULL
    `)
  }

  async findByIgdbId(igdbId: number) {
    return prisma.gameCache.findUnique({
      where: { igdbId },
      select: { igdbId: true }
    })
  }

  async findReleaseInfoByIgdbId(igdbId: number) {
    return prisma.gameCache.findUnique({
      where: { igdbId },
      select: { releaseDate: true, gameModes: true, name: true }
    })
  }

  async findEndlessInputByIgdbId(
    igdbId: number
  ): Promise<{ gameModes: number[]; name: string } | null> {
    return prisma.gameCache.findUnique({
      where: { igdbId },
      select: { gameModes: true, name: true }
    })
  }

  async findIgdbIdsAfter(afterId: number, limit: number): Promise<number[]> {
    const rows = await prisma.gameCache.findMany({
      where: { igdbId: { gt: afterId } },
      orderBy: { igdbId: 'asc' },
      take: limit,
      select: { igdbId: true }
    })
    return rows.map(r => r.igdbId)
  }

  async findIgdbIdsWithoutCheckedGameModesAfter(
    afterId: number,
    limit: number
  ): Promise<number[]> {
    const rows = await prisma.gameCache.findMany({
      where: { igdbId: { gt: afterId }, gameModesCheckedAt: null },
      orderBy: { igdbId: 'asc' },
      take: limit,
      select: { igdbId: true }
    })
    return rows.map(r => r.igdbId)
  }

  async findIdsWithUnknownCategoryAfter(
    afterId: number,
    limit: number
  ): Promise<number[]> {
    const rows = await prisma.gameCache.findMany({
      where: { igdbId: { gt: afterId }, category: -1 },
      orderBy: { igdbId: 'asc' },
      take: limit,
      select: { igdbId: true }
    })
    return rows.map(r => r.igdbId)
  }

  async updateCategories(updates: Array<{ igdbId: number; category: number }>) {
    const known = updates.filter(
      u => Number.isInteger(u.category) && u.category >= 0
    )
    if (known.length === 0) return
    const rows = JSON.stringify(
      known.map(u => ({ id: u.igdbId, category: u.category }))
    )
    await prisma.$executeRaw(Prisma.sql`
      UPDATE games_cache gc
      SET category = v.category
      FROM jsonb_to_recordset(${rows}::jsonb) AS v(id int, category int)
      WHERE gc.igdb_id = v.id
    `)
  }

  async findReleaseDateCandidatesAfter(
    afterId: number,
    limit: number,
    sinceEpoch: number,
    includeUndated: boolean
  ): Promise<
    Array<{
      igdbId: number
      name: string
      releaseDate: number | null
      gameStatus: number | null
    }>
  > {
    return prisma.gameCache.findMany({
      where: {
        igdbId: { gt: afterId },
        OR: [
          { releaseDate: { gte: sinceEpoch } },
          ...(includeUndated ? [{ releaseDate: null }] : [])
        ]
      },
      orderBy: { igdbId: 'asc' },
      take: limit,
      select: { igdbId: true, name: true, releaseDate: true, gameStatus: true }
    })
  }

  async updateReleaseDates(
    updates: Array<{ igdbId: number; releaseDate: number | null }>
  ): Promise<number> {
    if (updates.length === 0) return 0
    const invalid = updates.find(
      u => u.releaseDate !== null && !Number.isInteger(u.releaseDate)
    )
    if (invalid) {
      throw new Error(
        `Invalid release date for ${invalid.igdbId}: ${invalid.releaseDate}`
      )
    }
    const rows = JSON.stringify(
      updates.map(u => ({ id: u.igdbId, release_date: u.releaseDate }))
    )
    return prisma.$executeRaw(Prisma.sql`
      UPDATE games_cache gc
      SET release_date = v.release_date,
          release_date_precision = NULL
      FROM jsonb_to_recordset(${rows}::jsonb) AS v(id int, release_date int)
      WHERE gc.igdb_id = v.id
        AND gc.release_date IS DISTINCT FROM v.release_date
    `)
  }

  async restoreReleaseDates(
    rows: Array<{
      igdbId: number
      previous: number | null
      next: number | null
    }>,
    dryRun: boolean
  ): Promise<number> {
    if (rows.length === 0) return 0
    const json = JSON.stringify(
      rows.map(r => ({ id: r.igdbId, previous: r.previous, next: r.next }))
    )
    if (dryRun) {
      const counted = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        SELECT count(*) AS count
        FROM games_cache gc
        JOIN jsonb_to_recordset(${json}::jsonb) AS v(id int, previous int, next int)
          ON gc.igdb_id = v.id
        WHERE gc.release_date IS NOT DISTINCT FROM v.next
      `)
      return Number(counted[0]?.count ?? 0)
    }
    return prisma.$executeRaw(Prisma.sql`
      UPDATE games_cache gc
      SET release_date = v.previous
      FROM jsonb_to_recordset(${json}::jsonb) AS v(id int, previous int, next int)
      WHERE gc.igdb_id = v.id
        AND gc.release_date IS NOT DISTINCT FROM v.next
    `)
  }

  async findPrecisionRowsAfter(
    afterId: number,
    limit: number
  ): Promise<
    Array<{
      igdbId: number
      releaseDate: number | null
      releaseDatePrecision: string | null
    }>
  > {
    return prisma.gameCache.findMany({
      where: { igdbId: { gt: afterId }, releaseDate: { not: null } },
      orderBy: { igdbId: 'asc' },
      take: limit,
      select: { igdbId: true, releaseDate: true, releaseDatePrecision: true }
    })
  }

  async updateReleasePrecisions(
    updates: Array<{
      igdbId: number
      precision: string | null
      /** A data para a qual a precisão foi calculada. */
      releaseDate: number
    }>
  ): Promise<number> {
    if (updates.length === 0) return 0
    const rows = JSON.stringify(
      updates.map(u => ({
        id: u.igdbId,
        precision: u.precision,
        release_date: u.releaseDate
      }))
    )
    // Só grava se a data ainda é a que a precisão descreve: o backfill de datas
    // pode ter mudado a linha enquanto este script lia a IGDB.
    return prisma.$executeRaw(Prisma.sql`
      UPDATE games_cache gc
      SET release_date_precision = v.precision
      FROM jsonb_to_recordset(${rows}::jsonb)
        AS v(id int, precision text, release_date int)
      WHERE gc.igdb_id = v.id
        AND gc.release_date IS NOT DISTINCT FROM v.release_date
        AND gc.release_date_precision IS DISTINCT FROM v.precision
    `)
  }

  async restoreReleasePrecisions(
    rows: Array<{
      igdbId: number
      previous: string | null
      next: string | null
    }>,
    dryRun: boolean
  ): Promise<number> {
    if (rows.length === 0) return 0
    const json = JSON.stringify(
      rows.map(r => ({ id: r.igdbId, previous: r.previous, next: r.next }))
    )
    if (dryRun) {
      const counted = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        SELECT count(*) AS count
        FROM games_cache gc
        JOIN jsonb_to_recordset(${json}::jsonb) AS v(id int, previous text, next text)
          ON gc.igdb_id = v.id
        WHERE gc.release_date_precision IS NOT DISTINCT FROM v.next
      `)
      return Number(counted[0]?.count ?? 0)
    }
    return prisma.$executeRaw(Prisma.sql`
      UPDATE games_cache gc
      SET release_date_precision = v.previous
      FROM jsonb_to_recordset(${json}::jsonb) AS v(id int, previous text, next text)
      WHERE gc.igdb_id = v.id
        AND gc.release_date_precision IS NOT DISTINCT FROM v.next
    `)
  }

  async findCoverCandidatesAfter(
    afterId: number,
    limit: number,
    sinceEpoch: number | null
  ): Promise<Array<{ igdbId: number; name: string; coverUrl: string | null }>> {
    return prisma.gameCache.findMany({
      where: {
        igdbId: { gt: afterId },
        ...(sinceEpoch === null ? {} : { releaseDate: { gte: sinceEpoch } })
      },
      orderBy: { igdbId: 'asc' },
      take: limit,
      select: { igdbId: true, name: true, coverUrl: true }
    })
  }

  async updateCoverUrls(
    updates: Array<{ igdbId: number; coverUrl: string }>
  ): Promise<number> {
    if (updates.length === 0) return 0
    const invalid = updates.find(u => !isValidCoverUrl(u.coverUrl))
    if (invalid) {
      throw new Error(
        `Invalid cover url for ${invalid.igdbId}: ${invalid.coverUrl}`
      )
    }
    const rows = JSON.stringify(
      updates.map(u => ({ id: u.igdbId, cover_url: u.coverUrl }))
    )
    return prisma.$executeRaw(Prisma.sql`
      UPDATE games_cache gc
      SET cover_url = v.cover_url
      FROM jsonb_to_recordset(${rows}::jsonb) AS v(id int, cover_url text)
      WHERE gc.igdb_id = v.id
        AND gc.cover_url IS DISTINCT FROM v.cover_url
    `)
  }

  async restoreCoverUrls(
    rows: Array<{ igdbId: number; previous: string | null; next: string }>,
    dryRun: boolean
  ): Promise<number> {
    if (rows.length === 0) return 0
    const json = JSON.stringify(
      rows.map(r => ({ id: r.igdbId, previous: r.previous, next: r.next }))
    )
    if (dryRun) {
      const counted = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        SELECT count(*) AS count
        FROM games_cache gc
        JOIN jsonb_to_recordset(${json}::jsonb) AS v(id int, previous text, next text)
          ON gc.igdb_id = v.id
        WHERE gc.cover_url IS NOT DISTINCT FROM v.next
      `)
      return Number(counted[0]?.count ?? 0)
    }
    return prisma.$executeRaw(Prisma.sql`
      UPDATE games_cache gc
      SET cover_url = v.previous
      FROM jsonb_to_recordset(${json}::jsonb) AS v(id int, previous text, next text)
      WHERE gc.igdb_id = v.id
        AND gc.cover_url IS NOT DISTINCT FROM v.next
    `)
  }

  async findPopularityByIds(
    ids: number[]
  ): Promise<
    Map<number, { hypes: number | null; totalRatingCount: number | null }>
  > {
    const found = new Map<
      number,
      { hypes: number | null; totalRatingCount: number | null }
    >()
    for (let i = 0; i < ids.length; i += 5000) {
      const rows = await prisma.gameCache.findMany({
        where: { igdbId: { in: ids.slice(i, i + 5000) } },
        select: { igdbId: true, hypes: true, totalRatingCount: true }
      })
      for (const row of rows) {
        found.set(row.igdbId, {
          hypes: row.hypes,
          totalRatingCount: row.totalRatingCount
        })
      }
    }
    return found
  }

  async findPopularIdsAfter(afterId: number, limit: number): Promise<number[]> {
    const rows = await prisma.gameCache.findMany({
      where: { igdbId: { gt: afterId }, AND: [catalogPopularityWhere()] },
      orderBy: { igdbId: 'asc' },
      take: limit,
      select: { igdbId: true }
    })
    return rows.map(r => r.igdbId)
  }

  async updatePopularity(
    updates: Array<{ igdbId: number; hypes: number; totalRatingCount: number }>
  ): Promise<number> {
    if (updates.length === 0) return 0
    const invalid = updates.find(
      u =>
        !Number.isInteger(u.hypes) ||
        u.hypes < 0 ||
        !Number.isInteger(u.totalRatingCount) ||
        u.totalRatingCount < 0
    )
    if (invalid) {
      throw new Error(`Invalid popularity values for ${invalid.igdbId}`)
    }
    const rows = JSON.stringify(
      updates.map(u => ({
        id: u.igdbId,
        hypes: u.hypes,
        total_rating_count: u.totalRatingCount
      }))
    )
    return prisma.$executeRaw(Prisma.sql`
      UPDATE games_cache gc
      SET hypes = v.hypes, total_rating_count = v.total_rating_count
      FROM jsonb_to_recordset(${rows}::jsonb) AS v(id int, hypes int, total_rating_count int)
      WHERE gc.igdb_id = v.id
        AND (gc.hypes IS DISTINCT FROM v.hypes
          OR gc.total_rating_count IS DISTINCT FROM v.total_rating_count)
    `)
  }

  async restorePopularity(
    rows: Array<{
      igdbId: number
      previous: { hypes: number | null; totalRatingCount: number | null }
      next: { hypes: number; totalRatingCount: number }
    }>,
    dryRun: boolean
  ): Promise<number> {
    if (rows.length === 0) return 0
    const json = JSON.stringify(
      rows.map(r => ({
        id: r.igdbId,
        previous_hypes: r.previous.hypes,
        previous_trc: r.previous.totalRatingCount,
        next_hypes: r.next.hypes,
        next_trc: r.next.totalRatingCount
      }))
    )
    const recordset = Prisma.sql`jsonb_to_recordset(${json}::jsonb) AS v(id int, previous_hypes int, previous_trc int, next_hypes int, next_trc int)`
    if (dryRun) {
      const counted = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        SELECT count(*) AS count
        FROM games_cache gc
        JOIN ${recordset} ON gc.igdb_id = v.id
        WHERE gc.hypes IS NOT DISTINCT FROM v.next_hypes
          AND gc.total_rating_count IS NOT DISTINCT FROM v.next_trc
      `)
      return Number(counted[0]?.count ?? 0)
    }
    return prisma.$executeRaw(Prisma.sql`
      UPDATE games_cache gc
      SET hypes = v.previous_hypes, total_rating_count = v.previous_trc
      FROM ${recordset}
      WHERE gc.igdb_id = v.id
        AND gc.hypes IS NOT DISTINCT FROM v.next_hypes
        AND gc.total_rating_count IS NOT DISTINCT FROM v.next_trc
    `)
  }

  async findReferencedIgdbIds(ids: number[]): Promise<Set<number>> {
    const referenced = new Set<number>()
    for (let i = 0; i < ids.length; i += 5000) {
      const chunk = ids.slice(i, i + 5000)
      const [libraries, ratings, reviews, favorites] = await Promise.all([
        prisma.userGame.findMany({
          where: { igdbId: { in: chunk } },
          distinct: ['igdbId'],
          select: { igdbId: true }
        }),
        prisma.rating.findMany({
          where: { igdbId: { in: chunk } },
          distinct: ['igdbId'],
          select: { igdbId: true }
        }),
        prisma.review.findMany({
          where: { igdbId: { in: chunk } },
          distinct: ['igdbId'],
          select: { igdbId: true }
        }),
        prisma.userFavoriteGame.findMany({
          where: { igdbId: { in: chunk } },
          distinct: ['igdbId'],
          select: { igdbId: true }
        })
      ])
      for (const row of [...libraries, ...ratings, ...reviews, ...favorites]) {
        referenced.add(row.igdbId)
      }
    }
    return referenced
  }

  async deleteUnreferencedCacheRows(
    ids: number[],
    dryRun: boolean
  ): Promise<{ deleted: number; skipped: number[] }> {
    const referenced = await this.findReferencedIgdbIds(ids)
    const skipped = ids.filter(id => referenced.has(id))
    let deleted = ids.length - skipped.length
    if (!dryRun) {
      deleted = 0
      for (let i = 0; i < ids.length; i += 5000) {
        const chunk = ids.slice(i, i + 5000)
        deleted += await prisma.$executeRaw(Prisma.sql`
          DELETE FROM games_cache gc
          WHERE gc.igdb_id IN (${Prisma.join(chunk)})
            AND NOT EXISTS (SELECT 1 FROM user_games x WHERE x.igdb_id = gc.igdb_id)
            AND NOT EXISTS (SELECT 1 FROM ratings x WHERE x.igdb_id = gc.igdb_id)
            AND NOT EXISTS (SELECT 1 FROM reviews x WHERE x.igdb_id = gc.igdb_id)
            AND NOT EXISTS (SELECT 1 FROM user_favorite_games x WHERE x.igdb_id = gc.igdb_id)
        `)
      }
    }
    return { deleted, skipped }
  }

  async updateGameModes(
    updates: Array<{ igdbId: number; gameModes: number[] }>
  ) {
    if (updates.length === 0) return
    const rows = JSON.stringify(
      updates.map(u => ({ id: u.igdbId, modes: u.gameModes }))
    )
    await prisma.$executeRaw(Prisma.sql`
      UPDATE games_cache gc
      SET game_modes = ARRAY(SELECT jsonb_array_elements_text(v.modes)::int),
          game_modes_checked_at = NOW()
      FROM jsonb_to_recordset(${rows}::jsonb) AS v(id int, modes jsonb)
      WHERE gc.igdb_id = v.id
    `)
  }

  async markGameModesChecked(igdbIds: number[]) {
    if (igdbIds.length === 0) return
    await prisma.gameCache.updateMany({
      where: { igdbId: { in: igdbIds } },
      data: { gameModesCheckedAt: new Date() }
    })
  }

  async updateGameStatuses(
    updates: Array<{ igdbId: number; gameStatus: number | null }>
  ) {
    if (updates.length === 0) return
    const rows = JSON.stringify(
      updates.map(u => ({ id: u.igdbId, status: u.gameStatus }))
    )
    await prisma.$executeRaw(Prisma.sql`
      UPDATE games_cache gc
      SET game_status = v.status
      FROM jsonb_to_recordset(${rows}::jsonb) AS v(id int, status int)
      WHERE gc.igdb_id = v.id
    `)
  }

  async findHiddenStatusIdsAfter(
    afterId: number,
    limit: number
  ): Promise<number[]> {
    const rows = await prisma.gameCache.findMany({
      where: { igdbId: { gt: afterId }, gameStatus: { in: HIDDEN_STATUS_IDS } },
      orderBy: { igdbId: 'asc' },
      take: limit,
      select: { igdbId: true }
    })
    return rows.map(r => r.igdbId)
  }

  async getMaxIgdbId(): Promise<number> {
    const result = await prisma.gameCache.findFirst({
      orderBy: { igdbId: 'desc' },
      select: { igdbId: true }
    })
    return result?.igdbId ?? 0
  }

  async count(): Promise<number> {
    return prisma.gameCache.count()
  }

  async findManyMissingHypes(limit: number): Promise<number[]> {
    const rows = await prisma.gameCache.findMany({
      where: { hypes: null },
      orderBy: { igdbId: 'asc' },
      take: limit,
      select: { igdbId: true }
    })
    return rows.map(r => r.igdbId)
  }

  async updateHypes(updates: Array<{ igdbId: number; hypes: number }>) {
    await prisma.$transaction(
      updates.map(u =>
        prisma.gameCache.update({
          where: { igdbId: u.igdbId },
          data: { hypes: u.hypes }
        })
      )
    )
  }

  async findManyMissingTotalRatingCount(limit: number): Promise<number[]> {
    const rows = await prisma.gameCache.findMany({
      where: { totalRatingCount: null },
      orderBy: { igdbId: 'asc' },
      take: limit,
      select: { igdbId: true }
    })
    return rows.map(r => r.igdbId)
  }

  async updateTotalRatingCounts(
    updates: Array<{ igdbId: number; totalRatingCount: number }>
  ) {
    await prisma.$transaction(
      updates.map(u =>
        prisma.gameCache.update({
          where: { igdbId: u.igdbId },
          data: { totalRatingCount: u.totalRatingCount }
        })
      )
    )
  }

  async findManyMissingCategoryOrParent(limit: number): Promise<number[]> {
    const rows = await prisma.gameCache.findMany({
      where: { category: null },
      orderBy: { igdbId: 'asc' },
      take: limit,
      select: { igdbId: true }
    })
    return rows.map(r => r.igdbId)
  }

  async updateCategoryAndParent(
    updates: Array<{
      igdbId: number
      category: number
      parentGameId: number | null
    }>
  ) {
    await prisma.$transaction(
      updates.map(u =>
        prisma.gameCache.update({
          where: { igdbId: u.igdbId },
          data: { category: u.category, parentGameId: u.parentGameId }
        })
      )
    )
  }
}
