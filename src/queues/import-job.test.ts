import { describe, it, expect, vi } from 'vitest'
import type { Queue } from 'bullmq'
import { UnrecoverableError } from 'bullmq'
import { ImportLimiter } from './import-limit'
import { ClientError } from '../errors/client-error'
import { TimeoutError } from '../utils/with-timeout'
import {
  getImportJobStatus,
  enqueueUniqueImport,
  IMPORT_JOB_OPTIONS,
  toImportJobError
} from './import-job'

const NOW = Date.parse('2026-11-27T12:00:00Z')
const HOUR = 60 * 60 * 1000

function queueWith(job: unknown) {
  return {
    getJob: vi.fn().mockResolvedValue(job),
    add: vi.fn().mockResolvedValue(undefined)
  } as unknown as Queue
}

function limiterWith(limit: number, finishes: number[]) {
  const runs = {
    completedFinishesSince: vi.fn(
      async (_u: string, _s: string, since: Date, take: number) =>
        finishes
          .filter(t => t > since.getTime())
          .sort((a, b) => b - a)
          .slice(0, take)
          .map(t => new Date(t))
    )
  }
  const limiter = new ImportLimiter({ get: async () => limit } as never, runs)
  return { limiter, runs }
}

const scope = (limiter: ImportLimiter) => ({
  userId: 'u1',
  store: 'steam' as const,
  limiter
})

const idle = () => scope(limiterWith(5, []).limiter)
const job = (state: string, extra: object = {}) =>
  queueWith({ getState: vi.fn().mockResolvedValue(state), ...extra })

describe('getImportJobStatus', () => {
  it('reports idle when there is no job', async () => {
    expect(
      await getImportJobStatus(queueWith(undefined), 'job-1', idle(), NOW)
    ).toEqual({ status: 'idle' })
  })

  it('returns the result without a cooldown while the limit is not reached', async () => {
    const finishedOn = NOW - 10 * 60 * 1000
    const result = { library: { imported: 3 } }
    const { limiter } = limiterWith(5, [finishedOn])

    expect(
      await getImportJobStatus(
        job('completed', { returnvalue: result, finishedOn }),
        'job-1',
        scope(limiter),
        NOW
      )
    ).toEqual({
      status: 'completed',
      result,
      finishedAt: finishedOn,
      cooldownUntil: undefined
    })
  })

  it('returns the cooldown once the limit is reached: when the Nth most recent run leaves the window', async () => {
    const finishes = [NOW - 5 * 60_000, NOW - 20 * 60_000, NOW - 50 * 60_000]
    const { limiter } = limiterWith(2, finishes)

    const status = await getImportJobStatus(
      job('completed', { returnvalue: {}, finishedOn: finishes[0] }),
      'job-1',
      scope(limiter),
      NOW
    )

    // limite 2 com 3 execuções: a 2ª mais recente (20 min atrás) decide, não a mais antiga.
    expect(status).toHaveProperty('cooldownUntil', finishes[1] + HOUR)
  })

  it('does not query the database for a job that has not completed', async () => {
    const { limiter, runs } = limiterWith(1, [NOW])

    await getImportJobStatus(
      job('active', { progress: 42 }),
      'job-1',
      scope(limiter),
      NOW
    )
    await getImportJobStatus(
      job('failed', { failedReason: 'x' }),
      'job-1',
      scope(limiter),
      NOW
    )

    expect(runs.completedFinishesSince).not.toHaveBeenCalled()
  })

  it('still answers, without cooldown, when the count fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const limiter = new ImportLimiter({ get: async () => 5 } as never, {
      completedFinishesSince: vi.fn().mockRejectedValue(new Error('db down'))
    })

    const status = await getImportJobStatus(
      job('completed', { returnvalue: {}, finishedOn: NOW }),
      'job-1',
      scope(limiter),
      NOW
    )

    expect(status).toMatchObject({ status: 'completed' })
    expect(status).toHaveProperty('cooldownUntil', undefined)
    warn.mockRestore()
  })

  it('returns the reason of a failed job', async () => {
    expect(
      await getImportJobStatus(
        job('failed', { failedReason: 'Steam did not answer' }),
        'job-1',
        idle(),
        NOW
      )
    ).toEqual({ status: 'failed', error: 'Steam did not answer' })
  })

  it('returns the progress of a running job', async () => {
    expect(
      await getImportJobStatus(
        job('active', { progress: 42 }),
        'job-1',
        idle(),
        NOW
      )
    ).toEqual({ status: 'active', progress: 42 })
  })
})

