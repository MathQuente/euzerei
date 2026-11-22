import { describe, it, expect, vi } from 'vitest'
import bcrypt from 'bcrypt'
import { JWT } from '@fastify/jwt'
import { AuthService } from './auth.service'
import { AuthRepository } from '../repositories/auth.repository'
import { CacheRepository } from '../repositories/cache.repository'
import { EmailService } from './email.service'

const SUSPENDED_AT = new Date('2026-11-22T12:00:00Z')

function build(
  repo: Record<string, unknown>,
  verify = vi.fn(() => ({ userId: 'u1' }))
) {
  const cache = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    increment: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(undefined)
  } as unknown as CacheRepository
  const recentAuth = { mark: vi.fn() }
  const service = new AuthService(
    repo as unknown as AuthRepository,
    { sign: vi.fn(() => 'signed'), verify } as unknown as JWT,
    cache,
    {} as EmailService,
    recentAuth as never
  )
  return { service, cache, recentAuth }
}

const activeToken = (suspendedAt: Date | null) => ({
  isValid: true,
  expiresAt: new Date(Date.now() + 60_000),
  user: { suspendedAt }
})

describe('conta suspensa: login por senha', () => {
  it('senha certa: 403 "conta suspensa" e nenhuma sessão nova', async () => {
    const password = await bcrypt.hash('correct-password', 4)
    const { service, cache, recentAuth } = build({
      findByEmail: vi.fn().mockResolvedValue({
        id: 'u1',
        userName: 'zz',
        password,
        suspendedAt: SUSPENDED_AT
      })
    })

    await expect(
      service.validateUser('a@a.com', 'correct-password', '1.1.1.1')
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(recentAuth.mark).not.toHaveBeenCalled()
    expect(cache.del).not.toHaveBeenCalled()
  })

  it('senha errada: continua o erro genérico (não revela a suspensão)', async () => {
    const password = await bcrypt.hash('correct-password', 4)
    const { service } = build({
      findByEmail: vi.fn().mockResolvedValue({
        id: 'u1',
        userName: 'zz',
        password,
        suspendedAt: SUSPENDED_AT
      })
    })

    await expect(
      service.validateUser('a@a.com', 'wrong-password', '1.1.1.1')
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'Email ou senha incorretos.'
    })
  })
})

describe('conta suspensa: refresh', () => {
  it('validateRefreshToken recusa com 401', async () => {
    const { service } = build({
      findToken: vi.fn().mockResolvedValue(activeToken(SUSPENDED_AT))
    })

    await expect(service.validateRefreshToken('r')).rejects.toMatchObject({
      statusCode: 401
    })
  })

  it('refreshTokens não gira o token de quem foi suspenso', async () => {
    const rotateToken = vi.fn()
    const { service } = build({
      findToken: vi.fn().mockResolvedValue(activeToken(SUSPENDED_AT)),
      rotateToken
    })

    await expect(service.refreshTokens('r')).rejects.toMatchObject({
      statusCode: 401
    })
    expect(rotateToken).not.toHaveBeenCalled()
  })

  it('isRefreshTokenActive devolve null (a renovação do authenticate não emite token)', async () => {
    const { service } = build({
      findToken: vi.fn().mockResolvedValue(activeToken(SUSPENDED_AT))
    })

    expect(await service.isRefreshTokenActive('r')).toBeNull()
  })

  it('conta ativa continua renovando', async () => {
    const { service } = build({
      findToken: vi.fn().mockResolvedValue(activeToken(null))
    })

    expect(await service.isRefreshTokenActive('r')).toBe('u1')
  })
})

describe('conta suspensa: Google e Discord', () => {
  const google = {
    sub: 'g1',
    email: 'a@a.com',
    email_verified: true,
    name: 'A',
    picture: 'p'
  }
  const discord = {
    id: 'd1',
    email: 'a@a.com',
    verified: true,
    username: 'a',
    avatar: null
  }

  it('Google já vinculado: 403 e nenhuma sessão', async () => {
    const saveToken = vi.fn()
    const { service } = build({
      findUserByGoogleId: vi
        .fn()
        .mockResolvedValue({ id: 'u1', suspendedAt: SUSPENDED_AT }),
      saveToken
    })

    await expect(service.loginWithGoogle(google, true)).rejects.toMatchObject({
      statusCode: 403
    })
    expect(saveToken).not.toHaveBeenCalled()
  })

  it('Google por e-mail igual: não vincula nem entra', async () => {
    const linkGoogle = vi.fn()
    const saveToken = vi.fn()
    const { service } = build({
      findUserByGoogleId: vi.fn().mockResolvedValue(null),
      findByEmail: vi.fn().mockResolvedValue({
        id: 'u1',
        googleId: null,
        suspendedAt: SUSPENDED_AT
      }),
      linkGoogle,
      saveToken
    })

    await expect(service.loginWithGoogle(google, true)).rejects.toMatchObject({
      statusCode: 403
    })
    expect(linkGoogle).not.toHaveBeenCalled()
    expect(saveToken).not.toHaveBeenCalled()
  })

  it('Discord já vinculado: 403 e nenhuma sessão', async () => {
    const saveToken = vi.fn()
    const { service } = build({
      findByDiscordId: vi
        .fn()
        .mockResolvedValue({ id: 'u1', suspendedAt: SUSPENDED_AT }),
      saveToken
    })

    await expect(service.loginWithDiscord(discord, true)).rejects.toMatchObject(
      { statusCode: 403 }
    )
    expect(saveToken).not.toHaveBeenCalled()
  })

  it('Discord por e-mail igual: não vincula nem entra', async () => {
    const linkDiscord = vi.fn()
    const { service } = build({
      findByDiscordId: vi.fn().mockResolvedValue(null),
      findByEmail: vi.fn().mockResolvedValue({
        id: 'u1',
        discordId: null,
        suspendedAt: SUSPENDED_AT
      }),
      linkDiscord
    })

    await expect(service.loginWithDiscord(discord, true)).rejects.toMatchObject(
      { statusCode: 403 }
    )
    expect(linkDiscord).not.toHaveBeenCalled()
  })
})
