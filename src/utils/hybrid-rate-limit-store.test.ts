import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fastify, { FastifyInstance } from 'fastify'
import fastifyRateLimit from '@fastify/rate-limit'
import type { Redis } from 'ioredis'
import { createHybridRateLimitStore } from './hybrid-rate-limit-store'

// Roda o plugin de verdade; só o Redis é falso (conta cada comando de limite que chegaria a ele).
function fakeRedis() {
  const counters = new Map<string, number>()
  const rateLimit = vi.fn(
    (
      key: string,
      timeWindow: number,
      _max: number,
      _continueExceeding: boolean,
      _exponentialBackoff: boolean,
      cb: (error: Error | null, result: [number, number]) => void
    ) => {
      const current = (counters.get(key) ?? 0) + 1
      counters.set(key, current)
      cb(null, [current, timeWindow])
    }
  )
  return { rateLimit, rateLimitRead: vi.fn() }
}

let app: FastifyInstance
let redis: ReturnType<typeof fakeRedis>

beforeEach(async () => {
  redis = fakeRedis()
  app = fastify()
  await app.register(fastifyRateLimit, {
    max: 3,
    timeWindow: '1 minute',
    store: createHybridRateLimitStore(redis as unknown as Redis)
  })
  app.get('/plain', async () => ({ ok: true }))
  app.get('/health', { config: { rateLimit: false } }, async () => ({
    ok: true
  }))
  await app.register(
    async routes => {
      routes.post(
        '/login',
        { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } },
        async () => ({ ok: true })
      )
    },
    { prefix: '/auth' }
  )
  await app.ready()
})

afterEach(() => app.close())

describe('hybrid rate limit store', () => {
  it('counts a route without its own limit in memory and never touches Redis', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) {
      statuses.push((await app.inject({ url: '/plain' })).statusCode)
    }

    expect(statuses).toEqual([200, 200, 200, 429])
    expect(redis.rateLimit).not.toHaveBeenCalled()
  })

  it('keeps a route with its own limit in Redis, under the key the Security screen reads', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 3; i++) {
      statuses.push(
        (await app.inject({ method: 'POST', url: '/auth/login' })).statusCode
      )
    }

    expect(statuses).toEqual([200, 200, 429])
    expect(redis.rateLimit).toHaveBeenCalledTimes(3)
    expect(redis.rateLimit.mock.calls[0][0]).toBe(
      'rate-limitPOST/auth/login-127.0.0.1'
    )
  })

  it('does not limit a route that turns the limit off', async () => {
    for (let i = 0; i < 6; i++) {
      expect((await app.inject({ url: '/health' })).statusCode).toBe(200)
    }
    expect(redis.rateLimit).not.toHaveBeenCalled()
  })
})