describe('enqueueUniqueImport', () => {
  it('queues when the runs in the last hour are below the limit', async () => {
    const queue = queueWith(undefined)
    const { limiter, runs } = limiterWith(3, [
      NOW - 10 * 60_000,
      NOW - 30 * 60_000
    ])

    await expect(
      enqueueUniqueImport(
        queue,
        'j',
        { userId: 'u1' },
        'Steam',
        scope(limiter),
        NOW
      )
    ).resolves.toEqual({ status: 'queued' })

    expect(queue.add).toHaveBeenCalledOnce()
    expect(runs.completedFinishesSince).toHaveBeenCalledWith(
      'u1',
      'steam',
      new Date(NOW - HOUR),
      3
    )
  })

  it('answers 429 with the minutes left when the limit is reached', async () => {
    const queue = queueWith(undefined)
    const { limiter } = limiterWith(2, [NOW - 10 * 60_000, NOW - 40 * 60_000])

    await expect(
      enqueueUniqueImport(
        queue,
        'j',
        { userId: 'u1' },
        'Steam',
        scope(limiter),
        NOW
      )
    ).rejects.toMatchObject({
      statusCode: 429,
      message: 'Você pode importar novamente em 20 minuto(s).'
    })
    expect(queue.add).not.toHaveBeenCalled()
  })

  it('a run that left the window no longer counts', async () => {
    const queue = queueWith(undefined)
    const { limiter } = limiterWith(1, [NOW - HOUR - 1000])

    await expect(
      enqueueUniqueImport(
        queue,
        'j',
        { userId: 'u1' },
        'Steam',
        scope(limiter),
        NOW
      )
    ).resolves.toEqual({ status: 'queued' })
  })

  it('lowering the limit below the runs in the window blocks until the Nth leaves it', async () => {
    const finishes = [NOW - 5 * 60_000, NOW - 25 * 60_000, NOW - 45 * 60_000]
    const { limiter } = limiterWith(1, finishes)

    await expect(
      enqueueUniqueImport(
        queueWith(undefined),
        'j',
        { userId: 'u1' },
        'Steam',
        scope(limiter),
        NOW
      )
    ).rejects.toMatchObject({
      statusCode: 429,
      message: 'Você pode importar novamente em 55 minuto(s).'
    })
  })

  it('keeps answering 409 for a job in progress, before the limit', async () => {
    const { limiter, runs } = limiterWith(1, [NOW])

    await expect(
      enqueueUniqueImport(
        job('active'),
        'j',
        { userId: 'u1' },
        'Xbox',
        scope(limiter),
        NOW
      )
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Já existe uma importação da Xbox em andamento.'
    })
    expect(runs.completedFinishesSince).not.toHaveBeenCalled()
  })

  it('removes the finished job and queues a new one when allowed', async () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    const queue = queueWith({
      getState: vi.fn().mockResolvedValue('completed'),
      remove
    })

    await enqueueUniqueImport(
      queue,
      'j',
      { userId: 'u1' },
      'Steam',
      idle(),
      NOW
    )

    expect(remove).toHaveBeenCalledOnce()
    expect(queue.add).toHaveBeenCalledOnce()
  })

  it('lets a database error surface and queues nothing', async () => {
    const queue = queueWith(undefined)
    const limiter = new ImportLimiter({ get: async () => 5 } as never, {
      completedFinishesSince: vi.fn().mockRejectedValue(new Error('db down'))
    })

    await expect(
      enqueueUniqueImport(
        queue,
        'j',
        { userId: 'u1' },
        'Steam',
        scope(limiter),
        NOW
      )
    ).rejects.toThrow('db down')
    expect(queue.add).not.toHaveBeenCalled()
  })
})

describe('toImportJobError', () => {
  it('keeps the message of a ClientError and stops the retries', () => {
    const error = toImportJobError(
      new ClientError('Perfil privado.'),
      'generic'
    )

    expect(error).toBeInstanceOf(UnrecoverableError)
    expect(error.message).toBe('Perfil privado.')
  })

  it('does not retry a timeout, because the import may still be running', () => {
    const error = toImportJobError(new TimeoutError('timed out'), 'generic')

    expect(error).toBeInstanceOf(UnrecoverableError)
    expect(error.message).toBe('generic')
  })

  it('lets any other failure be retried with the generic message', () => {
    const error = toImportJobError(new Error('socket hang up'), 'generic')

    expect(error).not.toBeInstanceOf(UnrecoverableError)
    expect(error.message).toBe('generic')
  })

  it('retries once after a pause', () => {
    expect(IMPORT_JOB_OPTIONS.attempts).toBe(2)
    expect(IMPORT_JOB_OPTIONS.backoff.delay).toBeGreaterThan(0)
  })
})
