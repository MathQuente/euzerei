import type {
  DatabaseConnections,
  HealthProbe
} from '../repositories/admin-health.repository'
import { parseRedisInfo, type RedisInfo } from '../utils/admin-redis-info'
import { createTtlCache } from '../utils/ttl-cache'
import { withTimeout } from '../utils/with-timeout'

export const HEALTH_TTL_MS = 10_000
export const HEALTH_CHECK_TIMEOUT_MS = 2_000

type CheckStatus = 'ok' | 'down'

async function timed<T>(read: () => Promise<T>, timeoutMs: number) {
  const startedAt = Date.now()
  try {
    const value = await withTimeout(
      Promise.resolve().then(read),
      timeoutMs,
      'timeout'
    )
    return {
      status: 'ok' as CheckStatus,
      latencyMs: Date.now() - startedAt,
      value
    }
  } catch {
    return { status: 'down' as CheckStatus, latencyMs: null, value: null }
  }
}

export class AdminHealthService {
  private cached = createTtlCache(HEALTH_TTL_MS)

  constructor(
    private probe: HealthProbe,
    private uptimeSeconds: () => number = () => process.uptime(),
    private checkTimeoutMs: number = HEALTH_CHECK_TIMEOUT_MS
  ) {}

  health(now: Date = new Date()) {
    return this.cached('health', () => this.build(now))
  }

  private async build(now: Date) {
    const [database, redis] = await Promise.all([
      timed<DatabaseConnections>(
        () => this.probe.connections(),
        this.checkTimeoutMs
      ),
      timed<RedisInfo>(
        async () => parseRedisInfo(await this.probe.redisInfo()),
        this.checkTimeoutMs
      )
    ])
    const uptime = Math.floor(this.uptimeSeconds())

    return {
      generatedAt: now.toISOString(),
      api: {
        status: 'ok' as const,
        startedAt: new Date(now.getTime() - uptime * 1000).toISOString(),
        uptimeSeconds: uptime
      },
      database: {
        status: database.status,
        latencyMs: database.latencyMs,
        connections: database.value
      },
      redis: {
        status: redis.status,
        latencyMs: redis.latencyMs,
        usedMemoryBytes: redis.value?.usedMemoryBytes ?? null,
        maxMemoryBytes: redis.value?.maxMemoryBytes ?? null,
        evictedKeys: redis.value?.evictedKeys ?? null
      }
    }
  }
}
