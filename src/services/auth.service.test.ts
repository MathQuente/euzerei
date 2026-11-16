import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import bcrypt from 'bcrypt'
import { JWT } from '@fastify/jwt'
import { AuthService, revokedAccessTokenKey } from './auth.service'
import { AuthRepository } from '../repositories/auth.repository'
import { CacheRepository } from '../repositories/cache.repository'
import { ClientError } from '../errors/client-error'
import { TermsRequiredError } from '../errors/terms-required-error'
import { EmailService } from './email.service'
import { Prisma } from '../database/prisma-client'
import { hashToken } from '../utils/hash-token'
import { ReauthRequiredError } from '../errors/reauth-required-error'

function fakeJwt(overrides: Partial<JWT> = {}): JWT {
  return {
    sign: vi.fn(() => 'signed-token'),
    verify: vi.fn(() => ({ userId: 'user-1' })),
    ...overrides
  } as unknown as JWT
}

function fakeAuthRepository(
  overrides: Partial<AuthRepository> = {}
): AuthRepository {
  return { ...overrides } as unknown as AuthRepository
}

function fakeCache(stored: unknown = null) {
  return {
    get: vi.fn().mockResolvedValue(stored),
    getdel: vi.fn().mockResolvedValue(stored),
    set: vi.fn().mockResolvedValue(undefined),
    setIfAbsent: vi.fn().mockResolvedValue(true),
    increment: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(undefined)
  } as unknown as CacheRepository & {
    get: ReturnType<typeof vi.fn>
    getdel: ReturnType<typeof vi.fn>
    set: ReturnType<typeof vi.fn>
    increment: ReturnType<typeof vi.fn>
    del: ReturnType<typeof vi.fn>
  }
}

const fakeCacheRepository = fakeCache()

describe('AuthService.validateUser', () => {
  it('throws ClientError when the user does not exist', async () => {
    const authRepository = fakeAuthRepository({
      findByEmail: vi.fn().mockResolvedValue(null)
    })
    const service = new AuthService(
      authRepository,
      fakeJwt(),
      fakeCacheRepository
    )

    await expect(
      service.validateUser('a@a.com', 'wrong', '1.1.1.1')
    ).rejects.toThrow(ClientError)
  })

  it('throws ClientError when the password does not match', async () => {
    const hashed = await bcrypt.hash('correct-password', 10)
    const authRepository = fakeAuthRepository({
      findByEmail: vi
        .fn()
        .mockResolvedValue({ id: '1', userName: 'x', password: hashed })
    })
    const service = new AuthService(
      authRepository,
      fakeJwt(),
      fakeCacheRepository
    )

    await expect(
      service.validateUser('a@a.com', 'wrong-password', '1.1.1.1')
    ).rejects.toThrow(ClientError)
  })

  it('returns the user when the password matches', async () => {
    const hashed = await bcrypt.hash('correct-password', 10)
    const authRepository = fakeAuthRepository({
      findByEmail: vi
        .fn()
        .mockResolvedValue({ id: '1', userName: 'someone', password: hashed })
    })
    const service = new AuthService(
      authRepository,
      fakeJwt(),
      fakeCacheRepository
    )

    const result = await service.validateUser(
      'a@a.com',
      'correct-password',
      '1.1.1.1'
    )

    expect(result).toEqual({ user: { id: '1', userName: 'someone' } })
  })
})

describe('AuthService.logout', () => {
  const future = () => Math.floor(Date.now() / 1000) + 600

  it('revokes the access token for the time it still has left', async () => {
    const cache = fakeCache()
    const service = new AuthService(
      fakeAuthRepository({ invalidateToken: vi.fn() }),
      fakeJwt({ verify: vi.fn(() => ({ exp: future() })) }),
      cache
    )

    await service.logout('refresh', 'access')

    expect(cache.set).toHaveBeenCalledWith(
      revokedAccessTokenKey('access'),
      true,
      expect.any(Number)
    )
  })

  it('does nothing about the access token when it is invalid or expired', async () => {
    const cache = fakeCache()
    const invalid = new AuthService(
      fakeAuthRepository({ invalidateToken: vi.fn() }),
      fakeJwt({
        verify: vi.fn(() => {
          throw new Error('invalid token')
        })
      }),
      cache
    )
    const expired = new AuthService(
      fakeAuthRepository({ invalidateToken: vi.fn() }),
      fakeJwt({ verify: vi.fn(() => ({ exp: 1 })) }),
      cache
    )

    await expect(invalid.logout('refresh', 'access')).resolves.toBeUndefined()
    await expect(expired.logout('refresh', 'access')).resolves.toBeUndefined()
    expect(cache.set).not.toHaveBeenCalled()
  })

  it('logs the failure, and still finishes, when Redis cannot store the revocation', async () => {
    const cache = fakeCache()
    cache.set.mockRejectedValue(new Error('redis down'))
    const invalidateToken = vi.fn()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const service = new AuthService(
      fakeAuthRepository({ invalidateToken }),
      fakeJwt({ verify: vi.fn(() => ({ exp: future() })) }),
      cache
    )

    await expect(service.logout('refresh', 'access')).resolves.toBeUndefined()

    expect(invalidateToken).toHaveBeenCalledWith('refresh')
    expect(logged).toHaveBeenCalledWith(
      '[Auth] access token revocation failed at logout',
      { error: 'redis down' }
    )
    logged.mockRestore()
  })
})

describe('AuthService.validateRefreshToken', () => {
  it('rejects a token already invalidated by logout', async () => {
    const authRepository = fakeAuthRepository({
      findToken: vi.fn().mockResolvedValue({
        isValid: false,
        expiresAt: new Date(Date.now() + 60_000)
      })
    })
    const service = new AuthService(
      authRepository,
      fakeJwt(),
      fakeCacheRepository
    )

    await expect(service.validateRefreshToken('some-token')).rejects.toThrow(
      ClientError
    )
  })

  it('rejects an expired token', async () => {
    const authRepository = fakeAuthRepository({
      findToken: vi.fn().mockResolvedValue({
        isValid: true,
        expiresAt: new Date(Date.now() - 1000)
      })
    })
    const service = new AuthService(
      authRepository,
      fakeJwt(),
      fakeCacheRepository
    )

    await expect(service.validateRefreshToken('some-token')).rejects.toThrow(
      ClientError
    )
  })

  it('does not turn a database failure into an invalid session', async () => {
    const databaseDown = new Error('Can not reach database server')
    const authRepository = fakeAuthRepository({
      findToken: vi.fn().mockRejectedValue(databaseDown)
    })
    const service = new AuthService(
      authRepository,
      fakeJwt(),
      fakeCacheRepository
    )

    const error = await service.validateRefreshToken('some-token').catch(e => e)

    expect(error).toBe(databaseDown)
    expect(error).not.toBeInstanceOf(ClientError)
  })

  it('still reports a bad signature as an invalid session', async () => {
    const authRepository = fakeAuthRepository({
      findToken: vi.fn().mockResolvedValue({
        isValid: true,
        expiresAt: new Date(Date.now() + 60_000)
      })
    })
    const service = new AuthService(
      authRepository,
      fakeJwt({
        verify: vi.fn(() => {
          throw Object.assign(new Error('bad signature'), {
            code: 'FAST_JWT_INVALID_SIGNATURE'
          })
        })
      }),
      fakeCacheRepository
    )

    await expect(service.validateRefreshToken('some-token')).rejects.toThrow(
      ClientError
    )
  })

  it('returns the userId without touching the stored token', async () => {
    const invalidateToken = vi.fn()
    const authRepository = fakeAuthRepository({
      findToken: vi.fn().mockResolvedValue({
        isValid: true,
        expiresAt: new Date(Date.now() + 60_000)
      }),
      invalidateToken
    })
    const service = new AuthService(
      authRepository,
      fakeJwt({ verify: vi.fn(() => ({ userId: 'user-1' })) }),
      fakeCacheRepository
    )

    const userId = await service.validateRefreshToken('some-token')

    expect(userId).toBe('user-1')
    expect(invalidateToken).not.toHaveBeenCalled()
  })
})

describe('AuthService.refreshTokens', () => {
  function setup(rotateToken: AuthRepository['rotateToken']) {
    const authRepository = fakeAuthRepository({
      findToken: vi.fn().mockResolvedValue({
        isValid: true,
        expiresAt: new Date(Date.now() + 60_000)
      }),
      rotateToken,
      saveToken: vi.fn()
    })
    const service = new AuthService(
      authRepository,
      fakeJwt({ verify: vi.fn(() => ({ userId: 'user-1' })) }),
      fakeCacheRepository
    )
    return { service, authRepository }
  }

  it('rotates the old token for the new one in a single repository call', async () => {
    const rotateToken = vi.fn().mockResolvedValue(undefined)
    const { service, authRepository } = setup(rotateToken)

    const tokens = await service.refreshTokens('old-token')

    expect(rotateToken).toHaveBeenCalledWith(
      'old-token',
      tokens.refreshToken,
      'user-1',
      tokens.expiresAt
    )
    expect(authRepository.saveToken).not.toHaveBeenCalled()
  })

  it('lets a lost race through as a client error', async () => {
    const lost = new ClientError('Sessão inválida ou expirada.', 401)
    const { service } = setup(vi.fn().mockRejectedValue(lost))

    await expect(service.refreshTokens('old-token')).rejects.toBe(lost)
  })

  it('does not turn a failure while rotating into an invalid session', async () => {
    const databaseDown = new Error('Connection closed')
    const { service } = setup(vi.fn().mockRejectedValue(databaseDown))

    const error = await service.refreshTokens('old-token').catch(e => e)

    expect(error).toBe(databaseDown)
    expect(error).not.toBeInstanceOf(ClientError)
  })
})

