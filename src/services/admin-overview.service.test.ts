import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  AdminOverviewService,
  SIGNUP_DAYS,
  fillDays,
  lastDays
} from './admin-overview.service'
import { READ_TIMEOUT_MS } from '../utils/admin-read-limit'
import type { OverviewStore } from '../repositories/admin-overview.repository'

const now = new Date('2026-11-21T15:00:00.000Z')

function setup(overrides: Partial<OverviewStore> = {}) {
  const store: OverviewStore = {
    userTotals: vi.fn(async () => ({
      total: 1284,
      new7d: 37,
      verified: 1168,
      oauthOnly: 123,
      linkedStore: 745,
      withGames: 800,
      finishedGame: 565,
      active7d: 412
    })),
    gamesTotal: vi.fn(async () => 48_920),
    signupsByDay: vi.fn(async () => [
      { date: '2026-11-21', count: 14 },
      { date: '2026-11-01', count: 3 }
    ]),
    catalogCounts: vi.fn(async () => ({
      total: 299_505,
      noCover: 5,
      modesUnchecked: 0,
      noSlug: 0
    })),
    ...overrides
  }
  return { service: new AdminOverviewService(store), store }
}

describe('lastDays', () => {
  it('lists the last N Brasília days, oldest first, ending today', () => {
    const days = lastDays(now, 3)

    expect(days).toEqual(['2026-11-19', '2026-11-20', '2026-11-21'])
  })

  it('00:00 to 03:00 UTC still belongs to the day before in Brasília', () => {
    const early = new Date('2026-11-21T01:30:00.000Z')

    expect(lastDays(early, 2)).toEqual(['2026-11-19', '2026-11-20'])
  })

  it('has exactly the number of days asked', () => {
    expect(lastDays(now, SIGNUP_DAYS)).toHaveLength(SIGNUP_DAYS)
  })
})

describe('fillDays', () => {
  it('puts zero on the days with no signup', () => {
    const days = fillDays(now, 3, [{ date: '2026-11-20', count: 4 }])

    expect(days).toEqual([
      { date: '2026-11-19', count: 0 },
      { date: '2026-11-20', count: 4 },
      { date: '2026-11-21', count: 0 }
    ])
  })

  it('ignores rows older than the window', () => {
    const days = fillDays(now, 2, [{ date: '2026-01-01', count: 99 }])

    expect(days.map(day => day.count)).toEqual([0, 0])
  })
})

describe('AdminOverviewService.metrics', () => {
  afterEach(() => vi.useRealTimers())

  it('answers users, games, funnel and 30 filled signup days', async () => {
    const { service } = setup()

    const metrics = await service.metrics(now)

    expect(metrics.generatedAt).toBe(now.toISOString())
    expect(metrics.users).toEqual({
      total: 1284,
      new7d: 37,
      active7d: 412,
      verified: 1168,
      oauthOnly: 123
    })
    expect(metrics.games).toEqual({ total: 48_920 })
    expect(metrics.funnel).toEqual({
      created: 1284,
      verified: 1168,
      linkedStore: 745,
      withGames: 800,
      finishedGame: 565
    })
    expect(metrics.signups?.days).toHaveLength(SIGNUP_DAYS)
    expect(metrics.signups?.days.at(-1)).toEqual({
      date: '2026-11-21',
      count: 14
    })
  })

  it('the funnel steps are independent counts, not nested', async () => {
    const { service } = setup()

    const { funnel } = await service.metrics(now)

    expect(funnel!.withGames).toBeGreaterThan(funnel!.linkedStore)
  })

  it('asks for the last 7 days and for 30 Brasília days of signups', async () => {
    const { service, store } = setup()
    await service.metrics(now)

    expect(store.userTotals).toHaveBeenCalledWith(
      new Date('2026-11-14T15:00:00.000Z')
    )
    expect(store.signupsByDay).toHaveBeenCalledWith(
      new Date('2026-10-23T03:00:00.000Z')
    )
  })

  it('a part that fails is null and the others still answer', async () => {
    const { service } = setup({
      gamesTotal: vi.fn(async () => {
        throw new Error('relation "user_games" does not exist')
      }),
      signupsByDay: vi.fn(async () => {
        throw new Error('boom')
      })
    })

    const metrics = await service.metrics(now)

    expect(metrics.games).toBeNull()
    expect(metrics.signups).toBeNull()
    expect(metrics.users).toMatchObject({ total: 1284 })
    expect(metrics.funnel).toMatchObject({ created: 1284 })
    expect(JSON.stringify(metrics)).not.toContain('user_games')
  })

  it('users and funnel fail together because they share one read', async () => {
    const { service } = setup({
      userTotals: vi.fn(async () => {
        throw new Error('boom')
      })
    })

    const metrics = await service.metrics(now)

    expect(metrics.users).toBeNull()
    expect(metrics.funnel).toBeNull()
    expect(metrics.games).toEqual({ total: 48_920 })
  })

  it('shares one read inside the cache window', async () => {
    const { service, store } = setup()
    await service.metrics(now)
    await service.metrics(now)

    expect(store.userTotals).toHaveBeenCalledTimes(1)
  })

  it('gives up after the limit with a 503 instead of hanging', async () => {
    vi.useFakeTimers()
    const { service } = setup({
      userTotals: () => new Promise<never>(() => {}),
      gamesTotal: () => new Promise<never>(() => {}),
      signupsByDay: () => new Promise<never>(() => {})
    })

    const outcome = expect(service.metrics(now)).rejects.toMatchObject({
      statusCode: 503
    })
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS)
    await outcome
  })
})

describe('AdminOverviewService.catalog', () => {
  afterEach(() => vi.useRealTimers())

  it('answers the counts', async () => {
    const { service } = setup()

    expect(await service.catalog(now)).toEqual({
      generatedAt: now.toISOString(),
      total: 299_505,
      noCover: 5,
      modesUnchecked: 0,
      noSlug: 0
    })
  })

  it('caches inside the window', async () => {
    const { service, store } = setup()
    await service.catalog(now)
    await service.catalog(now)

    expect(store.catalogCounts).toHaveBeenCalledTimes(1)
  })

  it('a failure is not cached: the next call tries again', async () => {
    let calls = 0
    const { service } = setup({
      catalogCounts: vi.fn(async () => {
        calls += 1
        if (calls === 1) throw new Error('boom')
        return { total: 1, noCover: 0, modesUnchecked: 0, noSlug: 0 }
      })
    })

    await expect(service.catalog(now)).rejects.toThrow('boom')
    await expect(service.catalog(now)).resolves.toMatchObject({ total: 1 })
  })
})
