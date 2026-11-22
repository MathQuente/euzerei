import { prisma } from '../database/db'

export interface UserTotals {
  total: number
  new7d: number
  verified: number
  oauthOnly: number
  linkedStore: number
  withGames: number
  finishedGame: number
  active7d: number
}

export interface SignupDay {
  date: string
  count: number
}

export interface CatalogCounts {
  total: number
  noCover: number
  modesUnchecked: number
  noSlug: number
}

export interface OverviewStore {
  userTotals(weekAgo: Date): Promise<UserTotals>
  gamesTotal(): Promise<number>
  signupsByDay(since: Date): Promise<SignupDay[]>
  catalogCounts(): Promise<CatalogCounts>
}

type UserRow = Omit<UserTotals, 'active7d'>

export class AdminOverviewRepository implements OverviewStore {
  async userTotals(weekAgo: Date): Promise<UserTotals> {
    const [rows, active7d] = await Promise.all([
      prisma.$queryRaw<UserRow[]>`
        SELECT
          (SELECT count(*)::int FROM users) AS total,
          (SELECT count(*)::int FROM users WHERE created_at >= ${weekAgo}) AS "new7d",
          (SELECT count(*)::int FROM users WHERE email_verified_at IS NOT NULL) AS verified,
          (SELECT count(*)::int FROM users
            WHERE has_password = false
              AND (google_id IS NOT NULL OR discord_id IS NOT NULL)) AS "oauthOnly",
          (SELECT count(DISTINCT user_id)::int FROM platform_accounts) AS "linkedStore",
          (SELECT count(DISTINCT user_id)::int FROM user_games) AS "withGames",
          (SELECT count(DISTINCT user_id)::int FROM user_games
            WHERE completed_at IS NOT NULL) AS "finishedGame"`,
      prisma.user.count({
        where: { refreshToken: { some: { createdAt: { gte: weekAgo } } } }
      })
    ])
    return { ...rows[0], active7d }
  }

  gamesTotal() {
    return prisma.userGame.count()
  }

  async signupsByDay(since: Date): Promise<SignupDay[]> {
    const rows = await prisma.$queryRaw<{ day: string; count: number }[]>`
      SELECT (created_at - interval '3 hours')::date::text AS day, count(*)::int AS count
      FROM users
      WHERE created_at >= ${since}
      GROUP BY 1`
    return rows.map(row => ({ date: row.day, count: row.count }))
  }

  async catalogCounts(): Promise<CatalogCounts> {
    const rows = await prisma.$queryRaw<CatalogCounts[]>`
      SELECT
        count(*)::int AS total,
        (count(*) FILTER (WHERE cover_url IS NULL))::int AS "noCover",
        (count(*) FILTER (
          WHERE coalesce(array_length(game_modes, 1), 0) = 0
            AND game_modes_checked_at IS NULL))::int AS "modesUnchecked",
        (count(*) FILTER (WHERE slug IS NULL))::int AS "noSlug"
      FROM games_cache`
    return rows[0]
  }
}
