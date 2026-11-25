import { EventEmitter } from 'node:events'
import { UnrecoverableError, type Job, type Worker } from 'bullmq'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { attachRunRecorder } from './import-run-recorder'
import type {
  ImportRunInput,
  ImportRunsRepository
} from '../repositories/import-runs.repository'

const repository = { create: vi.fn() }

function setup() {
  const worker = new EventEmitter() as unknown as Worker
  attachRunRecorder(
    worker,
    'steam',
    repository as unknown as ImportRunsRepository
  )
  return worker as unknown as EventEmitter
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'steam-import:user-1',
    data: { userId: 'user-1' },
    attemptsMade: 1,
    timestamp: 1_000,
    processedOn: 2_000,
    finishedOn: 5_000,
    returnvalue: {
      library: { imported: 3, updated: 1, skipped: 0, notFound: ['x'] }
    },
    getState: vi.fn().mockResolvedValue('failed'),
    ...overrides
  } as unknown as Job
}

const flush = () => new Promise(resolve => setImmediate(resolve))

beforeEach(() => {
  repository.create.mockReset().mockResolvedValue(undefined)
})

describe('import run recorder', () => {
  it('records a completed job with the games read, the attempts and the same duration the screen shows', async () => {
    setup().emit('completed', job({ attemptsMade: 2 }))
    await flush()

    const saved = repository.create.mock.calls[0][0] as ImportRunInput
    expect(saved).toMatchObject({
      store: 'steam',
      userId: 'user-1',
      status: 'DONE',
      attempts: 2,
      games: 5,
      error: null,
      startedAt: new Date(2_000),
      finishedAt: new Date(5_000)
    })
    // O id do job termina com o UUID do usuário: só o ref hash vai para a tabela.
    expect(saved.ref).toMatch(/^steam-import:[0-9a-f]{4}$/)
    expect(JSON.stringify(saved)).not.toContain('steam-import:user-1')
  })

  it('records WARNING when the job finished but an account failed', async () => {
    const withWarning = job({
      returnvalue: {
        library: { imported: 1, updated: 0, skipped: 0, notFound: [] },
        accounts: [{ displayName: 'a', error: 'Perfil privado' }]
      }
    })
    setup().emit('completed', withWarning)
    await flush()

    expect(repository.create.mock.calls[0][0]).toMatchObject({
      status: 'WARNING',
      error: 'Perfil privado'
    })
  })

  it('does not record a failure that will be retried', async () => {
    const retrying = job({ getState: vi.fn().mockResolvedValue('delayed') })
    setup().emit('failed', retrying, new Error('instável'))
    await flush()

    expect(repository.create).not.toHaveBeenCalled()
  })

  it('records the failure that has no retry left, with the message and no game count', async () => {
    setup().emit(
      'failed',
      job({ attemptsMade: 2 }),
      new Error('Erro ao importar')
    )
    await flush()

    expect(repository.create.mock.calls[0][0]).toMatchObject({
      status: 'FAILED',
      attempts: 2,
      games: null,
      error: 'Erro ao importar'
    })
  })

  it('records an UnrecoverableError at once, even with attempts left', async () => {
    const early = job({
      attemptsMade: 1,
      getState: vi.fn().mockResolvedValue('delayed')
    })
    setup().emit('failed', early, new UnrecoverableError('Perfil privado'))
    await flush()

    expect(repository.create).toHaveBeenCalledTimes(1)
    expect(repository.create.mock.calls[0][0]).toMatchObject({
      status: 'FAILED',
      error: 'Perfil privado'
    })
  })

  it('ignores a failed event without a job', async () => {
    setup().emit('failed', undefined, new Error('x'))
    await flush()

    expect(repository.create).not.toHaveBeenCalled()
  })

  it('never lets a database failure escape: the import is not affected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    repository.create.mockRejectedValue(new Error('db down'))
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    const worker = setup()
    worker.emit('completed', job())
    worker.emit('failed', job(), new Error('x'))
    await flush()
    await flush()
    process.off('unhandledRejection', unhandled)

    expect(unhandled).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a job whose state cannot be read is not recorded and does not throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = job({
      getState: vi.fn().mockRejectedValue(new Error('redis'))
    })

    setup().emit('failed', broken, new Error('x'))
    await flush()

    expect(repository.create).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
