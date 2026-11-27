import { describe, it, expect, vi, afterEach } from 'vitest'
import { AccountSuspendedError } from '../errors/account-suspended-error'
import { ClientError } from '../errors/client-error'
import { hashToken } from '../utils/hash-token'
import { LoginAttemptRecorder, outcomeOfError } from './login-attempt-recorder'

const flush = () => new Promise(resolve => setImmediate(resolve))

describe('outcomeOfError', () => {
  it('maps what the server decided about the password', () => {
    expect(outcomeOfError(new ClientError('x', 429))).toBe('LOCKED')
    expect(outcomeOfError(new ClientError('x'))).toBe('BAD_CREDENTIALS')
    expect(outcomeOfError(new ClientError('x', 401))).toBe('BAD_CREDENTIALS')
    expect(outcomeOfError(new AccountSuspendedError())).toBe('SUSPENDED')
  })

  it('ignores infrastructure failures', () => {
    expect(outcomeOfError(new Error('ECONNREFUSED'))).toBeNull()
    expect(outcomeOfError(new ClientError('x', 503))).toBeNull()
  })
})

describe('LoginAttemptRecorder', () => {
  afterEach(() => vi.restoreAllMocks())

  it('stores only hashes, with the e-mail normalized like the Redis keys', async () => {
    const create = vi.fn(async () => undefined)
    const recorder = new LoginAttemptRecorder({ create })

    await recorder.record('APP', '  Kenzo@Example.COM ', '9.9.9.9', 'SUCCESS')

    expect(create).toHaveBeenCalledWith({
      emailHash: hashToken('kenzo@example.com'),
      ipHash: hashToken('9.9.9.9'),
      source: 'APP',
      outcome: 'SUCCESS'
    })
    expect(JSON.stringify(create.mock.calls)).not.toContain('kenzo')
    expect(JSON.stringify(create.mock.calls)).not.toContain('9.9.9.9')
  })

  it('never rejects: a database failure only logs a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const recorder = new LoginAttemptRecorder({
      create: vi.fn(async () => {
        throw new Error('connection terminated')
      })
    })

    await expect(
      recorder.record('APP', 'a@b.c', '1.1.1.1', 'LOCKED')
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('track: returns the result and records SUCCESS without waiting for the database', async () => {
    let release!: () => void
    const create = vi.fn(
      () => new Promise<void>(resolve => (release = resolve))
    )
    const recorder = new LoginAttemptRecorder({ create })

    const result = await recorder.track(
      'PANEL',
      'a@b.c',
      '1.1.1.1',
      async () => ({
        ok: true
      })
    )

    expect(result).toEqual({ ok: true })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'PANEL', outcome: 'SUCCESS' })
    )
    release()
  })

  it('track: rethrows the same error and records the outcome', async () => {
    const create = vi.fn(async () => undefined)
    const recorder = new LoginAttemptRecorder({ create })
    const error = new ClientError('Muitas tentativas', 429)

    await expect(
      recorder.track('APP', 'a@b.c', '1.1.1.1', async () => {
        throw error
      })
    ).rejects.toBe(error)
    await flush()

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'LOCKED' })
    )
  })

  it('track: an infrastructure error is rethrown and not recorded', async () => {
    const create = vi.fn(async () => undefined)
    const recorder = new LoginAttemptRecorder({ create })

    await expect(
      recorder.track('APP', 'a@b.c', '1.1.1.1', async () => {
        throw new Error('redis down')
      })
    ).rejects.toThrow('redis down')
    await flush()

    expect(create).not.toHaveBeenCalled()
  })
})
