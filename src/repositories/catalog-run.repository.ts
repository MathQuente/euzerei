import { redis } from '../database/redis'

export const LOCK_KEY = 'catalog-run:lock'
export const STATE_KEY = 'catalog-run:state'
export const LOG_KEY = 'catalog-run:log'
export const LOCK_TTL_SECONDS = 90
export const STATE_TTL_SECONDS = 24 * 60 * 60
export const LOG_MAX_LINES = 200

export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface RunState {
  runId: string
  key: string
  mode: 'dry' | 'apply'
  status: RunStatus
  startedAt: string
  finishedAt: string | null
  pid: number | null
  exitCode: number | null
  /** Última linha de progresso (as que terminam em \r, sobrescritas pelo script). */
  progress: string | null
  summary: string | null
  /** Linha de auditoria da execução (nunca sai pela API). */
  auditId?: string | null
}

export interface RunStore {
  acquire(
    runId: string,
    payload: { key: string; mode: string }
  ): Promise<boolean>
  heartbeat(runId: string): Promise<boolean>
  release(runId: string): Promise<void>
  readLock(): Promise<{ runId: string; key: string; mode: string } | null>
  saveState(state: RunState): Promise<void>
  readState(): Promise<RunState | null>
  resetLog(): Promise<void>
  pushLog(line: string): Promise<void>
  readLog(): Promise<string[]>
}

const RENEW_IF_OWNER = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
if cjson.decode(current)['runId'] ~= ARGV[1] then return 0 end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`
const RELEASE_IF_OWNER = `
local current = redis.call('GET', KEYS[1])
if current and cjson.decode(current)['runId'] == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

export class CatalogRunRepository implements RunStore {
  async acquire(runId: string, payload: { key: string; mode: string }) {
    const result = await redis.set(
      LOCK_KEY,
      JSON.stringify({ runId, ...payload }),
      'EX',
      LOCK_TTL_SECONDS,
      'NX'
    )
    return result === 'OK'
  }

  async heartbeat(runId: string) {
    const renewed = await redis.eval(
      RENEW_IF_OWNER,
      1,
      LOCK_KEY,
      runId,
      LOCK_TTL_SECONDS
    )
    return Number(renewed) === 1
  }

  async release(runId: string) {
    await redis.eval(RELEASE_IF_OWNER, 1, LOCK_KEY, runId)
  }

  async readLock() {
    const raw = await redis.get(LOCK_KEY)
    return raw
      ? (JSON.parse(raw) as { runId: string; key: string; mode: string })
      : null
  }

  async saveState(state: RunState) {
    await redis.set(STATE_KEY, JSON.stringify(state), 'EX', STATE_TTL_SECONDS)
  }

  async readState() {
    const raw = await redis.get(STATE_KEY)
    return raw ? (JSON.parse(raw) as RunState) : null
  }

  async resetLog() {
    await redis.del(LOG_KEY)
  }

  async pushLog(line: string) {
    await redis
      .multi()
      .rpush(LOG_KEY, line)
      .ltrim(LOG_KEY, -LOG_MAX_LINES, -1)
      .expire(LOG_KEY, STATE_TTL_SECONDS)
      .exec()
  }

  readLog() {
    return redis.lrange(LOG_KEY, 0, -1)
  }
}
