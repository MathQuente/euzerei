import { prisma } from '../database/db'
import { redis } from '../database/redis'

export interface DatabaseConnections {
  used: number
  max: number
}

export interface HealthProbe {
  connections(): Promise<DatabaseConnections>
  redisInfo(): Promise<string>
}

export class AdminHealthRepository implements HealthProbe {
  async connections(): Promise<DatabaseConnections> {
    const rows = await prisma.$queryRaw<DatabaseConnections[]>`
      SELECT
        (SELECT count(*)::int FROM pg_stat_activity) AS used,
        current_setting('max_connections')::int AS max`
    return { used: rows[0].used, max: rows[0].max }
  }

  redisInfo() {
    return redis.info()
  }
}
