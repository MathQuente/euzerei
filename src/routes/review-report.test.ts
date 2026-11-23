import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fastify, { FastifyInstance } from 'fastify'
import fastifyRateLimit from '@fastify/rate-limit'
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod'

vi.mock('../database/db', () => ({ prisma: {} }))
vi.mock('../database/redis', () => ({ redis: {} }))

const reviewService = vi.hoisted(() => ({
  reportReview: vi.fn(),
  upsertReview: vi.fn(),
  findOwnReview: vi.fn(),
  deleteReview: vi.fn(),
  findCommunityReviews: vi.fn()
}))
vi.mock('../services/review.service', () => ({
  ReviewService: class {
    reportReview = reviewService.reportReview
    upsertReview = reviewService.upsertReview
    findOwnReview = reviewService.findOwnReview
    deleteReview = reviewService.deleteReview
    findCommunityReviews = reviewService.findCommunityReviews
  }
}))
vi.mock('../repositories/review.repository', () => ({
  ReviewRepository: class {}
}))
vi.mock('../repositories/users.repository', () => ({
  UserRepository: class {}
}))
vi.mock('../repositories/game-cache.repository', () => ({
  GameCacheRepository: class {}
}))
vi.mock('../services/game-cache.service', () => ({
  GameCacheService: class {}
}))

import { errorHandler } from '../error-handler'
import { ClientError } from '../errors/client-error'
import { reviewRoutes } from './review'

const AUTHOR = '3f1c1d8e-5b0a-4f4e-9b1a-0a1b2c3d4e5f'
const URL = `/reviews/1942/authors/${AUTHOR}/reports`

async function buildApp(signedIn: boolean) {
  const app = fastify()
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.setErrorHandler(errorHandler)
  app.decorate('authenticate', async (request, reply) => {
    if (!signedIn) return reply.status(401).send({ status: 'unauthorized' })
    ;(request as { user?: unknown }).user = { userId: 'reporter-1' }
  })
  await app.register(fastifyRateLimit, { max: 300, timeWindow: '1 minute' })
  await app.register(reviewRoutes, { prefix: '/reviews' })
  await app.ready()
  return app
}

describe('POST /reviews/:igdbId/authors/:authorId/reports', () => {
  let app: FastifyInstance

  beforeEach(() => {
    reviewService.reportReview.mockReset().mockResolvedValue({ reported: true })
  })
  afterEach(async () => {
    await app?.close()
  })

  it('answers 401 to a stranger, even with a body that would be a 400', async () => {
    app = await buildApp(false)

    const good = await app.inject({
      method: 'POST',
      url: URL,
      payload: { reason: 'SPAM' }
    })
    const bad = await app.inject({
      method: 'POST',
      url: '/reviews/abc/authors/nope/reports',
      payload: { reason: 'banana' }
    })

    expect(good.statusCode).toBe(401)
    expect(bad.statusCode).toBe(401)
    expect(reviewService.reportReview).not.toHaveBeenCalled()
  })

  it('reports with the signed-in user as the reporter', async () => {
    app = await buildApp(true)

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { reason: 'SPOILER' }
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ reported: true })
    expect(reviewService.reportReview).toHaveBeenCalledWith(
      1942,
      AUTHOR,
      'reporter-1',
      'SPOILER'
    )
  })

  it.each([{ reason: 'banana' }, { reason: 'spam' }, {}])(
    'rejects the body %j with a 400 for a signed-in user',
    async payload => {
      app = await buildApp(true)

      const response = await app.inject({ method: 'POST', url: URL, payload })

      expect(response.statusCode).toBe(400)
      expect(reviewService.reportReview).not.toHaveBeenCalled()
    }
  )

  it('never keeps free text: an extra field is dropped before the service', async () => {
    app = await buildApp(true)

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { reason: 'SPAM', text: 'free text' }
    })

    expect(response.statusCode).toBe(201)
    expect(reviewService.reportReview.mock.calls[0]).toEqual([
      1942,
      AUTHOR,
      'reporter-1',
      'SPAM'
    ])
  })

  it('rejects an author id that is not a uuid', async () => {
    app = await buildApp(true)

    const response = await app.inject({
      method: 'POST',
      url: '/reviews/1942/authors/x/reports',
      payload: { reason: 'SPAM' }
    })

    expect(response.statusCode).toBe(400)
  })

  it.each([403, 404, 409])(
    'passes a %i from the service through',
    async code => {
      reviewService.reportReview.mockRejectedValue(new ClientError('x', code))
      app = await buildApp(true)

      const response = await app.inject({
        method: 'POST',
        url: URL,
        payload: { reason: 'SPAM' }
      })

      expect(response.statusCode).toBe(code)
    }
  )

  it('limits one account to 10 reports per hour and counts per account, not per IP', async () => {
    app = await buildApp(true)
    const send = (remoteAddress: string) =>
      app.inject({
        method: 'POST',
        url: URL,
        remoteAddress,
        payload: { reason: 'SPAM' }
      })

    const codes: number[] = []
    for (let i = 0; i < 11; i++)
      codes.push((await send(`10.0.0.${i}`)).statusCode)

    expect(codes.slice(0, 10).every(code => code === 201)).toBe(true)
    expect(codes[10]).toBe(429)
    expect(reviewService.reportReview).toHaveBeenCalledTimes(10)
  })
})