describe('AuthService.isRefreshTokenActive', () => {
  it('returns null without rotating an invalidated token', async () => {
    const invalidateToken = vi.fn()
    const authRepository = fakeAuthRepository({
      findToken: vi.fn().mockResolvedValue({
        isValid: false,
        expiresAt: new Date(Date.now() + 60_000)
      }),
      invalidateToken
    })
    const service = new AuthService(
      authRepository,
      fakeJwt(),
      fakeCacheRepository
    )

    const userId = await service.isRefreshTokenActive('some-token')

    expect(userId).toBeNull()
    expect(invalidateToken).not.toHaveBeenCalled()
  })

  it('returns the userId without rotating a valid token', async () => {
    const invalidateToken = vi.fn()
    const authRepository = fakeAuthRepository({
      findToken: vi.fn().mockResolvedValue({
        isValid: true,
        expiresAt: new Date(Date.now() + 60_000)
      }),
      invalidateToken
    })
    const service = new AuthService(
      authRepository,
      fakeJwt({ verify: vi.fn(() => ({ userId: 'user-1' })) }),
      fakeCacheRepository
    )

    const userId = await service.isRefreshTokenActive('some-token')

    expect(userId).toBe('user-1')
    expect(invalidateToken).not.toHaveBeenCalled()
  })
})

describe('AuthService.createUser', () => {
  it('throws ClientError when the email is already used', async () => {
    const authRepository = fakeAuthRepository({
      findByEmail: vi.fn().mockResolvedValue({ id: 'existing' })
    })
    const service = new AuthService(
      authRepository,
      fakeJwt(),
      fakeCacheRepository
    )

    await expect(
      service.createUser({ email: 'a@a.com', password: 'senha123' })
    ).rejects.toThrow(ClientError)
  })
})

const recordingCache = fakeCache

describe('AuthService.loginWithGoogle', () => {
  const profile = {
    sub: 'google-1',
    email: 'victim@a.com',
    name: 'Victim',
    picture: 'https://example.com/p.png'
  }

  it('rejects an unverified email instead of linking or creating', async () => {
    const findByEmail = vi.fn()
    const authRepository = fakeAuthRepository({
      findUserByGoogleId: vi.fn().mockResolvedValue(null),
      findByEmail
    })
    const service = new AuthService(authRepository, fakeJwt(), recordingCache())

    await expect(
      service.loginWithGoogle({ ...profile, email_verified: false }, true)
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(findByEmail).not.toHaveBeenCalled()
  })

  it('hands the discarded password to the link write and revokes the sessions after it', async () => {
    const linkGoogle = vi.fn().mockResolvedValue({ id: 'user-1' })
    const cache = recordingCache()
    const authRepository = fakeAuthRepository({
      findUserByGoogleId: vi.fn().mockResolvedValue(null),
      findByEmail: vi
        .fn()
        .mockResolvedValue({ id: 'user-1', googleId: null, discordId: null }),
      linkGoogle,
      saveToken: vi.fn()
    })
    const service = new AuthService(authRepository, fakeJwt(), cache)

    await service.loginWithGoogle({ ...profile, email_verified: true }, true)

    expect(linkGoogle).toHaveBeenCalledWith(
      'user-1',
      'google-1',
      profile.picture,
      expect.any(String)
    )
    expect(cache.set).toHaveBeenCalledWith(
      'sessions-revoked-at:user-1',
      expect.any(Number),
      expect.any(Number)
    )
  })

  it('marks the sessions revoked before and again after the link transaction', async () => {
    const cache = fakeCache()
    const linkGoogle = vi
      .fn()
      .mockResolvedValue({ id: 'user-1', email: 'a@b.c' })
    const authRepository = fakeAuthRepository({
      findUserByGoogleId: vi.fn().mockResolvedValue(null),
      findByEmail: vi
        .fn()
        .mockResolvedValue({ id: 'user-1', googleId: null, discordId: null }),
      linkGoogle,
      saveToken: vi.fn()
    })
    const service = new AuthService(authRepository, fakeJwt(), cache)

    await service.loginWithGoogle({ ...profile, email_verified: true }, true)

    const markers = cache.set.mock.invocationCallOrder.filter((_order, index) =>
      String(cache.set.mock.calls[index][0]).startsWith('sessions-revoked-at')
    )
    const link = linkGoogle.mock.invocationCallOrder[0]
    expect(markers).toHaveLength(2)
    expect(markers[0]).toBeLessThan(link)
    expect(markers[1]).toBeGreaterThan(link)
  })

  it('still links when the marker written after the transaction fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const cache = fakeCache()
    cache.set
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('redis down'))
    const authRepository = fakeAuthRepository({
      findUserByGoogleId: vi.fn().mockResolvedValue(null),
      findByEmail: vi
        .fn()
        .mockResolvedValue({ id: 'user-1', googleId: null, discordId: null }),
      linkGoogle: vi.fn().mockResolvedValue({ id: 'user-1', email: 'a@b.c' }),
      saveToken: vi.fn()
    })
    const service = new AuthService(authRepository, fakeJwt(), cache)

    await expect(
      service.loginWithGoogle({ ...profile, email_verified: true }, true)
    ).resolves.toBeDefined()
  })

  it('logs in by googleId without checking the email again', async () => {
    const updatePassword = vi.fn()
    const authRepository = fakeAuthRepository({
      findUserByGoogleId: vi.fn().mockResolvedValue({ id: 'user-1' }),
      updatePassword,
      saveToken: vi.fn()
    })
    const service = new AuthService(authRepository, fakeJwt(), recordingCache())

    const result = await service.loginWithGoogle(
      {
        ...profile,
        email_verified: false
      },
      true
    )

    expect(result.user).toEqual({ id: 'user-1' })
    expect(updatePassword).not.toHaveBeenCalled()
  })
})

describe('AuthService.loginWithDiscord', () => {
  it('rejects an unverified email instead of linking or creating', async () => {
    const findByEmail = vi.fn()
    const authRepository = fakeAuthRepository({
      findByDiscordId: vi.fn().mockResolvedValue(null),
      findByEmail
    })
    const service = new AuthService(authRepository, fakeJwt(), recordingCache())

    await expect(
      service.loginWithDiscord(
        {
          id: 'discord-1',
          email: 'victim@a.com',
          verified: false,
          username: 'x',
          avatar: null
        },
        true
      )
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(findByEmail).not.toHaveBeenCalled()
  })
})

describe('AuthService.resetPassword', () => {
  it('revokes every session of the user after changing the password', async () => {
    const deleteTokensByUserId = vi.fn()
    const cache = recordingCache('user-1')
    const markEmailVerified = vi.fn()
    const authRepository = fakeAuthRepository({
      updatePassword: vi.fn().mockResolvedValue({ email: 'a@a.com' }),
      markEmailVerified,
      deleteTokensByUserId
    })
    const service = new AuthService(authRepository, fakeJwt(), cache)

    await service.resetPassword('reset-token', 'new-password', '1.1.1.1')

    expect(markEmailVerified).toHaveBeenCalledWith('user-1')
    expect(deleteTokensByUserId).toHaveBeenCalledWith('user-1')
    expect(cache.set).toHaveBeenCalledWith(
      'sessions-revoked-at:user-1',
      expect.any(Number),
      expect.any(Number)
    )
  })
})

describe('AuthService.requestPasswordReset', () => {
  it('does not fail when the email cannot be delivered', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const cache = recordingCache()
    const authRepository = fakeAuthRepository({
      findByEmail: vi.fn().mockResolvedValue({ id: 'user-1', email: 'a@a.com' })
    })
    const emailService = {
      sendPasswordResetEmail: vi.fn().mockRejectedValue(new Error('no api key'))
    } as unknown as EmailService
    const service = new AuthService(
      authRepository,
      fakeJwt(),
      cache,
      emailService
    )

    await expect(
      service.requestPasswordReset('a@a.com')
    ).resolves.toBeUndefined()
    await new Promise(resolve => setImmediate(resolve))
    expect(console.error).toHaveBeenCalledWith(
      '[PasswordReset] email delivery failed',
      { error: 'no api key' }
    )
    expect(cache.set).toHaveBeenCalledWith(
      expect.stringMatching(/^password-reset:/),
      { userId: 'user-1', at: expect.any(Number) },
      expect.any(Number)
    )
    vi.restoreAllMocks()
  })
})

