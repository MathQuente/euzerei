import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import fastify, { FastifyInstance } from 'fastify'
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod'

vi.mock('../database/db', () => ({ prisma: {} }))
vi.mock('../database/redis', () => ({ redis: {} }))

const cache = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }))
const authRepository = vi.hoisted(() => ({ findToken: vi.fn() }))
vi.mock('../repositories/cache.repository', () => ({
  CacheRepository: class {
    get = cache.get
    mget = (keys: string[]) => Promise.all(keys.map(key => cache.get(key)))
    set = cache.set
    del = cache.del
  }
}))
vi.mock('../repositories/auth.repository', () => ({
  AuthRepository: class {
    findToken = authRepository.findToken
  }
}))

const reviewService = vi.hoisted(() => ({ findCommunityReviews: vi.fn() }))
vi.mock('../services/review.service', () => ({
  ReviewService: class {
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

import { Jwt } from '../jwt'
import { reviewRoutes } from './review'

const AUTHOR = '3f1c1d8e-5b0a-4f4e-9b1a-0a1b2c3d4e5f'
const URL = '/reviews/1942/community'

function row(reportedByMe: boolean) {
  return {
    userId: AUTHOR,
    userName: 'autor',
    profilePicture: null,
    rating: 4,
    hoursPlayed: 10,
    completions: 1,
    status: 'PLAYED',
    endless: false,
    text: 'texto',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    reportedByMe
  }
}

let app: FastifyInstance

function accessCookie(userId = 'viewer-1') {
  return `accessToken=${app.jwt.sign({ userId, tokenType: 'access' })}`
}

function viewerPassedToService() {
  return reviewService.findCommunityReviews.mock.calls[0][3]
}

beforeAll(async () => {
  process.env.SECRET_JWT_KEY = 'test-secret-with-more-than-32-characters'
  process.env.FRONTEND_URL = 'http://localhost:5173'

  app = fastify()
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  Jwt.initSetup(app)
  await app.register(reviewRoutes, { prefix: '/reviews' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

beforeEach(() => {
  cache.get.mockReset().mockResolvedValue(null)
  authRepository.findToken.mockReset()
  reviewService.findCommunityReviews
    .mockReset()
    .mockResolvedValue({ reviews: [row(false)], total: 1 })
})

describe('GET /reviews/:igdbId/community', () => {
  it('stays public: a stranger gets 200 and the service sees no viewer', async () => {
    const response = await app.inject({ method: 'GET', url: URL })

    expect(response.statusCode).toBe(200)
    expect(viewerPassedToService()).toBeNull()
    expect(response.json().reviews[0].reportedByMe).toBe(false)
  })

  it('hands the signed-in user id to the service, never a client-chosen one', async () => {
    reviewService.findCommunityReviews.mockResolvedValue({
      reviews: [row(true)],
      total: 1
    })

    const response = await app.inject({
      method: 'GET',
      url: `${URL}?viewerId=someone-else`,
      headers: { cookie: accessCookie('viewer-1') }
    })

    expect(response.statusCode).toBe(200)
    expect(viewerPassedToService()).toBe('viewer-1')
    expect(response.json().reviews[0].reportedByMe).toBe(true)
  })

  it('answers false to a signed-in user who has not reported', async () => {
    const response = await app.inject({
      method: 'GET',
      url: URL,
      headers: { cookie: accessCookie() }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().reviews[0].reportedByMe).toBe(false)
  })

  it.each([
    ['a garbage token', 'accessToken=not-a-jwt'],
    ['a malformed token', 'accessToken=a.b.c']
  ])('treats %s as a stranger, with no error', async (_name, cookie) => {
    const response = await app.inject({
      method: 'GET',
      url: URL,
      headers: { cookie }
    })

    expect(response.statusCode).toBe(200)
    expect(viewerPassedToService()).toBeNull()
  })

  it('treats a revoked session as a stranger', async () => {
    cache.get.mockResolvedValue('revoked')

    const response = await app.inject({
      method: 'GET',
      url: URL,
      headers: { cookie: accessCookie() }
    })

    expect(response.statusCode).toBe(200)
    expect(viewerPassedToService()).toBeNull()
  })

  it('treats a refresh token sent as the access token as a stranger', async () => {
    const refresh = app.jwt.sign(
      { userId: 'viewer-1', tokenType: 'refresh', jti: 'x' },
      { expiresIn: '7d' }
    )

    const response = await app.inject({
      method: 'GET',
      url: URL,
      headers: { cookie: `accessToken=${refresh}` }
    })

    expect(response.statusCode).toBe(200)
    expect(viewerPassedToService()).toBeNull()
  })

  it('treats a failing session store as a stranger instead of failing the page', async () => {
    cache.get.mockRejectedValue(new Error('redis down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await app.inject({
      method: 'GET',
      url: URL,
      headers: { cookie: accessCookie() }
    })
    spy.mockRestore()

    expect(response.statusCode).toBe(200)
    expect(viewerPassedToService()).toBeNull()
  })

  it('varies on Cookie so a shared cache cannot mix people', async () => {
    const stranger = await app.inject({ method: 'GET', url: URL })
    const signedIn = await app.inject({
      method: 'GET',
      url: URL,
      headers: { cookie: accessCookie() }
    })

    expect(stranger.headers.vary).toMatch(/cookie/i)
    expect(signedIn.headers.vary).toMatch(/cookie/i)
  })

  it('exposes nothing new: the row keeps only the public fields plus reportedByMe', async () => {
    const response = await app.inject({ method: 'GET', url: URL })

    expect(Object.keys(response.json().reviews[0]).sort()).toEqual(
      [
        'completions',
        'createdAt',
        'endless',
        'hoursPlayed',
        'profilePicture',
        'rating',
        'reportedByMe',
        'status',
        'text',
        'userId',
        'userName'
      ].sort()
    )
  })
})
