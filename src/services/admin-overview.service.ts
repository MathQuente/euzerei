import type {
  OverviewStore,
  SignupDay
} from '../repositories/admin-overview.repository'
import { withReadLimit } from '../utils/admin-read-limit'
import { daysAgo, startOfBrasiliaDay } from '../utils/brasilia-time'
import { createTtlCache } from '../utils/ttl-cache'

export const METRICS_TTL_MS = 60_000
export const SIGNUP_DAYS = 30
const UNAVAILABLE = 'Não foi possível ler a visão geral agora.'
const DAY_MS = 24 * 60 * 60 * 1000
const BRASILIA_OFFSET_MS = 3 * 60 * 60 * 1000

export function lastDays(now: Date, days: number): string[] {
  const today = startOfBrasiliaDay(now).getTime()
  return Array.from({ length: days }, (_, index) => {
    const dayStart = today - (days - 1 - index) * DAY_MS
    return new Date(dayStart - BRASILIA_OFFSET_MS).toISOString().slice(0, 10)
  })
}

export function fillDays(
  now: Date,
  days: number,
  rows: SignupDay[]
): SignupDay[] {
  const byDay = new Map(rows.map(row => [row.date, row.count]))
  return lastDays(now, days).map(date => ({
    date,
    count: byDay.get(date) ?? 0
  }))
}

export interface CatalogSource {
  overviewCatalog(now: Date): Promise<{
    generatedAt: string
    total: number
    noCover: number
    modesUnchecked: number
    noSlug: number
  }>
}

export class AdminOverviewService {
  private metricsCache = createTtlCache(METRICS_TTL_MS)

  constructor(
    private store: OverviewStore,
    private catalogSource: CatalogSource
  ) {}

  metrics(now: Date = new Date()) {
    return this.metricsCache('metrics', () =>
      withReadLimit(() => this.buildMetrics(now), UNAVAILABLE)
    )
  }

  private async buildMetrics(now: Date) {
    const weekAgo = daysAgo(now, 7)
    const since = new Date(
      startOfBrasiliaDay(now).getTime() - (SIGNUP_DAYS - 1) * DAY_MS
    )
    const [totals, games, signups] = await Promise.allSettled([
      this.store.userTotals(weekAgo),
      this.store.gamesTotal(),
      this.store.signupsByDay(since)
    ])

    const users = totals.status === 'fulfilled' ? totals.value : null

    return {
      generatedAt: now.toISOString(),
      users: users && {
        total: users.total,
        new7d: users.new7d,
        active7d: users.active7d,
        verified: users.verified,
        oauthOnly: users.oauthOnly
      },
      games: games.status === 'fulfilled' ? { total: games.value } : null,
      funnel: users && {
        created: users.total,
        verified: users.verified,
        linkedStore: users.linkedStore,
        withGames: users.withGames,
        finishedGame: users.finishedGame
      },
      signups:
        signups.status === 'fulfilled'
          ? { days: fillDays(now, SIGNUP_DAYS, signups.value) }
          : null
    }
  }

  catalog(now: Date = new Date()) {
    return this.catalogSource.overviewCatalog(now)
  }
}
