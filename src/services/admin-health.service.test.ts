import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  AdminHealthService,
  HEALTH_CHECK_TIMEOUT_MS
} from './admin-health.service'
import type { HealthProbe } from '../repositories/admin-health.repository'

const now = new Date('2026-11-21T15:00:00.000Z')
const INFO = 'used_memory:41000000\r\nmaxmemory:0\r\nevicted_keys:3\r\n'

function setup(probe: Partial<HealthProbe> = {}, uptime = 3600) {
  const full: HealthProbe = {
    connections: vi.fn(async () => ({ used: 12, max: 40 })),
    redisInfo: vi.fn(async () => INFO),
    ...probe
  }
  return { service: new AdminHealthService(full, () => uptime), probe: full }
}

describe('AdminHealthService.health', () => {
  afterEach(() => vi.useRealTimers())

  it('answers the api, the database and redis', async () => {
    const { service } = setup()

    const health = await service.health(now)

    expect(health.generatedAt).toBe(now.toISOString())
    expect(health.api).toEqual({
      status: 'ok',
      startedAt: '2026-11-21T14:00:00.000Z',
      uptimeSeconds: 3600
    })
    expect(health.database).toMatchObject({
      status: 'ok',
      connections: { used: 12, max: 40 }
    })
    expect(health.redis).toMatchObject({
      status: 'ok',
      usedMemoryBytes: 41_000_000,
      maxMemoryBytes: null,
      evictedKeys: 3
    })
    expect(health.database.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('a database that fails is down and redis still answers', async () => {
    const { service } = setup({
      connections: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432')
      })
    })

    const health = await service.health(now)

    expect(health.database).toEqual({
      status: 'down',
      latencyMs: null,
      connections: null
    })
    expect(health.redis.status).toBe('ok')
    expect(JSON.stringify(health)).not.toContain('ECONNREFUSED')
  })

  it('a redis that never answers is down after the check limit, never a hang', async () => {
    vi.useFakeTimers()
    const { service } = setup({ redisInfo: () => new Promise<never>(() => {}) })

    const pending = service.health(now)
    await vi.advanceTimersByTimeAsync(HEALTH_CHECK_TIMEOUT_MS)
    const health = await pending

    expect(health.redis).toMatchObject({ status: 'down', latencyMs: null })
    expect(health.database.status).toBe('ok')
  })

  it('a probe that throws synchronously is down too', async () => {
    const { service } = setup({
      redisInfo: () => {
        throw new Error('boom')
      }
    })

    expect((await service.health(now)).redis.status).toBe('down')
  })

  it('shares one read inside the cache window', async () => {
    const { service, probe } = setup()
    await service.health(now)
    await service.health(now)

    expect(probe.redisInfo).toHaveBeenCalledTimes(1)
    expect(probe.connections).toHaveBeenCalledTimes(1)
  })
})
