import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  AdminImportsService,
  QUEUE_READ_TIMEOUT_MS
} from './admin-imports.service'
import type { ImportQueueRepository } from '../repositories/import-queue.repository'
import type { ImportJobRecord, ImportStore } from '../utils/import-jobs'

function job(overrides: Partial<ImportJobRecord>): ImportJobRecord {
  return {
    id: 'steam-import-u1',
    store: 'steam',
    userId: 'u1',
    state: 'completed',
    timestamp: 1_000,
    processedOn: 2_000,
    finishedOn: 5_000,
    attemptsMade: 1,
    maxAttempts: 2,
    failedReason: null,
    returnValue: { library: { imported: 3, notFound: ['a'] } },
    progress: null,
    ...overrides
  }
}

function setup(jobs: ImportJobRecord[], handles = new Map([['u1', 'ada']])) {
  const counts = (store: ImportStore) => {
    const own = jobs.filter(j => j.store === store)
    const n = (state: string) => own.filter(j => j.state === state).length
    return {
      waiting: n('waiting'),
      active: n('active'),
      delayed: n('delayed'),
      completed: n('completed'),
      failed: n('failed')
    }
  }
  const repo = {
    counts: vi.fn(async (store: ImportStore) => counts(store)),
    newest: vi.fn(async (store: ImportStore, state: string, limit: number) =>
      jobs
        .filter(j => j.store === store && j.state === state)
        .sort((a, b) => (b.finishedOn ?? 0) - (a.finishedOn ?? 0))
        .slice(0, limit)
    ),
    finishedSince: vi.fn(
      async (store: ImportStore, state: string, since: number) =>
        jobs.filter(
          j =>
            j.store === store &&
            j.state === state &&
            (j.finishedOn ?? 0) >= since
        ).length
    ),
    workers: vi.fn(async () => 1)
  }
  const lookup = { findHandles: vi.fn(async () => handles) }
  const service = new AdminImportsService(
    repo as unknown as ImportQueueRepository,
    lookup
  )
  return { service, repo, lookup }
}

describe('AdminImportsService.list', () => {
  it('merges the queues newest first and maps the status and the handle', async () => {
    const { service } = setup([
      job({ id: 'a', finishedOn: 5_000 }),
      job({
        id: 'b',
        store: 'xbox',
        state: 'failed',
        failedReason: 'Perfil privado',
        finishedOn: 9_000,
        returnValue: null
      }),
      job({
        id: 'c',
        store: 'psn',
        state: 'active',
        finishedOn: null,
        processedOn: 7_000,
        progress: 40,
        returnValue: null
      })
    ])
    const page = await service.list({ page: 1 })

    expect(page.total).toBe(3)
    expect(page.items.map(i => i.id)).toEqual(['b', 'c', 'a'])
    expect(page.items[0]).toMatchObject({
      status: 'failed',
      reason: 'Perfil privado',
      handle: 'ada'
    })
    expect(page.items[1]).toMatchObject({ status: 'running', progress: 40 })
    expect(page.items[2]).toMatchObject({
      status: 'done',
      games: 4,
      notFound: 1
    })
  })

  it('filters by status and store, and counts only what matches', async () => {
    const { service, repo } = setup([
      job({ id: 'a' }),
      job({ id: 'b', store: 'xbox', state: 'failed', returnValue: null }),
      job({ id: 'c', store: 'psn', state: 'failed', returnValue: null })
    ])
    const page = await service.list({
      page: 1,
      status: 'failed',
      store: 'xbox'
    })

    expect(page.total).toBe(1)
    expect(page.items.map(i => i.id)).toEqual(['b'])
    expect(repo.newest).not.toHaveBeenCalledWith(
      'steam',
      expect.anything(),
      expect.anything()
    )
  })

  it('paginates by 20 and only reads page*20 jobs from each state', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      job({ id: `j${i}`, finishedOn: 10_000 - i, userId: null })
    )
    const { service, repo } = setup(many)

    const second = await service.list({ page: 2 })
    expect(second.items).toHaveLength(10)
    expect(second.total).toBe(30)
    expect(repo.newest).toHaveBeenCalledWith('steam', 'completed', 30)

    const first = await service.list({ page: 1 })
    expect(first.items).toHaveLength(20)
    expect(repo.newest).toHaveBeenCalledWith('steam', 'completed', 20)
  })

  it('does not read states that are empty and skips the handle lookup with no users', async () => {
    const { service, repo, lookup } = setup([])
    const page = await service.list({ page: 1 })

    expect(page).toMatchObject({ items: [], total: 0 })
    expect(repo.newest).not.toHaveBeenCalled()
    expect(lookup.findHandles).toHaveBeenCalledWith([])
  })

  it('a user that no longer exists comes back with a null handle', async () => {
    const { service } = setup([job({ userId: 'gone' })])
    const page = await service.list({ page: 1 })
    expect(page.items[0]?.handle).toBeNull()
  })

  it('does not leak the user id, only the handle', async () => {
    const { service } = setup([job({})])
    const page = await service.list({ page: 1 })
    expect(JSON.stringify(page)).not.toContain('"userId"')
  })
})

