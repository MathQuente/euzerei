import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  AdminImportsService,
  QUEUE_READ_TIMEOUT_MS
} from './admin-imports.service'
import type { AuditEntryInput } from '../repositories/audit.repository'
import { failedJobId } from '../utils/admin-job-ref'
import {
  JobChangedError,
  type ImportQueueRepository
} from '../repositories/import-queue.repository'
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
      id: expect.stringMatching(/^[0-9a-f]{16}$/),
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

describe('AdminImportsService.setQueuePaused', () => {
  const actor = { actorId: 'admin-1', ip: '10.0.0.5' }
  const build = (paused = false) => {
    const repo = {
      isPaused: vi.fn(async () => paused),
      setPaused: vi.fn(async () => undefined),
      counts: vi.fn(async () => ({
        waiting: 0,
        active: 0,
        delayed: 0,
        completed: 0,
        failed: 0
      })),
      workers: vi.fn(async () => 1),
      finishedSince: vi.fn(async () => 0)
    }
    const audit = { record: vi.fn(async () => undefined) }
    const service = new AdminImportsService(
      repo as unknown as ImportQueueRepository,
      { findHandles: async () => new Map() },
      audit
    )
    return { service, repo, audit }
  }

  it('pausa uma fila rodando e audita na área IMPORTS', async () => {
    const { service, repo, audit } = build(false)

    expect(await service.setQueuePaused('steam', true, actor)).toEqual({
      store: 'steam',
      paused: true,
      changed: true
    })
    expect(repo.setPaused).toHaveBeenCalledWith('steam', true)
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'admin-1',
      action: 'Pausou a fila de importação',
      area: 'IMPORTS',
      target: 'steam-import',
      detail: 'jobs ativos terminam e novas importações ficam esperando',
      ip: '10.0.0.5'
    })
  })

  it('retoma uma fila pausada', async () => {
    const { service, repo, audit } = build(true)

    expect(await service.setQueuePaused('psn', false, actor)).toMatchObject({
      paused: false,
      changed: true
    })
    expect(repo.setPaused).toHaveBeenCalledWith('psn', false)
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'Retomou a fila de importação',
        target: 'psn-import',
        detail: null
      })
    )
  })

  it('duplo clique: pedir o estado em que a fila já está não muda nem audita', async () => {
    const { service, repo, audit } = build(true)

    expect(await service.setQueuePaused('xbox', true, actor)).toEqual({
      store: 'xbox',
      paused: true,
      changed: false
    })
    expect(repo.setPaused).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('depois de pausar, a lista de filas não vem do cache', async () => {
    const { service, repo } = build(false)
    await service.queues()
    await service.queues()
    expect(repo.counts).toHaveBeenCalledTimes(3)

    await service.setQueuePaused('steam', true, actor)
    await service.queues()

    expect(repo.counts).toHaveBeenCalledTimes(6)
  })

  it('Redis fora na leitura: o erro sobe e nada é pausado', async () => {
    const { service, repo } = build(false)
    repo.isPaused.mockRejectedValue(new Error('redis fora'))

    await expect(service.setQueuePaused('steam', true, actor)).rejects.toThrow(
      'redis fora'
    )
    expect(repo.setPaused).not.toHaveBeenCalled()
  })
})

