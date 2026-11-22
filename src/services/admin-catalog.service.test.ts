import { describe, it, expect, vi, afterEach } from 'vitest'
import { AdminCatalogService } from './admin-catalog.service'
import { READ_TIMEOUT_MS } from '../utils/admin-read-limit'
import type {
  CatalogStore,
  GameDetailRow
} from '../repositories/admin-catalog.repository'

const now = new Date('2026-11-21T15:00:00.000Z')
const synced = new Date('2026-11-19T00:18:31.352Z')

const detail: GameDetailRow = {
  igdbId: 228525,
  name: 'Hades II',
  slug: 'hades-ii',
  coverUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/x.jpg',
  releaseDate: 1_758_758_400,
  releaseDatePrecision: 'day',
  platforms: ['PC (Microsoft Windows)', 'Nintendo Switch'],
  syncedAt: synced,
  hasModes: true,
  modesChecked: true,
  libraries: 94
}

function setup(overrides: Partial<CatalogStore> = {}) {
  const store: CatalogStore = {
    counts: vi.fn(async () => ({
      total: 299_505,
      noCover: 5,
      noPrecision: 1864,
      modesUnchecked: 0,
      noSlug: 0,
      hypesNull: 0,
      updated7d: 75,
      lastSyncedAt: synced
    })),
    added: vi.fn(async () => ({ games: 362, additions: 435 })),
    topAdded: vi.fn(async () => [
      { igdbId: 1, name: 'Warframe', users: 10 },
      { igdbId: 2, name: 'Stardew Valley', users: 10 }
    ]),
    search: vi.fn(async () => []),
    game: vi.fn(async () => detail),
    lastRuns: vi.fn(async () => new Map<string, Date>()),
    ...overrides
  }
  return { service: new AdminCatalogService(store), store }
}

afterEach(() => vi.useRealTimers())

describe('AdminCatalogService.summary', () => {
  it('answers the counts, the last update and the adds of the last 7 days', async () => {
    const { service } = setup()

    expect(await service.summary(now)).toEqual({
      generatedAt: now.toISOString(),
      total: 299_505,
      updated7d: 75,
      noCover: 5,
      noPrecision: 1864,
      lastSyncedAt: synced.toISOString(),
      added7d: { games: 362, additions: 435 }
    })
  })

  it('a table with no row has no last update, not an invented date', async () => {
    const { service } = setup({
      counts: vi.fn(async () => ({
        total: 0,
        noCover: 0,
        noPrecision: 0,
        modesUnchecked: 0,
        noSlug: 0,
        hypesNull: 0,
        updated7d: 0,
        lastSyncedAt: null
      }))
    })

    expect((await service.summary(now)).lastSyncedAt).toBeNull()
  })

  it('the adds failing is null and the counts still answer', async () => {
    const { service } = setup({
      added: vi.fn(async () => {
        throw new Error('relation "user_games" does not exist')
      })
    })

    const summary = await service.summary(now)

    expect(summary.added7d).toBeNull()
    expect(summary.total).toBe(299_505)
    expect(JSON.stringify(summary)).not.toContain('user_games')
  })

  it('asks for the last 7 days', async () => {
    const { service, store } = setup()
    await service.summary(now)

    expect(store.counts).toHaveBeenCalledWith(
      new Date('2026-11-14T15:00:00.000Z')
    )
    expect(store.added).toHaveBeenCalledWith(
      new Date('2026-11-14T15:00:00.000Z')
    )
  })
})

describe('the counts are one read shared by every screen', () => {
  it('summary, jobs and the overview read the table once', async () => {
    const { service, store } = setup()

    await service.summary(now)
    await service.jobs(now)
    await service.overviewCatalog(now)

    expect(store.counts).toHaveBeenCalledTimes(1)
  })

  it('the overview answers the same numbers in its own shape', async () => {
    const { service } = setup()

    expect(await service.overviewCatalog(now)).toEqual({
      generatedAt: now.toISOString(),
      total: 299_505,
      noCover: 5,
      modesUnchecked: 0,
      noSlug: 0
    })
  })

  it('a failed read is not cached: the next call tries again', async () => {
    let calls = 0
    const { service } = setup({
      counts: vi.fn(async () => {
        calls += 1
        if (calls === 1) throw new Error('boom')
        return {
          total: 1,
          noCover: 0,
          noPrecision: 0,
          modesUnchecked: 0,
          noSlug: 0,
          hypesNull: 0,
          updated7d: 0,
          lastSyncedAt: null
        }
      })
    })

    await expect(service.overviewCatalog(now)).rejects.toThrow('boom')
    await expect(service.overviewCatalog(now)).resolves.toMatchObject({
      total: 1
    })
  })

  it('gives up after the limit with a 503 instead of hanging', async () => {
    vi.useFakeTimers()
    const { service } = setup({
      counts: () => new Promise<never>(() => {})
    })

    const outcome = expect(service.summary(now)).rejects.toMatchObject({
      statusCode: 503
    })
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS)
    await outcome
  })
})

