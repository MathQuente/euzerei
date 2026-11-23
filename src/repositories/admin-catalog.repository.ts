import { prisma } from '../database/db'
import { escapeLike } from '../utils/escape-like'

export interface CatalogCounts {
  total: number
  noCover: number
  noPrecision: number
  modesUnchecked: number
  noSlug: number
  hypesNull: number
  updated7d: number
  lastSyncedAt: Date | null
}

export interface AddedCounts {
  games: number
  additions: number
}

export interface TopAddedRow {
  igdbId: number
  name: string
  users: number
}

export interface GameListRow {
  igdbId: number
  name: string
  slug: string | null
  coverUrl: string | null
  releaseDate: number | null
  releaseDatePrecision: string | null
}

export interface GameDetailRow extends GameListRow {
  platforms: string[]
  syncedAt: Date
  hasModes: boolean
  modesChecked: boolean
  libraries: number
}

export interface CatalogStore {
  counts(weekAgo: Date): Promise<CatalogCounts>
  added(since: Date): Promise<AddedCounts>
  topAdded(since: Date, limit: number): Promise<TopAddedRow[]>
  search(query: string, limit: number): Promise<GameListRow[]>
  game(igdbId: number): Promise<GameDetailRow | null>
  lastRuns(actions: string[]): Promise<Map<string, Date>>
}

interface ListRaw {
  igdb_id: number
  name: string
  slug: string | null
  cover_url: string | null
  release_date: number | null
  release_date_precision: string | null
}

const toList = (row: ListRaw): GameListRow => ({
  igdbId: row.igdb_id,
  name: row.name,
  slug: row.slug,
  coverUrl: row.cover_url,
  releaseDate: row.release_date,
  releaseDatePrecision: row.release_date_precision
})

export class AdminCatalogRepository implements CatalogStore {
  async counts(weekAgo: Date): Promise<CatalogCounts> {
    const rows = await prisma.$queryRaw<
      (Omit<CatalogCounts, 'lastSyncedAt'> & { lastSyncedAt: Date | null })[]
    >`
      SELECT
        count(*)::int AS total,
        (count(*) FILTER (WHERE cover_url IS NULL))::int AS "noCover",
        (count(*) FILTER (
          WHERE release_date_precision IS NULL AND release_date IS NOT NULL
        ))::int AS "noPrecision",
        (count(*) FILTER (
          WHERE coalesce(array_length(game_modes, 1), 0) = 0
            AND game_modes_checked_at IS NULL
        ))::int AS "modesUnchecked",
        (count(*) FILTER (WHERE slug IS NULL))::int AS "noSlug",
        (count(*) FILTER (WHERE hypes IS NULL))::int AS "hypesNull",
        (count(*) FILTER (WHERE synced_at >= ${weekAgo}))::int AS "updated7d",
        max(synced_at) AS "lastSyncedAt"
      FROM games_cache`
    return rows[0]
  }

  async added(since: Date): Promise<AddedCounts> {
    const rows = await prisma.$queryRaw<AddedCounts[]>`
      SELECT count(DISTINCT igdb_id)::int AS games, count(*)::int AS additions
      FROM user_games
      WHERE created_at >= ${since}`
    return rows[0]
  }

  async topAdded(since: Date, limit: number): Promise<TopAddedRow[]> {
    const rows = await prisma.$queryRaw<
      { igdb_id: number; name: string; users: number }[]
    >`
      SELECT t.igdb_id, g.name, t.users
      FROM (
        SELECT igdb_id, count(DISTINCT user_id)::int AS users
        FROM user_games
        WHERE created_at >= ${since}
        GROUP BY igdb_id
        ORDER BY users DESC, igdb_id ASC
        LIMIT ${limit}
      ) t
      JOIN games_cache g ON g.igdb_id = t.igdb_id
      ORDER BY t.users DESC, t.igdb_id ASC`
    return rows.map(row => ({
      igdbId: row.igdb_id,
      name: row.name,
      users: row.users
    }))
  }

  async search(query: string, limit: number): Promise<GameListRow[]> {
    const id = /^\d{1,10}$/.test(query) ? Number(query) : -1
    const slug = query.toLowerCase()
    const contains = `%${escapeLike(query)}%`
    const prefix = `${escapeLike(query)}%`
    const rows = await prisma.$queryRaw<ListRaw[]>`
      SELECT igdb_id, name, slug, cover_url, release_date, release_date_precision
      FROM games_cache
      WHERE igdb_id = ${id} OR slug = ${slug} OR name ILIKE ${contains}
      ORDER BY (igdb_id = ${id}) DESC,
               (slug = ${slug}) DESC,
               (name ILIKE ${prefix}) DESC,
               total_rating_count DESC NULLS LAST,
               igdb_id ASC
      LIMIT ${limit}`
    return rows.map(toList)
  }

  async game(igdbId: number): Promise<GameDetailRow | null> {
    const rows = await prisma.$queryRaw<
      (ListRaw & {
        platforms: string[]
        synced_at: Date
        has_modes: boolean
        modes_checked: boolean
        libraries: number
      })[]
    >`
      SELECT
        g.igdb_id, g.name, g.slug, g.cover_url, g.release_date,
        g.release_date_precision, g.platforms, g.synced_at,
        (coalesce(array_length(g.game_modes, 1), 0) > 0) AS has_modes,
        (g.game_modes_checked_at IS NOT NULL) AS modes_checked,
        (SELECT count(DISTINCT user_id)::int FROM user_games u
          WHERE u.igdb_id = g.igdb_id) AS libraries
      FROM games_cache g
      WHERE g.igdb_id = ${igdbId}`
    const row = rows[0]
    if (!row) return null
    return {
      ...toList(row),
      platforms: row.platforms,
      syncedAt: row.synced_at,
      hasModes: row.has_modes,
      modesChecked: row.modes_checked,
      libraries: row.libraries
    }
  }

  async lastRuns(actions: string[]): Promise<Map<string, Date>> {
    const rows = await prisma.auditLog.groupBy({
      by: ['action'],
      where: { action: { in: actions }, result: 'OK' },
      _max: { createdAt: true }
    })
    const runs = new Map<string, Date>()
    for (const row of rows) {
      if (row._max.createdAt) runs.set(row.action, row._max.createdAt)
    }
    return runs
  }
}