describe('AdminImportsService: repetir e descartar job falho', () => {
  const actor = { actorId: 'admin-1', ip: '10.0.0.5' }
  const failedRecord = job({
    id: 'psn-import-u1',
    store: 'psn',
    state: 'failed',
    userId: 'u1',
    timestamp: 1_000
  })
  const PUBLIC_ID = failedJobId('psn', 'psn-import-u1', 1_000)

  const build = (
    overrides: {
      located?: { record: ImportJobRecord | null; truncated: boolean }
      state?: string
    } = {}
  ) => {
    const order: string[] = []
    const repo = {
      locateFailed: vi.fn(
        async () =>
          overrides.located ?? { record: failedRecord, truncated: false }
      ),
      stateOf: vi.fn(async () => overrides.state ?? 'failed'),
      retryFailed: vi.fn(async () => {
        order.push('retry')
      }),
      removeJob: vi.fn(async () => {
        order.push('remove')
      }),
      counts: vi.fn(async () => ({
        waiting: 0,
        active: 0,
        delayed: 0,
        completed: 0,
        failed: 0
      })),
      isPaused: vi.fn(async () => false),
      workers: vi.fn(async () => 1),
      finishedSince: vi.fn(async () => 0)
    }
    const audit = {
      record: vi.fn<(entry: AuditEntryInput) => Promise<void>>(async () => {
        order.push('audit')
      })
    }
    const strictAudit = {
      create: vi.fn<(entry: AuditEntryInput) => Promise<{ id: string }>>(
        async () => {
          order.push('audit-strict')
          return { id: 'audit-1' }
        }
      ),
      markFailed: vi.fn(async () => ({}))
    }
    const service = new AdminImportsService(
      repo as unknown as ImportQueueRepository,
      { findHandles: async () => new Map([['u1', 'kenzo']]) },
      audit,
      strictAudit as never
    )
    return { service, repo, audit, strictAudit, order }
  }

  describe('retryFailedJob', () => {
    it('repete o job e audita com a referência e o @handle, nunca o jobId inteiro', async () => {
      const { service, repo, audit } = build()

      expect(await service.retryFailedJob('psn', PUBLIC_ID, actor)).toEqual({
        retried: true
      })
      expect(repo.retryFailed).toHaveBeenCalledWith(
        'psn',
        'psn-import-u1',
        1_000
      )
      const entry = audit.record.mock.calls[0][0]
      expect(entry).toMatchObject({
        action: 'Repetiu um job de importação',
        area: 'IMPORTS',
        ip: '10.0.0.5'
      })
      expect(entry.target).toMatch(/^psn-import:[0-9a-f]{4} · @kenzo$/)
      expect(JSON.stringify(entry)).not.toContain('psn-import-u1')
    })

    it('id que não acha nenhum job: 404 e nada acontece', async () => {
      const { service, repo, audit } = build({
        located: { record: null, truncated: false }
      })

      await expect(
        service.retryFailedJob('psn', PUBLIC_ID, actor)
      ).rejects.toMatchObject({ statusCode: 404 })
      expect(repo.retryFailed).not.toHaveBeenCalled()
      expect(audit.record).not.toHaveBeenCalled()
    })

    it('varredura parcial que não acha o id: 503, não "não existe mais"', async () => {
      const { service, repo } = build({
        located: { record: null, truncated: true }
      })

      await expect(
        service.retryFailedJob('psn', PUBLIC_ID, actor)
      ).rejects.toMatchObject({ statusCode: 503 })
      expect(repo.retryFailed).not.toHaveBeenCalled()
    })

    it('o job já não está falho (o usuário reimportou): 409 e não mexe no job novo', async () => {
      const { service, repo } = build({ state: 'waiting' })

      await expect(
        service.retryFailedJob('psn', PUBLIC_ID, actor)
      ).rejects.toMatchObject({
        statusCode: 409,
        message: 'O job mudou. Atualize a lista.'
      })
      expect(repo.retryFailed).not.toHaveBeenCalled()
    })

    it('o job foi reimportado entre a checagem e a ação (mesmo jobId, outro timestamp): 409 e nada é auditado', async () => {
      const { service, repo, audit } = build()
      repo.retryFailed.mockRejectedValue(new JobChangedError())

      await expect(
        service.retryFailedJob('psn', PUBLIC_ID, actor)
      ).rejects.toMatchObject({ statusCode: 409 })
      expect(audit.record).not.toHaveBeenCalled()
    })

    it('o BullMQ recusou porque o job mudou no meio: 409', async () => {
      const { service, repo } = build()
      repo.retryFailed.mockRejectedValue(new Error('not in failed'))
      repo.stateOf
        .mockResolvedValueOnce('failed')
        .mockResolvedValueOnce('active')

      await expect(
        service.retryFailedJob('psn', PUBLIC_ID, actor)
      ).rejects.toMatchObject({ statusCode: 409 })
    })

    it('o BullMQ falhou com o job ainda falho: o erro real sobe e nada é auditado', async () => {
      const { service, repo, audit } = build()
      repo.retryFailed.mockRejectedValue(new Error('redis caiu'))

      await expect(
        service.retryFailedJob('psn', PUBLIC_ID, actor)
      ).rejects.toThrow('redis caiu')
      expect(audit.record).not.toHaveBeenCalled()
    })

    it('depois de repetir, a lista de filas não vem do cache', async () => {
      const { service, repo } = build()
      await service.queues()
      await service.queues()
      expect(repo.counts).toHaveBeenCalledTimes(3)

      await service.retryFailedJob('psn', PUBLIC_ID, actor)
      await service.queues()

      expect(repo.counts).toHaveBeenCalledTimes(6)
    })
  })

  describe('discardFailedJob', () => {
    it('grava a auditoria ANTES de remover', async () => {
      const { service, order, strictAudit } = build()

      expect(await service.discardFailedJob('psn', PUBLIC_ID, actor)).toEqual({
        discarded: true
      })
      expect(order).toEqual(['audit-strict', 'remove'])
      expect(strictAudit.create.mock.calls[0][0]).toMatchObject({
        action: 'Descartou um job de importação',
        area: 'IMPORTS',
        ip: '10.0.0.5'
      })
      expect(strictAudit.markFailed).not.toHaveBeenCalled()
    })

    it('a auditoria falhou: 503 e NADA é removido', async () => {
      const { service, repo, strictAudit } = build()
      strictAudit.create.mockRejectedValue(new Error('db fora'))

      await expect(
        service.discardFailedJob('psn', PUBLIC_ID, actor)
      ).rejects.toMatchObject({
        statusCode: 503,
        message: 'Não foi possível registrar na auditoria. Nada foi descartado.'
      })
      expect(repo.removeJob).not.toHaveBeenCalled()
    })

    it('a remoção falhou: a mesma linha de auditoria vira FAILED e o erro sobe', async () => {
      const { service, repo, strictAudit } = build()
      repo.removeJob.mockRejectedValue(new Error('redis caiu'))

      await expect(
        service.discardFailedJob('psn', PUBLIC_ID, actor)
      ).rejects.toThrow('redis caiu')
      expect(strictAudit.create).toHaveBeenCalledTimes(1)
      expect(strictAudit.markFailed).toHaveBeenCalledWith(
        'audit-1',
        expect.any(String)
      )
    })

    it('a remoção falhou porque o job mudou no meio: 409 e a linha vira FAILED', async () => {
      const { service, repo, strictAudit } = build()
      repo.removeJob.mockRejectedValue(new Error('locked'))
      repo.stateOf
        .mockResolvedValueOnce('failed')
        .mockResolvedValueOnce('waiting')

      await expect(
        service.discardFailedJob('psn', PUBLIC_ID, actor)
      ).rejects.toMatchObject({ statusCode: 409 })
      expect(strictAudit.markFailed).toHaveBeenCalledTimes(1)
    })

    it('reimportado entre a auditoria e a remoção: 409, a linha vira FAILED e o job novo não é tocado', async () => {
      const { service, repo, strictAudit } = build()
      repo.removeJob.mockRejectedValue(new JobChangedError())

      await expect(
        service.discardFailedJob('psn', PUBLIC_ID, actor)
      ).rejects.toMatchObject({ statusCode: 409 })
      expect(repo.removeJob).toHaveBeenCalledWith('psn', 'psn-import-u1', 1_000)
      expect(strictAudit.markFailed).toHaveBeenCalledTimes(1)
    })

    it('id velho (reimportou e falhou de novo, outro timestamp): 404 e nada é gravado', async () => {
      const { service, repo, strictAudit } = build({
        located: { record: null, truncated: false }
      })

      await expect(
        service.discardFailedJob(
          'psn',
          failedJobId('psn', 'psn-import-u1', 999),
          actor
        )
      ).rejects.toMatchObject({ statusCode: 404 })
      expect(strictAudit.create).not.toHaveBeenCalled()
      expect(repo.removeJob).not.toHaveBeenCalled()
    })

    it('job que já não está falho: 409, sem auditoria e sem remover', async () => {
      const { service, repo, strictAudit } = build({ state: 'completed' })

      await expect(
        service.discardFailedJob('psn', PUBLIC_ID, actor)
      ).rejects.toMatchObject({ statusCode: 409 })
      expect(strictAudit.create).not.toHaveBeenCalled()
      expect(repo.removeJob).not.toHaveBeenCalled()
    })
  })

  describe('lista de falhas', () => {
    it('cada item traz o id opaco que muda quando o job é reimportado', async () => {
      const { service, repo } = setup([failedRecord])
      expect(repo).toBeDefined()
      const result = await service.failedJobs(undefined, new Date())
      expect(result.items[0].id).toBe(PUBLIC_ID)
      expect(result.items[0].id).toMatch(/^[0-9a-f]{16}$/)
      expect(JSON.stringify(result)).not.toContain('psn-import-u1')
      expect(failedJobId('psn', 'psn-import-u1', 2_000)).not.toBe(PUBLIC_ID)
    })
  })
})