describe('AuthService.validateUser throttling', () => {
  it('counts a failed login against the email', async () => {
    const cache = fakeCache()
    const service = new AuthService(
      fakeAuthRepository({ findByEmail: vi.fn().mockResolvedValue(null) }),
      fakeJwt(),
      cache
    )

    await expect(
      service.validateUser('A@a.com', 'wrong', '1.1.1.1')
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(cache.increment).toHaveBeenCalledWith(
      expect.stringMatching(/^login-failures:[0-9a-f]{64}$/),
      expect.any(Number)
    )
  })

  it('blocks the email after too many failures without checking the password', async () => {
    const findByEmail = vi.fn()
    const service = new AuthService(
      fakeAuthRepository({ findByEmail }),
      fakeJwt(),
      fakeCache(10)
    )

    await expect(
      service.validateUser('a@a.com', 'correct-password', '1.1.1.1')
    ).rejects.toMatchObject({ statusCode: 429 })
    expect(findByEmail).not.toHaveBeenCalled()
  })

  it('clears the failure count and marks a recent login on success', async () => {
    const hashed = await bcrypt.hash('correct-password', 4)
    const cache = fakeCache()
    const service = new AuthService(
      fakeAuthRepository({
        findByEmail: vi
          .fn()
          .mockResolvedValue({ id: '1', userName: 'x', password: hashed })
      }),
      fakeJwt(),
      cache
    )

    await service.validateUser('a@a.com', 'correct-password', '1.1.1.1')

    expect(cache.del).toHaveBeenCalledWith(
      expect.stringMatching(/^login-failures:/)
    )
    expect(cache.set).toHaveBeenCalledWith(
      'recent-auth:1',
      true,
      expect.any(Number)
    )
  })
})

describe('AuthService.requestPasswordReset timing', () => {
  it('answers without waiting for the email to be sent', async () => {
    let finishSending: () => void = () => {}
    const emailService = {
      sendPasswordResetEmail: vi.fn(
        () => new Promise<void>(resolve => (finishSending = resolve))
      )
    } as unknown as EmailService
    const service = new AuthService(
      fakeAuthRepository({
        findByEmail: vi
          .fn()
          .mockResolvedValue({ id: 'user-1', email: 'a@a.com' })
      }),
      fakeJwt(),
      fakeCache(),
      emailService
    )

    await expect(
      service.requestPasswordReset('a@a.com')
    ).resolves.toBeUndefined()

    expect(emailService.sendPasswordResetEmail).toHaveBeenCalledTimes(1)
    finishSending()
  })
})

describe('AuthService password reset tokens', () => {
  it('stores the reset token as a hash, never in clear', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const cache = fakeCache()
    let sentUrl = ''
    const emailService = {
      sendPasswordResetEmail: vi.fn(async (_to: string, url: string) => {
        sentUrl = url
      })
    } as unknown as EmailService
    const service = new AuthService(
      fakeAuthRepository({
        findByEmail: vi
          .fn()
          .mockResolvedValue({ id: 'user-1', email: 'a@a.com' })
      }),
      fakeJwt(),
      cache,
      emailService
    )

    await service.requestPasswordReset('a@a.com')

    const token = new URL(sentUrl).searchParams.get('token') as string
    const resetCall = cache.set.mock.calls.find(([key]) =>
      String(key).startsWith('password-reset:')
    )
    expect(resetCall?.[0]).toMatch(/^password-reset:[0-9a-f]{64}$/)
    expect(resetCall?.[0]).not.toContain(token)
    vi.restoreAllMocks()
  })

  it('stops sending after too many requests for the same email', async () => {
    const cache = fakeCache()
    cache.increment.mockResolvedValue(4)
    const emailService = {
      sendPasswordResetEmail: vi.fn()
    } as unknown as EmailService
    const service = new AuthService(
      fakeAuthRepository({
        findByEmail: vi
          .fn()
          .mockResolvedValue({ id: 'user-1', email: 'a@a.com' })
      }),
      fakeJwt(),
      cache,
      emailService
    )

    await service.requestPasswordReset('a@a.com')

    expect(emailService.sendPasswordResetEmail).not.toHaveBeenCalled()
  })

  it('consumes the reset token atomically and rejects a reused one', async () => {
    const cache = fakeCache(null)
    const updatePassword = vi.fn()
    const service = new AuthService(
      fakeAuthRepository({ updatePassword }),
      fakeJwt(),
      cache
    )

    await expect(
      service.resetPassword('used-token', 'new-password-1', '1.1.1.1')
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(cache.getdel).toHaveBeenCalledTimes(1)
    expect(updatePassword).not.toHaveBeenCalled()
  })
})

describe('AuthService.isPasswordResetTokenValid', () => {
  it('reports a stored token as valid without consuming it', async () => {
    const cache = fakeCache('user-1')
    const service = new AuthService(fakeAuthRepository(), fakeJwt(), cache)

    expect(await service.isPasswordResetTokenValid('token')).toBe(true)
    expect(cache.getdel).not.toHaveBeenCalled()
    expect(cache.del).not.toHaveBeenCalled()
  })

  it('reports an unknown or used token as invalid', async () => {
    const service = new AuthService(
      fakeAuthRepository(),
      fakeJwt(),
      fakeCache(null)
    )

    expect(await service.isPasswordResetTokenValid('token')).toBe(false)
  })
})

describe('AuthService.validateUser lockout scopes', () => {
  function cacheWithCounts(counts: Record<string, number>) {
    const cache = fakeCache()
    cache.get.mockImplementation(async (key: string) => counts[key] ?? null)
    return cache
  }

  const ipKey = (cache: ReturnType<typeof fakeCache>) =>
    cache.increment.mock.calls
      .map(([key]) => key as string)
      .find(k => k.split(':').length === 3)!
  const emailKey = (cache: ReturnType<typeof fakeCache>) =>
    cache.increment.mock.calls
      .map(([key]) => key as string)
      .find(k => k.split(':').length === 2)!

  async function failedLoginKeys(ip: string) {
    const cache = fakeCache()
    const service = new AuthService(
      fakeAuthRepository({ findByEmail: vi.fn().mockResolvedValue(null) }),
      fakeJwt(),
      cache
    )
    await service.validateUser('a@a.com', 'wrong', ip).catch(() => undefined)
    return { ip: ipKey(cache), email: emailKey(cache) }
  }

  it('blocks one IP after 10 failures without blocking another IP for the same email', async () => {
    const attacker = await failedLoginKeys('9.9.9.9')
    const other = await failedLoginKeys('2.2.2.2')
    expect(attacker.ip).not.toBe(other.ip)
    expect(attacker.email).toBe(other.email)

    const findByEmail = vi.fn().mockResolvedValue(null)
    const blocked = new AuthService(
      fakeAuthRepository({ findByEmail }),
      fakeJwt(),
      cacheWithCounts({ [attacker.ip]: 10 })
    )
    await expect(
      blocked.validateUser('a@a.com', 'x', '9.9.9.9')
    ).rejects.toMatchObject({ statusCode: 429 })
    expect(findByEmail).not.toHaveBeenCalled()

    const allowed = new AuthService(
      fakeAuthRepository({ findByEmail }),
      fakeJwt(),
      cacheWithCounts({ [attacker.ip]: 10 })
    )
    await expect(
      allowed.validateUser('a@a.com', 'x', '2.2.2.2')
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(findByEmail).toHaveBeenCalledTimes(1)
  })

  it('blocks every IP once the email reaches 50 failures', async () => {
    const keys = await failedLoginKeys('9.9.9.9')
    const findByEmail = vi.fn()
    const service = new AuthService(
      fakeAuthRepository({ findByEmail }),
      fakeJwt(),
      cacheWithCounts({ [keys.email]: 50 })
    )

    await expect(
      service.validateUser('a@a.com', 'x', '3.3.3.3')
    ).rejects.toMatchObject({ statusCode: 429 })
    expect(findByEmail).not.toHaveBeenCalled()
  })

  it('counts a failure against both the email+IP key and the email key', async () => {
    const keys = await failedLoginKeys('9.9.9.9')
    expect(keys.ip).toMatch(/^login-failures:[0-9a-f]{64}:[0-9a-f]{64}$/)
    expect(keys.email).toMatch(/^login-failures:[0-9a-f]{64}$/)
  })

  it('clears only the email+IP counter on success', async () => {
    const hashed = await bcrypt.hash('correct-password', 4)
    const cache = fakeCache()
    const service = new AuthService(
      fakeAuthRepository({
        findByEmail: vi
          .fn()
          .mockResolvedValue({ id: '1', userName: 'x', password: hashed })
      }),
      fakeJwt(),
      cache
    )

    await service.validateUser('a@a.com', 'correct-password', '1.1.1.1')

    expect(cache.del).toHaveBeenCalledTimes(1)
    expect(cache.del).toHaveBeenCalledWith(
      expect.stringMatching(/^login-failures:[0-9a-f]{64}:[0-9a-f]{64}$/)
    )
  })

  it('does not apply the email-wide limit to an IP that logged in before', async () => {
    const keys = await failedLoginKeys('7.7.7.7')
    const cache = fakeCache()
    cache.get.mockImplementation(async (key: string) => {
      if (key === keys.email) return 50
      if (key.startsWith('login-familiar-ip:')) return true
      return null
    })
    const findByEmail = vi.fn().mockResolvedValue(null)
    const service = new AuthService(
      fakeAuthRepository({ findByEmail }),
      fakeJwt(),
      cache
    )

    await expect(
      service.validateUser('a@a.com', 'x', '7.7.7.7')
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(findByEmail).toHaveBeenCalledTimes(1)
    expect(cache.increment).toHaveBeenCalledTimes(1)
    expect(cache.increment).toHaveBeenCalledWith(keys.ip, expect.any(Number))
  })

  it('still blocks a familiar IP at its own limit', async () => {
    const keys = await failedLoginKeys('7.7.7.7')
    const cache = fakeCache()
    cache.get.mockImplementation(async (key: string) => {
      if (key === keys.ip) return 10
      if (key.startsWith('login-familiar-ip:')) return true
      return null
    })
    const findByEmail = vi.fn()
    const service = new AuthService(
      fakeAuthRepository({ findByEmail }),
      fakeJwt(),
      cache
    )

    await expect(
      service.validateUser('a@a.com', 'x', '7.7.7.7')
    ).rejects.toMatchObject({ statusCode: 429 })
    expect(findByEmail).not.toHaveBeenCalled()
  })

  it('remembers the IP for 30 days after a successful login', async () => {
    const hashed = await bcrypt.hash('correct-password', 4)
    const cache = fakeCache()
    const service = new AuthService(
      fakeAuthRepository({
        findByEmail: vi
          .fn()
          .mockResolvedValue({ id: '1', userName: 'x', password: hashed })
      }),
      fakeJwt(),
      cache
    )

    await service.validateUser('a@a.com', 'correct-password', '7.7.7.7')

    expect(cache.set).toHaveBeenCalledWith(
      expect.stringMatching(/^login-familiar-ip:[0-9a-f]{64}:[0-9a-f]{64}$/),
      true,
      30 * 24 * 60 * 60
    )
  })

  it('lifts both counters when the password is reset', async () => {
    const failed = await failedLoginKeys('1.1.1.1')
    const cache = fakeCache('user-1')
    const service = new AuthService(
      fakeAuthRepository({
        updatePassword: vi.fn().mockResolvedValue({ email: 'a@a.com' }),
        markEmailVerified: vi.fn(),
        deleteTokensByUserId: vi.fn()
      }),
      fakeJwt(),
      cache
    )

    await service.resetPassword('reset-token', 'new-password-1', '1.1.1.1')

    expect(cache.del).toHaveBeenCalledWith(failed.ip)
    expect(cache.del).toHaveBeenCalledWith(failed.email)
  })
})

describe('AuthService email verification', () => {
  function emailServiceMock(send = vi.fn().mockResolvedValue(undefined)) {
    return {
      sendEmailVerificationEmail: send,
      sendPasswordResetEmail: vi.fn()
    } as unknown as EmailService
  }

  function tokenFrom(send: ReturnType<typeof vi.fn>) {
    const url = send.mock.calls[0][1] as string
    return new URL(url).searchParams.get('token') as string
  }

  it('sends a verification email on signup and stores only the hash of the token', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const cache = fakeCache()
    const service = new AuthService(
      fakeAuthRepository({
        findByEmail: vi.fn().mockResolvedValue(null),
        createUser: vi.fn().mockResolvedValue({ id: 'user-1' }),
        saveToken: vi.fn()
      }),
      fakeJwt(),
      cache,
      emailServiceMock(send)
    )

    await service.createUser({ email: 'a@a.com', password: 'k3!fgh-long-pw' })

    const token = tokenFrom(send)
    expect(send).toHaveBeenCalledWith(
      'a@a.com',
      expect.stringContaining('/verify-email?token=')
    )
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(cache.set).toHaveBeenCalledWith(
      expect.stringMatching(/^email-verification:[0-9a-f]{64}$/),
      'user-1',
      24 * 60 * 60
    )
    const storedKeys = cache.set.mock.calls.map(([key]) => String(key))
    expect(storedKeys.some(key => key.includes(token))).toBe(false)
  })

  it('does not fail the signup when the email cannot be delivered', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const service = new AuthService(
      fakeAuthRepository({
        findByEmail: vi.fn().mockResolvedValue(null),
        createUser: vi.fn().mockResolvedValue({ id: 'user-1' }),
        saveToken: vi.fn()
      }),
      fakeJwt(),
      fakeCache(),
      emailServiceMock(vi.fn().mockRejectedValue(new Error('no api key')))
    )

    await expect(
      service.createUser({ email: 'a@a.com', password: 'k3!fgh-long-pw' })
    ).resolves.toMatchObject({ user: { id: 'user-1' } })
    vi.restoreAllMocks()
  })

  it('marks the account as verified with a valid token and consumes it', async () => {
    const markEmailVerified = vi.fn()
    const cache = fakeCache('user-1')
    const service = new AuthService(
      fakeAuthRepository({ markEmailVerified }),
      fakeJwt(),
      cache
    )

    await service.verifyEmail('some-token')

    expect(cache.getdel).toHaveBeenCalledWith(
      expect.stringMatching(/^email-verification:[0-9a-f]{64}$/)
    )
    expect(markEmailVerified).toHaveBeenCalledWith('user-1')
  })

  it('rejects an unknown or already used token', async () => {
    const markEmailVerified = vi.fn()
    const service = new AuthService(
      fakeAuthRepository({ markEmailVerified }),
      fakeJwt(),
      fakeCache(null)
    )

    await expect(service.verifyEmail('used-token')).rejects.toMatchObject({
      statusCode: 400
    })
    expect(markEmailVerified).not.toHaveBeenCalled()
  })

  it('invalidates the previous link when a new one is sent', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const cache = fakeCache()
    cache.get.mockResolvedValue('previous-hash')
    const service = new AuthService(
      fakeAuthRepository({
        findById: vi.fn().mockResolvedValue({
          id: 'user-1',
          email: 'a@a.com',
          emailVerifiedAt: null
        })
      }),
      fakeJwt(),
      cache,
      emailServiceMock(send)
    )

    await service.resendEmailVerification('user-1')

    expect(cache.del).toHaveBeenCalledWith('email-verification:previous-hash')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('keeps the previous link working when the new one cannot be delivered', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const cache = fakeCache()
    cache.get.mockResolvedValue('previous-hash')
    const service = new AuthService(
      fakeAuthRepository({
        findById: vi.fn().mockResolvedValue({
          id: 'user-1',
          email: 'a@a.com',
          emailVerifiedAt: null
        })
      }),
      fakeJwt(),
      cache,
      emailServiceMock(vi.fn().mockRejectedValue(new Error('no api key')))
    )

    await expect(
      service.resendEmailVerification('user-1')
    ).rejects.toMatchObject({ statusCode: 503 })
    expect(cache.del).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('does not resend to an account that is already verified', async () => {
    const send = vi.fn()
    const cache = fakeCache()
    const service = new AuthService(
      fakeAuthRepository({
        findById: vi.fn().mockResolvedValue({
          id: 'user-1',
          email: 'a@a.com',
          emailVerifiedAt: new Date()
        })
      }),
      fakeJwt(),
      cache,
      emailServiceMock(send)
    )

    await service.resendEmailVerification('user-1')

    expect(send).not.toHaveBeenCalled()
    expect(cache.increment).not.toHaveBeenCalled()
  })

  it('stops resending after 3 requests in an hour', async () => {
    const send = vi.fn()
    const cache = fakeCache()
    cache.increment.mockResolvedValue(4)
    const service = new AuthService(
      fakeAuthRepository({
        findById: vi.fn().mockResolvedValue({
          id: 'user-1',
          email: 'a@a.com',
          emailVerifiedAt: null
        })
      }),
      fakeJwt(),
      cache,
      emailServiceMock(send)
    )

    await expect(
      service.resendEmailVerification('user-1')
    ).rejects.toMatchObject({ statusCode: 429 })
    expect(send).not.toHaveBeenCalled()
  })

  it('tells the user when the resend could not be delivered', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const service = new AuthService(
      fakeAuthRepository({
        findById: vi.fn().mockResolvedValue({
          id: 'user-1',
          email: 'a@a.com',
          emailVerifiedAt: null
        })
      }),
      fakeJwt(),
      fakeCache(),
      emailServiceMock(vi.fn().mockRejectedValue(new Error('no api key')))
    )

    await expect(
      service.resendEmailVerification('user-1')
    ).rejects.toMatchObject({ statusCode: 503 })
    vi.restoreAllMocks()
  })
})

describe('AuthService provider linking', () => {
  const googleProfile = {
    sub: 'google-1',
    email: 'user@a.com',
    email_verified: true,
    name: 'User',
    picture: 'https://example.com/p.png'
  }

  function googleSetup(existing: { discordId: string | null }) {
    const linkGoogle = vi.fn().mockResolvedValue({ id: 'user-1' })
    const cache = fakeCache()
    const authRepository = fakeAuthRepository({
      findUserByGoogleId: vi.fn().mockResolvedValue(null),
      findByEmail: vi
        .fn()
        .mockResolvedValue({ id: 'user-1', googleId: null, ...existing }),
      linkGoogle,
      saveToken: vi.fn()
    })
    const service = new AuthService(authRepository, fakeJwt(), cache)
    return { service, linkGoogle, cache }
  }

  it('drops the password of a password-only account even when its email was verified by link', async () => {
    const { service, linkGoogle, cache } = googleSetup({ discordId: null })

    await service.loginWithGoogle(googleProfile, true)

    expect(linkGoogle).toHaveBeenCalledWith(
      'user-1',
      'google-1',
      googleProfile.picture,
      expect.any(String)
    )
    expect(cache.set).toHaveBeenCalledWith(
      'sessions-revoked-at:user-1',
      expect.any(Number),
      expect.any(Number)
    )
  })

  it('keeps the password and sessions of an account that already has another provider', async () => {
    const { service, linkGoogle, cache } = googleSetup({
      discordId: 'discord-1'
    })

    await service.loginWithGoogle(googleProfile, true)

    expect(linkGoogle).toHaveBeenCalledWith(
      'user-1',
      'google-1',
      googleProfile.picture,
      null
    )
    expect(cache.set).not.toHaveBeenCalledWith(
      'sessions-revoked-at:user-1',
      expect.anything(),
      expect.anything()
    )
  })

  it('writes nothing when storing the session revocation fails, so a retry repeats the takeover', async () => {
    const { service, linkGoogle, cache } = googleSetup({ discordId: null })
    cache.set.mockRejectedValueOnce(new Error('redis down'))

    await expect(service.loginWithGoogle(googleProfile, true)).rejects.toThrow(
      'redis down'
    )
    expect(linkGoogle).not.toHaveBeenCalled()
  })

  it('does the same for Discord', async () => {
    const linkDiscord = vi.fn()
    const cache = fakeCache()
    cache.set.mockRejectedValueOnce(new Error('redis down'))
    const service = new AuthService(
      fakeAuthRepository({
        findByDiscordId: vi.fn().mockResolvedValue(null),
        findByEmail: vi.fn().mockResolvedValue({
          id: 'user-1',
          googleId: null,
          discordId: null
        }),
        linkDiscord
      }),
      fakeJwt(),
      cache
    )

    await expect(
      service.loginWithDiscord(
        {
          id: 'discord-1',
          email: 'user@a.com',
          verified: true,
          username: 'user',
          avatar: null
        },
        true
      )
    ).rejects.toThrow('redis down')
    expect(linkDiscord).not.toHaveBeenCalled()
  })

  it.each([
    ['a password-only account', null, true],
    ['an account that already has Google', 'google-1', false]
  ])('links Discord to %s', async (_label, googleId, expectsTakeOver) => {
    const linkDiscord = vi.fn().mockResolvedValue({ id: 'user-1' })
    const service = new AuthService(
      fakeAuthRepository({
        findByDiscordId: vi.fn().mockResolvedValue(null),
        findByEmail: vi
          .fn()
          .mockResolvedValue({ id: 'user-1', googleId, discordId: null }),
        linkDiscord,
        saveToken: vi.fn()
      }),
      fakeJwt(),
      fakeCache()
    )

    await service.loginWithDiscord(
      {
        id: 'discord-1',
        email: 'user@a.com',
        verified: true,
        username: 'user',
        avatar: null
      },
      true
    )

    expect(linkDiscord).toHaveBeenCalledWith(
      'user-1',
      'discord-1',
      null,
      expectsTakeOver ? expect.any(String) : null
    )
  })
})

describe('AuthService provider already linked', () => {
  it('refuses to replace the Google account already linked to that email', async () => {
    const linkGoogle = vi.fn()
    const updatePassword = vi.fn()
    const service = new AuthService(
      fakeAuthRepository({
        findUserByGoogleId: vi.fn().mockResolvedValue(null),
        findByEmail: vi.fn().mockResolvedValue({
          id: 'user-1',
          googleId: 'another-google-account',
          discordId: null
        }),
        linkGoogle,
        updatePassword
      }),
      fakeJwt(),
      fakeCache()
    )

    await expect(
      service.loginWithGoogle(
        {
          sub: 'google-2',
          email: 'user@a.com',
          email_verified: true,
          name: 'User',
          picture: 'https://example.com/p.png'
        },
        true
      )
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(linkGoogle).not.toHaveBeenCalled()
    expect(updatePassword).not.toHaveBeenCalled()
  })

  it('refuses to replace the Discord account already linked to that email', async () => {
    const linkDiscord = vi.fn()
    const updatePassword = vi.fn()
    const service = new AuthService(
      fakeAuthRepository({
        findByDiscordId: vi.fn().mockResolvedValue(null),
        findByEmail: vi.fn().mockResolvedValue({
          id: 'user-1',
          googleId: null,
          discordId: 'another-discord-account'
        }),
        linkDiscord,
        updatePassword
      }),
      fakeJwt(),
      fakeCache()
    )

    await expect(
      service.loginWithDiscord(
        {
          id: 'discord-2',
          email: 'user@a.com',
          verified: true,
          username: 'user',
          avatar: null
        },
        true
      )
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(linkDiscord).not.toHaveBeenCalled()
    expect(updatePassword).not.toHaveBeenCalled()
  })
})

describe('AuthService provider emails', () => {
  it('looks up and creates the Google account with a lowercase email', async () => {
    const findByEmail = vi.fn().mockResolvedValue(null)
    const createUserWithGoogle = vi.fn().mockResolvedValue({ id: 'user-1' })
    const service = new AuthService(
      fakeAuthRepository({
        findUserByGoogleId: vi.fn().mockResolvedValue(null),
        findByEmail,
        createUserWithGoogle,
        saveToken: vi.fn()
      }),
      fakeJwt(),
      fakeCache()
    )

    const result = await service.loginWithGoogle(
      {
        sub: 'google-1',
        email: 'Ana@Mail.COM',
        email_verified: true,
        name: 'Ana',
        picture: 'https://example.com/p.png'
      },
      true
    )

    expect(findByEmail).toHaveBeenCalledWith('ana@mail.com')
    expect(createUserWithGoogle).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ana@mail.com' })
    )
    expect(result.user).toMatchObject({ email: 'ana@mail.com' })
  })

  it('looks up and creates the Discord account with a lowercase email', async () => {
    const findByEmail = vi.fn().mockResolvedValue(null)
    const createWithDiscord = vi.fn().mockResolvedValue({ id: 'user-1' })
    const service = new AuthService(
      fakeAuthRepository({
        findByDiscordId: vi.fn().mockResolvedValue(null),
        findByEmail,
        createWithDiscord,
        saveToken: vi.fn()
      }),
      fakeJwt(),
      fakeCache()
    )

    await service.loginWithDiscord(
      {
        id: 'discord-1',
        email: 'Ana@Mail.COM',
        verified: true,
        username: 'ana',
        avatar: null
      },
      true
    )

    expect(findByEmail).toHaveBeenCalledWith('ana@mail.com')
    expect(createWithDiscord).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ana@mail.com' })
    )
  })
})

describe('AuthService token types', () => {
  const activeToken = {
    isValid: true,
    expiresAt: new Date(Date.now() + 60_000)
  }

  it('signs the access and refresh tokens with different types', async () => {
    const sign = vi.fn(() => 'signed-token')
    const service = new AuthService(
      fakeAuthRepository({ saveToken: vi.fn() }),
      fakeJwt({ sign } as Partial<JWT>),
      fakeCache()
    )

    await service.generateTokens('user-1')

    expect(sign).toHaveBeenCalledWith(
      { userId: 'user-1', tokenType: 'access' },
      expect.anything()
    )
    expect(sign).toHaveBeenCalledWith(
      { userId: 'user-1', tokenType: 'refresh', jti: expect.any(String) },
      expect.anything()
    )
  })

  it('gives every refresh token its own jti so tokens signed in the same second differ', async () => {
    const sign = vi.fn<(payload: object, options?: object) => string>(
      () => 'signed-token'
    )
    const service = new AuthService(
      fakeAuthRepository({ saveToken: vi.fn() }),
      fakeJwt({ sign } as Partial<JWT>),
      fakeCache()
    )

    await service.generateTokens('user-1')
    await service.generateTokens('user-1')

    const jtis = sign.mock.calls
      .map(([payload]) => (payload as { jti?: string }).jti)
      .filter(Boolean)
    expect(jtis).toHaveLength(2)
    expect(jtis[0]).not.toBe(jtis[1])
  })

  it('does not accept an access token as a refresh token', async () => {
    const invalidateToken = vi.fn()
    const service = new AuthService(
      fakeAuthRepository({
        findToken: vi.fn().mockResolvedValue(activeToken),
        invalidateToken
      }),
      fakeJwt({
        verify: vi.fn(() => ({ userId: 'user-1', tokenType: 'access' }))
      } as Partial<JWT>),
      fakeCache()
    )

    await expect(
      service.validateRefreshToken('some-token')
    ).rejects.toMatchObject({ statusCode: 401 })
    expect(await service.isRefreshTokenActive('some-token')).toBeNull()
    expect(invalidateToken).not.toHaveBeenCalled()
  })

  it('still accepts a refresh token issued before token types existed', async () => {
    const service = new AuthService(
      fakeAuthRepository({ findToken: vi.fn().mockResolvedValue(activeToken) }),
      fakeJwt({ verify: vi.fn(() => ({ userId: 'user-1' })) } as Partial<JWT>),
      fakeCache()
    )

    expect(await service.isRefreshTokenActive('some-token')).toBe('user-1')
  })
})

describe('AuthService OAuth terms acceptance', () => {
  const googleProfile = {
    sub: 'google-1',
    email: 'ana@mail.com',
    email_verified: true,
    name: 'Ana',
    picture: 'https://example.com/p.png'
  }
  const discordProfile = {
    id: 'discord-1',
    email: 'ana@mail.com',
    verified: true,
    username: 'ana',
    avatar: null
  }

  it('creates a new Google account when the terms were accepted', async () => {
    const createUserWithGoogle = vi.fn().mockResolvedValue({ id: 'user-1' })
    const saveToken = vi.fn()
    const service = new AuthService(
      fakeAuthRepository({
        findUserByGoogleId: vi.fn().mockResolvedValue(null),
        findByEmail: vi.fn().mockResolvedValue(null),
        createUserWithGoogle,
        saveToken
      }),
      fakeJwt(),
      fakeCache()
    )

    await service.loginWithGoogle(googleProfile, true)

    expect(createUserWithGoogle).toHaveBeenCalledTimes(1)
    expect(saveToken).toHaveBeenCalledTimes(1)
  })

  it('refuses a new Google account without acceptance and issues no session', async () => {
    const createUserWithGoogle = vi.fn()
    const saveToken = vi.fn()
    const cache = fakeCache()
    const service = new AuthService(
      fakeAuthRepository({
        findUserByGoogleId: vi.fn().mockResolvedValue(null),
        findByEmail: vi.fn().mockResolvedValue(null),
        createUserWithGoogle,
        saveToken
      }),
      fakeJwt(),
      cache
    )

    await expect(
      service.loginWithGoogle(googleProfile, false)
    ).rejects.toBeInstanceOf(TermsRequiredError)
    expect(createUserWithGoogle).not.toHaveBeenCalled()
    expect(saveToken).not.toHaveBeenCalled()
    expect(cache.set).not.toHaveBeenCalled()
  })

  it('lets an existing Google account in without acceptance', async () => {
    const createUserWithGoogle = vi.fn()
    const saveToken = vi.fn()
    const service = new AuthService(
      fakeAuthRepository({
        findUserByGoogleId: vi.fn().mockResolvedValue({ id: 'user-1' }),
        createUserWithGoogle,
        saveToken
      }),
      fakeJwt(),
      fakeCache()
    )

    const result = await service.loginWithGoogle(googleProfile, false)

    expect(result.user).toEqual({ id: 'user-1' })
    expect(createUserWithGoogle).not.toHaveBeenCalled()
    expect(saveToken).toHaveBeenCalledTimes(1)
  })

  it('links a Google login to an existing email without acceptance', async () => {
    const createUserWithGoogle = vi.fn()
    const linkGoogle = vi.fn().mockResolvedValue({ id: 'user-1' })
    const service = new AuthService(
      fakeAuthRepository({
        findUserByGoogleId: vi.fn().mockResolvedValue(null),
        findByEmail: vi
          .fn()
          .mockResolvedValue({ id: 'user-1', googleId: null, discordId: null }),
        updatePassword: vi.fn(),
        deleteTokensByUserId: vi.fn(),
        markEmailVerified: vi.fn(),
        linkGoogle,
        createUserWithGoogle,
        saveToken: vi.fn()
      }),
      fakeJwt(),
      fakeCache()
    )

    await service.loginWithGoogle(googleProfile, false)

    expect(linkGoogle).toHaveBeenCalledTimes(1)
    expect(createUserWithGoogle).not.toHaveBeenCalled()
  })

  it('creates a new Discord account when the terms were accepted', async () => {
    const createWithDiscord = vi.fn().mockResolvedValue({ id: 'user-1' })
    const service = new AuthService(
      fakeAuthRepository({
        findByDiscordId: vi.fn().mockResolvedValue(null),
        findByEmail: vi.fn().mockResolvedValue(null),
        createWithDiscord,
        saveToken: vi.fn()
      }),
      fakeJwt(),
      fakeCache()
    )

    await service.loginWithDiscord(discordProfile, true)

    expect(createWithDiscord).toHaveBeenCalledTimes(1)
  })

  it('refuses a new Discord account without acceptance and issues no session', async () => {
    const createWithDiscord = vi.fn()
    const saveToken = vi.fn()
    const service = new AuthService(
      fakeAuthRepository({
        findByDiscordId: vi.fn().mockResolvedValue(null),
        findByEmail: vi.fn().mockResolvedValue(null),
        createWithDiscord,
        saveToken
      }),
      fakeJwt(),
      fakeCache()
    )

    await expect(
      service.loginWithDiscord(discordProfile, false)
    ).rejects.toBeInstanceOf(TermsRequiredError)
    expect(createWithDiscord).not.toHaveBeenCalled()
    expect(saveToken).not.toHaveBeenCalled()
  })

  it('lets an existing Discord account in without acceptance', async () => {
    const createWithDiscord = vi.fn()
    const saveToken = vi.fn()
    const service = new AuthService(
      fakeAuthRepository({
        findByDiscordId: vi.fn().mockResolvedValue({ id: 'user-1' }),
        createWithDiscord,
        saveToken
      }),
      fakeJwt(),
      fakeCache()
    )

    await service.loginWithDiscord(discordProfile, false)

    expect(createWithDiscord).not.toHaveBeenCalled()
    expect(saveToken).toHaveBeenCalledTimes(1)
  })
})

describe('AuthService.loginWithGoogle with a verified account email', () => {
  it('keeps the password when the existing account already verified its email', async () => {
    const linkGoogle = vi.fn().mockResolvedValue({ id: 'user-1' })
    const authRepository = fakeAuthRepository({
      findUserByGoogleId: vi.fn().mockResolvedValue(null),
      findByEmail: vi.fn().mockResolvedValue({
        id: 'user-1',
        googleId: null,
        discordId: null,
        emailVerifiedAt: new Date()
      }),
      linkGoogle,
      saveToken: vi.fn()
    })
    const cache = fakeCache()
    const service = new AuthService(authRepository, fakeJwt(), cache)

    await service.loginWithGoogle(
      {
        sub: 'google-1',
        email: 'a@a.com',
        email_verified: true,
        name: 'A',
        picture: 'pic'
      },
      true
    )

    expect(linkGoogle).toHaveBeenCalledWith('user-1', 'google-1', 'pic', null)
  })
})

describe('AuthService.changePassword', () => {
  const NEW_PASSWORD = 'uma-senha-nova-forte'

  async function build(
    state: { hasPassword: boolean; password?: string },
    opts: { recent?: boolean; failures?: number } = {}
  ) {
    const password = state.password ?? (await bcrypt.hash('senha-atual-1', 4))
    const updatePassword = vi.fn().mockResolvedValue({ email: 'a@a.com' })
    const deleteTokensByUserId = vi.fn()
    const authRepository = fakeAuthRepository({
      findPasswordState: vi.fn().mockResolvedValue({
        id: 'user-1',
        email: 'a@a.com',
        password,
        hasPassword: state.hasPassword
      }),
      updatePassword,
      deleteTokensByUserId,
      saveToken: vi.fn()
    })
    const cache = fakeCache(opts.failures ?? null)
    const emailService = {
      sendPasswordChangedEmail: vi.fn().mockResolvedValue(undefined)
    } as unknown as EmailService
    const recentAuth = {
      isRecent: vi.fn().mockResolvedValue(opts.recent ?? true),
      mark: vi.fn().mockResolvedValue(undefined)
    }
    const service = new AuthService(
      authRepository,
      fakeJwt(),
      cache,
      emailService,
      recentAuth as never
    )
    return {
      service,
      updatePassword,
      deleteTokensByUserId,
      cache,
      emailService,
      recentAuth
    }
  }

  it('rejects a wrong current password and counts the failure apart from login', async () => {
    const { service, updatePassword, cache } = await build({
      hasPassword: true
    })

    await expect(
      service.changePassword('user-1', {
        currentPassword: 'errada',
        newPassword: NEW_PASSWORD
      })
    ).rejects.toThrow('A senha atual está incorreta.')

    expect(updatePassword).not.toHaveBeenCalled()
    expect(cache.increment).toHaveBeenCalledWith(
      'password-change-failures:user-1',
      expect.any(Number)
    )
    expect(cache.increment).not.toHaveBeenCalledWith(
      expect.stringContaining('login-failures'),
      expect.anything()
    )
  })

  it('blocks after too many wrong attempts', async () => {
    const { service, updatePassword } = await build(
      { hasPassword: true },
      { failures: 5 }
    )

    await expect(
      service.changePassword('user-1', {
        currentPassword: 'senha-atual-1',
        newPassword: NEW_PASSWORD
      })
    ).rejects.toMatchObject({ statusCode: 429 })
    expect(updatePassword).not.toHaveBeenCalled()
  })

  it('refuses a new password equal to the current one', async () => {
    const { service } = await build({ hasPassword: true })

    await expect(
      service.changePassword('user-1', {
        currentPassword: 'senha-atual-1',
        newPassword: 'senha-atual-1'
      })
    ).rejects.toThrow('A nova senha precisa ser diferente da atual.')
  })

  it('changes the password, revokes sessions, signs the device in again and warns by email', async () => {
    const { service, updatePassword, deleteTokensByUserId, emailService } =
      await build({ hasPassword: true })

    const result = await service.changePassword('user-1', {
      currentPassword: 'senha-atual-1',
      newPassword: NEW_PASSWORD
    })

    expect(updatePassword).toHaveBeenCalledWith('user-1', expect.any(String))
    expect(deleteTokensByUserId).toHaveBeenCalledWith('user-1')
    expect(result.accessToken).toBe('signed-token')
    expect(result.wasSet).toBe(false)
    await new Promise(resolve => setImmediate(resolve))
    expect(emailService.sendPasswordChangedEmail).toHaveBeenCalledWith(
      'a@a.com',
      expect.stringContaining('/forgot-password'),
      true
    )
  })

  it('lets an account without a password set one after a recent sign-in', async () => {
    const { service, updatePassword } = await build(
      { hasPassword: false },
      { recent: true }
    )

    const result = await service.changePassword('user-1', {
      newPassword: NEW_PASSWORD
    })

    expect(updatePassword).toHaveBeenCalled()
    expect(result.wasSet).toBe(true)
  })

  it('asks for a new sign-in when setting a password without a recent one', async () => {
    const { service, updatePassword } = await build(
      { hasPassword: false },
      { recent: false }
    )

    await expect(
      service.changePassword('user-1', { newPassword: NEW_PASSWORD })
    ).rejects.toBeInstanceOf(ReauthRequiredError)
    expect(updatePassword).not.toHaveBeenCalled()
  })

  it('refuses a password equal to the account email', async () => {
    const { service } = await build({ hasPassword: false })

    await expect(
      service.changePassword('user-1', { newPassword: 'a@a.com' })
    ).rejects.toThrow('A senha não pode ser igual ao email.')
  })
})

describe('AuthService.loginWithDiscord with a verified account email', () => {
  it('keeps the password when the existing account already verified its email', async () => {
    const linkDiscord = vi.fn().mockResolvedValue({ id: 'user-1' })
    const authRepository = fakeAuthRepository({
      findByDiscordId: vi.fn().mockResolvedValue(null),
      findByEmail: vi.fn().mockResolvedValue({
        id: 'user-1',
        googleId: null,
        discordId: null,
        emailVerifiedAt: new Date()
      }),
      linkDiscord,
      saveToken: vi.fn()
    })
    const service = new AuthService(authRepository, fakeJwt(), fakeCache())

    await service.loginWithDiscord(
      {
        id: 'discord-1',
        email: 'a@a.com',
        verified: true,
        username: 'a',
        avatar: null
      },
      true
    )

    expect(linkDiscord).toHaveBeenCalledWith('user-1', 'discord-1', null, null)
  })
})

function memoryCache() {
  const store = new Map<string, unknown>()
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value)
    }),
    getdel: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null
      store.delete(key)
      return value
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key)
    }),
    increment: vi.fn(async (key: string) => {
      const next = (Number(store.get(key)) || 0) + 1
      store.set(key, next)
      return next
    })
  } as unknown as CacheRepository & { store: Map<string, unknown> }
}