describe('AdminImportsService.summary', () => {
  const now = new Date('2026-11-20T15:00:00-03:00')
  const today = new Date('2026-11-20T10:00:00-03:00').getTime()
  const yesterday = new Date('2026-11-19T10:00:00-03:00').getTime()

  it('counts queued, running, finished today and failed today', async () => {
    const { service } = setup([
      job({ id: 'a', finishedOn: today, processedOn: today - 4_000 }),
      job({ id: 'b', finishedOn: yesterday, processedOn: yesterday - 2_000 }),
      job({
        id: 'c',
        store: 'xbox',
        state: 'failed',
        finishedOn: today,
        returnValue: null
      }),
      job({
        id: 'd',
        store: 'psn',
        state: 'waiting',
        finishedOn: null,
        processedOn: null,
        returnValue: null
      }),
      job({
        id: 'e',
        store: 'psn',
        state: 'active',
        finishedOn: null,
        returnValue: null
      })
    ])
    const summary = await service.summary(now)

    expect(summary).toMatchObject({
      queued: 1,
      running: 1,
      finishedToday: 2,
      failedToday: 1,
      failedNow: 1,
      completedKept: 2
    })
  })

  it('averages the duration of the completed jobs and says how many it used', async () => {
    const { service } = setup([
      job({ id: 'a', processedOn: 0, finishedOn: 4_000 }),
      job({ id: 'b', processedOn: 0, finishedOn: 8_000 })
    ])
    const summary = await service.summary(now)

    expect(summary.avgDurationMs.overall).toBe(6_000)
    expect(summary.avgDurationMs.steam).toBe(6_000)
    expect(summary.avgDurationMs.xbox).toBeNull()
    expect(summary.durationSample).toBe(2)
  })

  it('no completed job means no average, not zero', async () => {
    const { service } = setup([])
    const summary = await service.summary(now)
    expect(summary.avgDurationMs.overall).toBeNull()
    expect(summary).toMatchObject({ queued: 0, running: 0, failedToday: 0 })
  })

  it('the three panel blocks share one read inside the cache window', async () => {
    const { service, repo } = setup([])
    await service.summary(now)
    await service.summary(now)
    expect(repo.finishedSince).toHaveBeenCalledTimes(6)
  })
})

describe('AdminImportsService.failures', () => {
  it('groups the failed jobs by reason, most frequent first', async () => {
    const { service } = setup([
      job({
        id: 'a',
        state: 'failed',
        failedReason: 'Perfil privado',
        returnValue: null
      }),
      job({
        id: 'b',
        store: 'xbox',
        state: 'failed',
        failedReason: 'Perfil privado',
        returnValue: null
      }),
      job({
        id: 'c',
        store: 'psn',
        state: 'failed',
        failedReason: 'Token expirado',
        returnValue: null
      }),
      job({
        id: 'd',
        store: 'psn',
        state: 'failed',
        failedReason: null,
        returnValue: null
      })
    ])
    const failures = await service.failures()

    expect(failures.total).toBe(4)
    expect(failures.reasons[0]).toMatchObject({
      reason: 'Perfil privado',
      count: 2
    })
    expect(failures.reasons[0]?.stores.sort()).toEqual(['steam', 'xbox'])
    expect(failures.reasons.map(r => r.reason)).toContain(
      'Motivo não registrado'
    )
  })

  it('no failures is an empty list', async () => {
    const { service } = setup([job({})])
    expect(await service.failures()).toEqual({
      total: 0,
      sampled: 0,
      reasons: []
    })
  })
})

describe('when Redis does not answer', () => {
  afterEach(() => vi.useRealTimers())

  it('every read gives up after the limit with a 503 instead of hanging', async () => {
    vi.useFakeTimers()
    const hang = () => new Promise<never>(() => {})
    const repo = {
      counts: hang,
      newest: hang,
      finishedSince: hang,
      workers: hang
    }
    const service = new AdminImportsService(
      repo as unknown as ImportQueueRepository,
      { findHandles: async () => new Map() }
    )

    for (const read of [
      () => service.list({ page: 1 }),
      () => service.summary(),
      () => service.failures(),
      () => service.queues()
    ]) {
      const outcome = expect(read()).rejects.toMatchObject({ statusCode: 503 })
      await vi.advanceTimersByTimeAsync(QUEUE_READ_TIMEOUT_MS)
      await outcome
    }
  })

  it('a timeout is not cached: the next call tries again', async () => {
    vi.useFakeTimers()
    let calls = 0
    const counts = () => {
      calls += 1
      return calls === 1
        ? new Promise<never>(() => {})
        : Promise.resolve({
            waiting: 0,
            active: 0,
            delayed: 0,
            completed: 0,
            failed: 0
          })
    }
    const repo = { counts, newest: async () => [], workers: async () => 1 }
    const service = new AdminImportsService(
      repo as unknown as ImportQueueRepository,
      { findHandles: async () => new Map() }
    )

    const first = expect(service.queues()).rejects.toMatchObject({
      statusCode: 503
    })
    await vi.advanceTimersByTimeAsync(QUEUE_READ_TIMEOUT_MS)
    await first
    await expect(service.queues()).resolves.toHaveProperty('queues')
  })
})

describe('AdminImportsService.queues', () => {
  it('returns each queue with its counts and workers', async () => {
    const { service } = setup([
      job({}),
      job({ id: 'x', store: 'psn', state: 'failed', returnValue: null })
    ])
    const { queues } = await service.queues()

    expect(queues.map(q => q.store)).toEqual(['steam', 'xbox', 'psn'])
    expect(queues[0]).toMatchObject({ completed: 1, failed: 0, workers: 1 })
    expect(queues[2]).toMatchObject({ failed: 1 })
  })
})
