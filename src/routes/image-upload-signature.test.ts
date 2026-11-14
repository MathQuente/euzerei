import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fastify, { FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import fastifyCookie from '@fastify/cookie'
import fastifyRateLimit from '@fastify/rate-limit'
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider
} from 'fastify-type-provider-zod'
import { errorHandler } from '../error-handler'
import { ErrorSchemas } from '../schemas/error.schema'
import * as UserSchema from '../schemas/user.schema'
import { CloudinaryService } from '../services/cloudinary.service'
import { userRateLimit } from '../utils/user-rate-limit'
import { respondUnauthorized } from '../utils/respond-unauthorized'

const SECRET = 'a'.repeat(40)

async function buildApp() {
  const app = fastify()
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.setErrorHandler(errorHandler)
  await app.register(fastifyCookie)
  await app.register(fastifyJwt, {
    secret: SECRET,
    cookie: { cookieName: 'accessToken', signed: false }
  })
  await app.register(fastifyRateLimit, { max: 300, timeWindow: '1 minute' })

  app.decorate('authenticate', async (request, reply) => {
    try {
      await request.jwtVerify({ onlyCookie: true })
    } catch {
      return respondUnauthorized(reply)
    }
  })

  app.withTypeProvider<ZodTypeProvider>().post(
    '/image-upload-signature',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: userRateLimit('image-upload', 10) },
      schema: {
        response: {
          200: UserSchema.ImageUploadSignatureResponseSchema,
          503: ErrorSchemas.InternalServerError
        }
      }
    },
    async (_request, reply) =>
      reply.status(200).send(CloudinaryService.createUploadSignature())
  )
  await app.ready()
  return app
}

describe('POST /image-upload-signature', () => {
  let app: FastifyInstance

  const cookieFor = (userId: string) => ({
    accessToken: app.jwt.sign({ userId, tokenType: 'access' })
  })
  const call = (userId?: string) =>
    app.inject({
      method: 'POST',
      url: '/image-upload-signature',
      remoteAddress: '10.0.0.1',
      cookies: userId ? cookieFor(userId) : {}
    })

  beforeEach(async () => {
    vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'mycloud')
    vi.stubEnv('CLOUDINARY_API_KEY', 'key')
    vi.stubEnv('CLOUDINARY_API_SECRET', 'topsecret')
    vi.stubEnv('CLOUDINARY_UPLOAD_PRESET', 'signed_preset')
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

  it('answers 200 with the signed fields, a fixed folder and no secret', async () => {
    const response = await call('user-a')

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(Object.keys(body).sort()).toEqual([
      'allowedFormats',
      'apiKey',
      'cloudName',
      'folder',
      'signature',
      'timestamp',
      'uploadPreset'
    ])
    expect(body.folder).toBe('images')
    expect(body.signature).toMatch(/^[0-9a-f]{40}$/)
    expect(response.body).not.toContain('topsecret')
  })

  it('limits per user, not per IP', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await call('user-a')).statusCode).toBe(200)
    }
    expect((await call('user-a')).statusCode).toBe(429)
    expect((await call('user-b')).statusCode).toBe(200)
  })

  it('answers 503 when the environment is incomplete', async () => {
    vi.stubEnv('CLOUDINARY_UPLOAD_PRESET', '')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await call('user-a')

    expect(response.statusCode).toBe(503)
    expect(response.json().message).toBeTruthy()
  })
})
