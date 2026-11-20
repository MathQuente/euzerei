import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fastify, { FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { AuthService } from './auth.service'
import type { AuthRepository } from '../repositories/auth.repository'
import type { CacheRepository } from '../repositories/cache.repository'
import type { EmailService } from './email.service'
import type { RecentAuthService } from './recent-auth.service'

const authRepository = { findToken: vi.fn() }

let app: FastifyInstance
let service: AuthService

function activeRow() {
  return { isValid: true, expiresAt: new Date(Date.now() + 60_000) }
}

beforeAll(async () => {
  app = fastify()
  await app.register(fastifyJwt, {
    secret: 'test-secret-with-more-than-32-characters'
  })
  await app.ready()
  service = new AuthService(
    authRepository as unknown as AuthRepository,
    app.jwt,
    {} as CacheRepository,
    {} as EmailService,
    {} as RecentAuthService
  )
})

afterAll(async () => {
  await app.close()
})

function panelToken() {
  return app.jwt.sign(
    { userId: 'admin-1', tokenType: 'panel', pv: 'fingerprint' },
    { expiresIn: '8h' }
  )
}

describe('a panel token used as a refresh token', () => {
  it('is refused by validateRefreshToken even when the database finds it', async () => {
    authRepository.findToken.mockResolvedValue(activeRow())

    await expect(
      service.validateRefreshToken(panelToken())
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('is not an active refresh token even when the database finds it', async () => {
    authRepository.findToken.mockResolvedValue(activeRow())

    await expect(service.isRefreshTokenActive(panelToken())).resolves.toBeNull()
  })

  it('cannot be exchanged for new tokens', async () => {
    authRepository.findToken.mockResolvedValue(activeRow())

    await expect(service.refreshTokens(panelToken())).rejects.toMatchObject({
      statusCode: 401
    })
  })
})
