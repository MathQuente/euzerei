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
    failedCount: vi.fn(async (store: ImportStore) => counts(store).failed),
    workers: vi.fn(async () => 1),
    isPaused: vi.fn<(store: ImportStore) => Promise<boolean>>(async () => false)
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

describe('AdminImportsService.list with a limit', () => {
  const many = Array.from({ length: 9 }, (_, n) =>
    job({
      id: `steam-import-u${n}`,
      userId: `u${n}`,
      finishedOn: 10_000 + n
    })
  )

  it('returns only the newest N and says the page size is N', async () => {
    const { service, repo } = setup(many)

    const result = await service.list({ page: 1, limit: 6 })

    expect(result.items).toHaveLength(6)
    expect(result.pageSize).toBe(6)
    expect(result.total).toBe(9)
    expect(repo.newest).toHaveBeenCalledWith('steam', 'completed', 6)
  })

  it('page 2 continues after the first N', async () => {
    const { service } = setup(many)

    const result = await service.list({ page: 2, limit: 6 })

    expect(result.items).toHaveLength(3)
    expect(result.page).toBe(2)
  })

  it('without a limit nothing changes: page size 20', async () => {
    const { service } = setup(many)

    const result = await service.list({ page: 1 })

    expect(result.pageSize).toBe(20)
    expect(result.items).toHaveLength(9)
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
      failedCount: hang,
      newest: hang,
      finishedSince: hang,
      workers: hang,
      isPaused: hang
    }
    const service = new AdminImportsService(
      repo as unknown as ImportQueueRepository,
      { findHandles: async () => new Map() }
    )

    for (const read of [
      () => service.list({ page: 1 }),
      () => service.summary(),
      () => service.failures(),
      () => service.queues(),
      () => service.failedJobs(undefined)
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
    const repo = {
      counts,
      newest: async () => [],
      workers: async () => 1,
      isPaused: async () => false,
      finishedSince: async () => 0
    }
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
  const now = new Date('2026-11-21T15:00:00.000Z')

  it('returns each queue with its counts, state, workers and the last 24 hours', async () => {
    const { service, repo } = setup([
      job({}),
      job({ id: 'x', store: 'psn', state: 'failed', returnValue: null })
    ])
    const { queues, generatedAt } = await service.queues(now)

    expect(generatedAt).toBe(now.toISOString())
    expect(queues.map(q => q.store)).toEqual(['steam', 'xbox', 'psn'])
    expect(queues[0]).toMatchObject({
      completed: 1,
      failed: 0,
      workers: 1,
      paused: false,
      error: null
    })
    expect(queues[2]).toMatchObject({ failed: 1 })
    expect(repo.finishedSince).toHaveBeenCalledWith(
      'steam',
      'completed',
      now.getTime() - 24 * 60 * 60 * 1000
    )
  })

  it('counts only what finished inside the rolling 24 hours', async () => {
    const day = 24 * 60 * 60 * 1000
    const { service } = setup([
      job({ id: 'new', finishedOn: now.getTime() - 1_000 }),
      job({ id: 'old', finishedOn: now.getTime() - day - 1_000 })
    ])
    const { queues } = await service.queues(now)

    expect(queues[0]).toMatchObject({ completed: 2, completed24h: 1 })
  })

  it('reports a paused queue', async () => {
    const { service, repo } = setup([])
    repo.isPaused.mockImplementation(async store => store === 'xbox')

    const { queues } = await service.queues(now)

    expect(queues.map(q => q.paused)).toEqual([false, true, false])
  })

  it('an empty queue is zeros, not an error', async () => {
    const { service } = setup([])
    const { queues } = await service.queues(now)

    expect(queues[1]).toMatchObject({
      waiting: 0,
      active: 0,
      failed: 0,
      completed24h: 0,
      error: null
    })
  })

  it('a queue that fails alone becomes a row with an error and the others still answer', async () => {
    const { service, repo } = setup([job({})])
    const original = repo.counts.getMockImplementation()!
    repo.counts.mockImplementation(async store => {
      if (store === 'xbox') throw new Error('WRONGTYPE secret detail')
      return original(store)
    })

    const { queues } = await service.queues(now)

    expect(queues[0]).toMatchObject({ completed: 1, error: null })
    expect(queues[1]).toMatchObject({
      store: 'xbox',
      waiting: null,
      failed: null,
      workers: null,
      error: 'Não foi possível ler esta fila.'
    })
    expect(JSON.stringify(queues)).not.toContain('WRONGTYPE')
    expect(queues[2]).toMatchObject({ error: null })
  })

  it('shares one read inside the cache window', async () => {
    const { service, repo } = setup([])
    await service.queues(now)
    await service.queues(now)

    expect(repo.isPaused).toHaveBeenCalledTimes(3)
  })
})

describe('AdminImportsService.failedJobs', () => {
  const now = new Date('2026-11-21T15:00:00.000Z')
  const failed = (id: string, overrides: Partial<ImportJobRecord> = {}) =>
    job({
      id,
      state: 'failed',
      failedReason: 'Perfil privado',
      returnValue: { library: { imported: 1 } },
      ...overrides
    })

  it('lists the newest failures with a short ref, the handle and the reason', async () => {
    const { service } = setup([
      failed('steam-import-u1', { finishedOn: 5_000 }),
      failed('psn-import-u1', { store: 'psn', finishedOn: 9_000 })
    ])
    const result = await service.failedJobs(undefined, now)

    expect(result.total).toBe(2)
    expect(result.unavailable).toEqual([])
    expect(result.items.map(i => i.store)).toEqual(['psn', 'steam'])
    expect(result.items[0]).toEqual({
      ref: expect.stringMatching(/^psn-import:[0-9a-f]{4}$/),
      store: 'psn',
      handle: 'ada',
      reason: 'Perfil privado',
      attempts: { made: 1, max: 2 },
      failedAt: new Date(9_000).toISOString()
    })
  })

  it('never carries the job id, the user id, the job data or the return value', async () => {
    const { service } = setup([
      failed('steam-import-u1', { returnValue: { token: 'tok-secret' } })
    ])
    const text = JSON.stringify(await service.failedJobs(undefined, now))

    expect(text).not.toContain('steam-import-u1')
    expect(text).not.toContain('"u1"')
    expect(text).not.toContain('tok-secret')
  })

  it('keeps the 10 newest of the failures Redis holds and says how many there are', async () => {
    const jobs = Array.from({ length: 14 }, (_, n) =>
      failed(`steam-import-u${n}`, { userId: `u${n}`, finishedOn: 1_000 + n })
    )
    const { service, repo } = setup(jobs)
    const result = await service.failedJobs('steam', now)

    expect(result.total).toBe(14)
    expect(result.items).toHaveLength(10)
    expect(result.items[0]?.failedAt).toBe(new Date(1_013).toISOString())
    expect(repo.newest).toHaveBeenCalledWith('steam', 'failed', 10)
    expect(repo.failedCount).toHaveBeenCalledTimes(1)
    expect(repo.counts).not.toHaveBeenCalled()
  })

  it('a deleted account has no handle', async () => {
    const { service } = setup([failed('steam-import-u9', { userId: 'u9' })])
    const result = await service.failedJobs(undefined, now)

    expect(result.items[0]?.handle).toBeNull()
  })

  it('cuts a long reason and treats a blank one as no reason', async () => {
    const { service } = setup([
      failed('steam-import-u1', { failedReason: 'x'.repeat(500) }),
      failed('xbox-import-u1', { store: 'xbox', failedReason: '  ' })
    ])
    const result = await service.failedJobs(undefined, now)
    const reasons = result.items.map(i => i.reason)

    expect(reasons).toContain(null)
    expect(reasons.find(r => r !== null)?.length).toBe(160)
  })

  it('no failure is an empty list and no handle lookup is needed', async () => {
    const { service, lookup } = setup([job({})])
    const result = await service.failedJobs(undefined, now)

    expect(result).toMatchObject({ total: 0, items: [], unavailable: [] })
    expect(lookup.findHandles).toHaveBeenCalledWith([])
  })

  it('a queue that fails alone is listed as unavailable and the others answer', async () => {
    const { service, repo } = setup([failed('steam-import-u1')])
    const original = repo.failedCount.getMockImplementation()!
    repo.failedCount.mockImplementation(async store => {
      if (store === 'psn') throw new Error('boom')
      return original(store)
    })

    const result = await service.failedJobs(undefined, now)

    expect(result.unavailable).toEqual(['psn'])
    expect(result.items).toHaveLength(1)
  })
})