describe('AdminCatalogService.jobs', () => {
  it('lists the 7 tasks of the board in order', async () => {
    const { service } = setup()

    const { jobs } = await service.jobs(now)

    expect(jobs.map(job => job.script)).toEqual([
      'backfill:cover-urls',
      'backfill:endless',
      'backfill:game-modes',
      'backfill:release-precision',
      'backfill:slugs',
      'backfill:hypes',
      'sync:popular'
    ])
  })

  it('only counts what can be known without IGDB; the rest is unknown, never a related column', async () => {
    const { service } = setup()

    const { jobs } = await service.jobs(now)
    const byKey = Object.fromEntries(jobs.map(job => [job.key, job]))

    expect(byKey.modes).toMatchObject({ pending: 0, state: 'upToDate' })
    expect(byKey.slugs).toMatchObject({ pending: 0, state: 'upToDate' })
    expect(byKey.hypes).toMatchObject({ pending: 0, state: 'upToDate' })
    for (const key of ['covers', 'endless', 'precision', 'sync']) {
      expect(byKey[key]).toMatchObject({ pending: null, state: 'unknown' })
    }
  })

  it('a task with pending rows is "pending"', async () => {
    const { service } = setup({
      counts: vi.fn(async () => ({
        total: 10,
        noCover: 0,
        noPrecision: 0,
        modesUnchecked: 87,
        noSlug: 0,
        hypesNull: 0,
        updated7d: 0,
        lastSyncedAt: null
      }))
    })

    const { jobs } = await service.jobs(now)

    expect(jobs.find(job => job.key === 'modes')).toMatchObject({
      pending: 87,
      state: 'pending'
    })
  })

  it('the last run comes from the audit log, by the exact action name', async () => {
    const run = new Date('2026-11-20T12:00:00.000Z')
    const { service, store } = setup({
      lastRuns: vi.fn(async () => new Map([['Rodou o backfill de capas', run]]))
    })

    const { jobs } = await service.jobs(now)

    expect(store.lastRuns).toHaveBeenCalledWith([
      'Rodou o backfill de capas',
      'Rodou o backfill de tempo de jogo',
      'Rodou o backfill de modos de jogo',
      'Rodou o backfill da precisão da data de lançamento',
      'Rodou o backfill de slugs',
      'Rodou o backfill de hypes e notas'
    ])
    expect(jobs[0]).toMatchObject({
      lastRunAt: run.toISOString(),
      lastRunSource: 'audit'
    })
  })

  it('with no audit row there is no last run, except the sync, which falls back to the cache', async () => {
    const { service } = setup()

    const { jobs } = await service.jobs(now)

    expect(jobs[0]).toMatchObject({ lastRunAt: null, lastRunSource: null })
    expect(jobs.at(-1)).toMatchObject({
      key: 'sync',
      lastRunAt: synced.toISOString(),
      lastRunSource: 'cache'
    })
  })

  it('the audit failing leaves the runs empty and the counts still answer', async () => {
    const { service } = setup({
      lastRuns: vi.fn(async () => {
        throw new Error('boom')
      })
    })

    const { jobs } = await service.jobs(now)

    expect(jobs[0]?.lastRunAt).toBeNull()
    expect(jobs.find(job => job.key === 'modes')?.pending).toBe(0)
  })
})

describe('AdminCatalogService.search and game', () => {
  it('passes the query and the limit of 8 to the store', async () => {
    const { service, store } = setup()

    await service.search('hades')

    expect(store.search).toHaveBeenCalledWith('hades', 8)
  })

  it('an unknown game is a 404', async () => {
    const { service } = setup({ game: vi.fn(async () => null) })

    await expect(service.game(1)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('the detail carries no user data, only the count of libraries', async () => {
    const { service } = setup()

    const game = await service.game(228525)

    expect(game).toMatchObject({
      name: 'Hades II',
      libraries: 94,
      syncedAt: synced.toISOString()
    })
    expect(Object.keys(game)).not.toContain('userId')
  })
})

describe('AdminCatalogService.topAdded', () => {
  it('lists the games added by the most distinct users, in the store order', async () => {
    const { service, store } = setup()

    const top = await service.topAdded(7, now)

    expect(store.topAdded).toHaveBeenCalledWith(
      new Date('2026-11-14T15:00:00.000Z'),
      5
    )
    expect(top.items.map(item => item.name)).toEqual([
      'Warframe',
      'Stardew Valley'
    ])
    expect(top.days).toBe(7)
  })

  it('caches per number of days', async () => {
    const { service, store } = setup()
    await service.topAdded(7, now)
    await service.topAdded(7, now)
    await service.topAdded(30, now)

    expect(store.topAdded).toHaveBeenCalledTimes(2)
  })
})
