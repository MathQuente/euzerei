import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fastify, { FastifyInstance } from 'fastify'
import fastifyRateLimit from '@fastify/rate-limit'
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod'

vi.mock('../database/db', () => ({ prisma: {} }))
vi.mock('../database/redis', () => ({ redis: {} }))
vi.mock('../repositories/cache.repository', () => ({
  CacheRepository: class {
    get = vi.fn().mockResolvedValue(null)
    set = vi.fn()
  }
}))

import { errorHandler } from '../error-handler'
import { Jwt } from '../jwt'
import { AuthService } from '../services/auth.service'
import { userRoutes } from './users'

const GOOD_REFRESH = 'good-refresh-token'

async function buildApp() {
  const app = fastify()
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.setErrorHandler(errorHandler)
  Jwt.initSetup(app)
  await app.register(fastifyRateLimit, { max: 300, timeWindow: '1 minute' })
  await app.register(userRoutes, { prefix: '/users' })
  await app.ready()
  return app
}

describe('POST /users/image-upload-signature', () => {
  let app: FastifyInstance

  const accessFor = (userId: string) =>
    app.jwt.sign({ userId, tokenType: 'access' })
  const call = (
    cookies: Record<string, string> = {},
    remoteAddress = '10.0.0.1'
  ) =>
    app.inject({
      method: 'POST',
      url: '/users/image-upload-signature',
      remoteAddress,
      cookies
    })

  beforeEach(async () => {
    vi.stubEnv('SECRET_JWT_KEY', 'a'.repeat(40))
    vi.stubEnv('FRONTEND_URL', 'http://localhost:5173')
    vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'mycloud')
    vi.stubEnv('CLOUDINARY_API_KEY', 'key')
    vi.stubEnv('CLOUDINARY_API_SECRET', 'topsecret')
    vi.stubEnv('CLOUDINARY_UPLOAD_PRESET', 'signed_preset')
    vi.spyOn(AuthService.prototype, 'isRefreshTokenActive').mockImplementation(
      async token => (token === GOOD_REFRESH ? 'user-r' : null)
    )
    app = await buildApp()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await app.close()
  })

  it('answers 401 without a session', async () => {
    expect((await call()).statusCode).toBe(401)
  })

  it('answers 200 with the signed fields, a fixed folder, an id and no secret', async () => {
    const response = await call({ accessToken: accessFor('user-a') })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(Object.keys(body).sort()).toEqual([
      'allowedFormats',
      'apiKey',
      'cloudName',
      'folder',
      'publicId',
      'signature',
      'timestamp',
      'uploadPreset'
    ])
    expect(body.folder).toBe('images')
    expect(body.publicId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.signature).toMatch(/^[0-9a-f]{40}$/)
    expect(response.body).not.toContain('topsecret')
  })

  it('limits per user, not per IP', async () => {
    const a = { accessToken: accessFor('user-a') }
    for (let i = 0; i < 10; i++) {
      expect((await call(a, `10.0.0.${i + 1}`)).statusCode).toBe(200)
    }
    expect((await call(a, '10.0.1.1')).statusCode).toBe(429)
    expect(
      (await call({ accessToken: accessFor('user-b') }, '10.0.0.1')).statusCode
    ).toBe(200)
  })

  it('limits a session renewed from the refresh cookie per user too', async () => {
    const refreshOnly = { refreshToken: GOOD_REFRESH }
    for (let i = 0; i < 10; i++) {
      expect((await call(refreshOnly, `10.0.0.${i + 1}`)).statusCode).toBe(200)
    }
    expect((await call(refreshOnly, '10.0.2.1')).statusCode).toBe(429)
  })

  it('answers 503 with a message when the preset is not configured', async () => {
    vi.stubEnv('CLOUDINARY_UPLOAD_PRESET', '')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await call({ accessToken: accessFor('user-a') })

    expect(response.statusCode).toBe(503)
    expect(response.json().message).toBeTruthy()
  })
})