describe('AuthService e-mail change', () => {
  const CURRENT = 'senha-atual-1'
  const tick = () => new Promise(resolve => setImmediate(resolve))

  async function build(
    opts: {
      hasPassword?: boolean
      recent?: boolean
      taken?: boolean
      failSend?: boolean
    } = {}
  ) {
    const hasPassword = opts.hasPassword ?? true
    const password = await bcrypt.hash(CURRENT, 4)
    const cache = memoryCache()
    const repo = {
      findPasswordState: vi.fn().mockResolvedValue({
        id: 'user-1',
        email: 'dono@a.com',
        password,
        hasPassword
      }),
      findById: vi
        .fn()
        .mockResolvedValue({ id: 'user-1', email: 'dono@a.com' }),
      findByEmail: vi
        .fn()
        .mockResolvedValue(opts.taken ? { id: 'other' } : null),
      updateEmail: vi.fn().mockResolvedValue({ id: 'user-1' }),
      deleteTokensByUserId: vi.fn()
    }
    const mail = {
      sendEmailChangeConfirmationEmail: vi.fn().mockImplementation(async () => {
        if (opts.failSend) throw new Error('smtp down')
      }),
      sendEmailChangeRequestedNoticeEmail: vi.fn().mockResolvedValue(undefined),
      sendEmailChangedNoticeEmail: vi.fn().mockResolvedValue(undefined),
      sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined)
    }
    const recent = {
      isRecent: vi.fn().mockResolvedValue(opts.recent ?? true),
      mark: vi.fn()
    }
    const service = new AuthService(
      repo as unknown as AuthRepository,
      fakeJwt(),
      cache,
      mail as unknown as EmailService,
      recent as never
    )
    const lastToken = () => {
      const calls = mail.sendEmailChangeConfirmationEmail.mock.calls
      return new URL(calls[calls.length - 1][1]).searchParams.get('token')!
    }
    return { service, cache, repo, mail, lastToken }
  }

  beforeEach(() => {
    vi.stubEnv('FRONTEND_URL', 'http://localhost:5173')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('sends the link to the NEW address, warns the old one and leaves the e-mail alone', async () => {
    const { service, repo, mail, cache } = await build()

    const result = await service.requestEmailChange('user-1', {
      newEmail: '  Novo@A.com ',
      currentPassword: CURRENT
    })
    await tick()

    expect(result).toEqual({ pendingEmail: 'novo@a.com' })
    expect(mail.sendEmailChangeConfirmationEmail).toHaveBeenCalledWith(
      'novo@a.com',
      expect.stringContaining('/confirm-email-change?token=')
    )
    expect(mail.sendEmailChangeRequestedNoticeEmail).toHaveBeenCalledWith(
      'dono@a.com',
      'novo@a.com',
      'http://localhost:5173/configuracoes/conta'
    )
    expect(repo.updateEmail).not.toHaveBeenCalled()
    expect(cache.store.get('email-change-current:user-1')).toMatchObject({
      newEmail: 'novo@a.com'
    })
  })

  it('rejects a wrong password, counts it and sends nothing', async () => {
    const { service, mail, cache } = await build()

    await expect(
      service.requestEmailChange('user-1', {
        newEmail: 'novo@a.com',
        currentPassword: 'errada'
      })
    ).rejects.toThrow('A senha atual está incorreta.')

    expect(mail.sendEmailChangeConfirmationEmail).not.toHaveBeenCalled()
    expect(cache.store.get('password-change-failures:user-1')).toBe(1)
  })

  it('blocks after five wrong passwords, sharing the counter with the password change', async () => {
    const { service, cache } = await build()
    cache.store.set('password-change-failures:user-1', 5)

    await expect(
      service.requestEmailChange('user-1', {
        newEmail: 'novo@a.com',
        currentPassword: CURRENT
      })
    ).rejects.toMatchObject({ statusCode: 429 })
  })

  it('refuses the address the account already has', async () => {
    const { service, mail } = await build()

    await expect(
      service.requestEmailChange('user-1', {
        newEmail: 'DONO@a.com',
        currentPassword: CURRENT
      })
    ).rejects.toThrow('Esse já é o e-mail da sua conta.')
    expect(mail.sendEmailChangeConfirmationEmail).not.toHaveBeenCalled()
  })

  it('says clearly when the address belongs to someone else', async () => {
    const { service, mail } = await build({ taken: true })

    await expect(
      service.requestEmailChange('user-1', {
        newEmail: 'novo@a.com',
        currentPassword: CURRENT
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Este e-mail já está em uso.'
    })
    expect(mail.sendEmailChangeConfirmationEmail).not.toHaveBeenCalled()
  })

  it('asks accounts without a password for a recent sign-in', async () => {
    const stale = await build({ hasPassword: false, recent: false })
    await expect(
      stale.service.requestEmailChange('user-1', { newEmail: 'novo@a.com' })
    ).rejects.toBeInstanceOf(ReauthRequiredError)

    const fresh = await build({ hasPassword: false, recent: true })
    await expect(
      fresh.service.requestEmailChange('user-1', { newEmail: 'novo@a.com' })
    ).resolves.toEqual({ pendingEmail: 'novo@a.com' })
  })

  it('a new request replaces the pending one: the first link stops working', async () => {
    const { service, lastToken, repo } = await build()
    await service.requestEmailChange('user-1', {
      newEmail: 'primeiro@a.com',
      currentPassword: CURRENT
    })
    const first = lastToken()
    await service.requestEmailChange('user-1', {
      newEmail: 'segundo@a.com',
      currentPassword: CURRENT
    })
    const second = lastToken()

    await expect(service.confirmEmailChange(first)).rejects.toMatchObject({
      statusCode: 400
    })
    expect(repo.updateEmail).not.toHaveBeenCalled()
    await expect(service.confirmEmailChange(second)).resolves.toEqual({
      email: 'segundo@a.com'
    })
  })

  it('keeps the previous link when the new one cannot be sent', async () => {
    const ok = await build()
    await ok.service.requestEmailChange('user-1', {
      newEmail: 'primeiro@a.com',
      currentPassword: CURRENT
    })
    const first = ok.lastToken()
    ok.mail.sendEmailChangeConfirmationEmail.mockRejectedValueOnce(
      new Error('smtp down')
    )

    await expect(
      ok.service.requestEmailChange('user-1', {
        newEmail: 'segundo@a.com',
        currentPassword: CURRENT
      })
    ).rejects.toMatchObject({ statusCode: 503 })

    await expect(ok.service.confirmEmailChange(first)).resolves.toEqual({
      email: 'primeiro@a.com'
    })
  })

  it('does not leave a pending change behind when the e-mail cannot be sent', async () => {
    const { service, cache } = await build({ failSend: true })

    await expect(
      service.requestEmailChange('user-1', {
        newEmail: 'novo@a.com',
        currentPassword: CURRENT
      })
    ).rejects.toMatchObject({ statusCode: 503 })

    expect(cache.store.has('email-change-current:user-1')).toBe(false)
    expect(
      [...cache.store.keys()].some(key => key.startsWith('email-change:'))
    ).toBe(false)
  })

  it('allows five requests an hour and refuses the sixth', async () => {
    const { service } = await build()
    for (let i = 0; i < 5; i++) {
      await service.requestEmailChange('user-1', {
        newEmail: `n${i}@a.com`,
        currentPassword: CURRENT
      })
    }

    await expect(
      service.requestEmailChange('user-1', {
        newEmail: 'n6@a.com',
        currentPassword: CURRENT
      })
    ).rejects.toMatchObject({ statusCode: 429 })
  })

  it('resend: needs something pending, issues a new link and kills the old one', async () => {
    const { service, lastToken, mail } = await build()
    await expect(service.resendEmailChange('user-1')).rejects.toMatchObject({
      statusCode: 404
    })

    await service.requestEmailChange('user-1', {
      newEmail: 'novo@a.com',
      currentPassword: CURRENT
    })
    const first = lastToken()
    await expect(service.resendEmailChange('user-1')).resolves.toEqual({
      pendingEmail: 'novo@a.com'
    })
    const second = lastToken()

    expect(second).not.toBe(first)
    expect(mail.sendEmailChangeConfirmationEmail).toHaveBeenCalledTimes(2)
    await expect(service.confirmEmailChange(first)).rejects.toMatchObject({
      statusCode: 400
    })
    await expect(service.confirmEmailChange(second)).resolves.toEqual({
      email: 'novo@a.com'
    })
  })

  it('resend: drops the pending change when the address was taken meanwhile', async () => {
    const { service, repo, cache } = await build()
    await service.requestEmailChange('user-1', {
      newEmail: 'novo@a.com',
      currentPassword: CURRENT
    })
    repo.findByEmail.mockResolvedValue({ id: 'other' })

    await expect(service.resendEmailChange('user-1')).rejects.toMatchObject({
      statusCode: 409
    })
    expect(cache.store.has('email-change-current:user-1')).toBe(false)
  })

  it('cancel removes the pending change, kills its link and can be repeated', async () => {
    const { service, lastToken, repo } = await build()
    await service.requestEmailChange('user-1', {
      newEmail: 'novo@a.com',
      currentPassword: CURRENT
    })
    const token = lastToken()

    await service.cancelEmailChange('user-1')
    await service.cancelEmailChange('user-1')

    await expect(service.confirmEmailChange(token)).rejects.toMatchObject({
      statusCode: 400
    })
    expect(repo.updateEmail).not.toHaveBeenCalled()
  })

  it('confirm: changes the e-mail, signs everyone out, warns the old address and uses the link once', async () => {
    const { service, lastToken, repo, mail, cache } = await build()
    await service.requestEmailChange('user-1', {
      newEmail: 'novo@a.com',
      currentPassword: CURRENT
    })
    const token = lastToken()
    cache.store.set('email-verification-current:user-1', 'old-verification')
    cache.store.set('email-verification:old-verification', 'user-1')

    await expect(service.confirmEmailChange(token)).resolves.toEqual({
      email: 'novo@a.com'
    })
    await tick()

    expect(repo.updateEmail).toHaveBeenCalledWith('user-1', 'novo@a.com')
    expect(repo.deleteTokensByUserId).toHaveBeenCalledWith('user-1')
    expect(cache.store.get('sessions-revoked-at:user-1')).toEqual(
      expect.any(Number)
    )
    expect(cache.store.get('password-reset-epoch:user-1')).toEqual(
      expect.any(Number)
    )
    expect(cache.store.has('email-change-current:user-1')).toBe(false)
    expect(cache.store.has('email-verification:old-verification')).toBe(false)
    expect(cache.store.has('email-verification-current:user-1')).toBe(false)
    expect(mail.sendEmailChangedNoticeEmail).toHaveBeenCalledWith(
      'dono@a.com',
      'novo@a.com',
      'http://localhost:5173/contato'
    )
    await expect(service.confirmEmailChange(token)).rejects.toMatchObject({
      statusCode: 400
    })
  })

  it('confirm: an unknown link is refused', async () => {
    const { service } = await build()

    await expect(service.confirmEmailChange('nada')).rejects.toMatchObject({
      statusCode: 400,
      message: 'Link de confirmação inválido ou expirado.'
    })
  })

  it('confirm: refuses when the address was taken meanwhile, and when two people race', async () => {
    const taken = await build()
    await taken.service.requestEmailChange('user-1', {
      newEmail: 'novo@a.com',
      currentPassword: CURRENT
    })
    const token = taken.lastToken()
    taken.repo.findByEmail.mockResolvedValue({ id: 'other' })
    await expect(taken.service.confirmEmailChange(token)).rejects.toMatchObject(
      { statusCode: 409 }
    )
    expect(taken.repo.updateEmail).not.toHaveBeenCalled()

    const race = await build()
    await race.service.requestEmailChange('user-1', {
      newEmail: 'novo@a.com',
      currentPassword: CURRENT
    })
    const raceToken = race.lastToken()
    race.repo.updateEmail.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test'
      })
    )
    await expect(
      race.service.confirmEmailChange(raceToken)
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(race.repo.deleteTokensByUserId).not.toHaveBeenCalled()
  })

  it('a reset link requested before the change stops working after it; a later one works', async () => {
    const { service, lastToken, repo, mail, cache } = await build()
    repo.findByEmail.mockImplementation(async (email: string) =>
      email === 'dono@a.com' ? { id: 'user-1', email } : null
    )
    ;(repo as Record<string, unknown>).updatePassword = vi
      .fn()
      .mockResolvedValue({ email: 'novo@a.com' })
    ;(repo as Record<string, unknown>).markEmailVerified = vi.fn()

    await service.requestPasswordReset('dono@a.com')
    const oldLink = mail.sendPasswordResetEmail.mock.calls[0][1] as string
    const oldToken = new URL(oldLink).searchParams.get('token')!
    await new Promise(resolve => setTimeout(resolve, 5))

    await service.requestEmailChange('user-1', {
      newEmail: 'novo@a.com',
      currentPassword: CURRENT
    })
    await service.confirmEmailChange(lastToken())
    await new Promise(resolve => setTimeout(resolve, 5))

    expect(await service.isPasswordResetTokenValid(oldToken)).toBe(false)
    await expect(
      service.resetPassword(oldToken, 'uma-senha-nova-forte', '1.1.1.1')
    ).rejects.toMatchObject({ statusCode: 400 })

    repo.findByEmail.mockImplementation(async (email: string) =>
      email === 'novo@a.com' ? { id: 'user-1', email } : null
    )
    await service.requestPasswordReset('novo@a.com')
    const newLink = mail.sendPasswordResetEmail.mock.calls[1][1] as string
    const newToken = new URL(newLink).searchParams.get('token')!
    expect(await service.isPasswordResetTokenValid(newToken)).toBe(true)
    expect(cache.store.get('password-reset-epoch:user-1')).toEqual(
      expect.any(Number)
    )
  })

  it('a reset link in the old plain-text format still works while no e-mail changed', async () => {
    const { service, repo, cache } = await build()
    ;(repo as Record<string, unknown>).updatePassword = vi
      .fn()
      .mockResolvedValue({ email: 'dono@a.com' })
    ;(repo as Record<string, unknown>).markEmailVerified = vi.fn()
    cache.store.set(`password-reset:${hashToken('legado')}`, 'user-1')

    expect(await service.isPasswordResetTokenValid('legado')).toBe(true)
    await expect(
      service.resetPassword('legado', 'uma-senha-nova-forte', '1.1.1.1')
    ).resolves.toBeUndefined()
  })

  it('a password reset drops the pending change, so the attacker link stops working', async () => {
    const { service, lastToken, repo, cache } = await build()
    ;(repo as Record<string, unknown>).updatePassword = vi
      .fn()
      .mockResolvedValue({ email: 'dono@a.com' })
    ;(repo as Record<string, unknown>).markEmailVerified = vi.fn()
    await service.requestEmailChange('user-1', {
      newEmail: 'invasor@a.com',
      currentPassword: CURRENT
    })
    const attackerLink = lastToken()
    cache.store.set(`password-reset:${hashToken('reset')}`, 'user-1')

    await service.resetPassword('reset', 'uma-senha-nova-forte', '1.1.1.1')

    expect(cache.store.has('email-change-current:user-1')).toBe(false)
    await expect(
      service.confirmEmailChange(attackerLink)
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(repo.updateEmail).not.toHaveBeenCalled()
  })

  it('a password change drops the pending change too', async () => {
    const { service, lastToken, repo, cache } = await build()
    ;(repo as Record<string, unknown>).updatePassword = vi
      .fn()
      .mockResolvedValue({ email: 'dono@a.com' })
    ;(repo as Record<string, unknown>).saveToken = vi.fn()
    await service.requestEmailChange('user-1', {
      newEmail: 'invasor@a.com',
      currentPassword: CURRENT
    })
    const attackerLink = lastToken()

    await service.changePassword('user-1', {
      currentPassword: CURRENT,
      newPassword: 'uma-senha-nova-forte'
    })

    expect(cache.store.has('email-change-current:user-1')).toBe(false)
    await expect(
      service.confirmEmailChange(attackerLink)
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('a cancel that lands while the e-mail is being sent kills the new link', async () => {
    const { service, mail, cache, repo } = await build()
    mail.sendEmailChangeConfirmationEmail.mockImplementation(async () => {
      await service.cancelEmailChange('user-1')
    })

    await expect(
      service.requestEmailChange('user-1', {
        newEmail: 'novo@a.com',
        currentPassword: CURRENT
      })
    ).rejects.toMatchObject({ statusCode: 409 })

    expect(
      [...cache.store.keys()].some(key => /^email-change(-current)?:/.test(key))
    ).toBe(false)
    expect(repo.updateEmail).not.toHaveBeenCalled()
  })

  it('a failed send puts the previous pending change back', async () => {
    const { service, mail, cache } = await build()
    await service.requestEmailChange('user-1', {
      newEmail: 'primeiro@a.com',
      currentPassword: CURRENT
    })
    const before = cache.store.get('email-change-current:user-1')
    mail.sendEmailChangeConfirmationEmail.mockRejectedValueOnce(
      new Error('smtp down')
    )

    await expect(
      service.requestEmailChange('user-1', {
        newEmail: 'segundo@a.com',
        currentPassword: CURRENT
      })
    ).rejects.toMatchObject({ statusCode: 503 })

    expect(cache.store.get('email-change-current:user-1')).toEqual(before)
  })

  it('counts attempts on taken addresses toward the hourly quota', async () => {
    const { service } = await build({ taken: true })
    for (let i = 0; i < 5; i++) {
      await expect(
        service.requestEmailChange('user-1', {
          newEmail: `n${i}@a.com`,
          currentPassword: CURRENT
        })
      ).rejects.toMatchObject({ statusCode: 409 })
    }

    await expect(
      service.requestEmailChange('user-1', {
        newEmail: 'n9@a.com',
        currentPassword: CURRENT
      })
    ).rejects.toMatchObject({ statusCode: 429 })
  })
})
