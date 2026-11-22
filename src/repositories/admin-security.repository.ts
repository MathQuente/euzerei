import { prisma } from '../database/db'
import { redis } from '../database/redis'
import { classifyLoginKey, type LoginKey } from '../utils/admin-security-keys'

export const SCAN_COUNT = 1000
export const SCAN_MAX_CALLS = 40
export const MAX_CANDIDATES = 200

export interface ScannedKey {
  key: string
  login: LoginKey
}

export interface KeyCounter {
  key: string
  count: number
  pttlMs: number
}

export interface SessionTotals {
  sessions: number
  users: number
}

export interface SessionRow {
  id: string
  handle: string
  renewedAt: Date
  expiresAt: Date
}

export interface AdminActor {
  actorId: string
  ip: string
}

export interface SecurityStore {
  scanLoginKeys(): Promise<{ keys: ScannedKey[]; truncated: boolean }>
  counters(keys: string[]): Promise<KeyCounter[]>
  handlesByEmailHash(hashes: string[]): Promise<Map<string, string>>
  sessionTotals(now: Date): Promise<SessionTotals>
  oldestSessions(now: Date, limit: number): Promise<SessionRow[]>
  deleteKey(key: string): Promise<number>
  /** Devolve o handle da sessão encerrada, ou null se ela já não está ativa. */
  revokeSession(
    id: string,
    now: Date,
    actor: AdminActor,
    action: string
  ): Promise<string | null>
  termsPending(version: string): Promise<number>
  emailsPending(): Promise<number>
}

export class AdminSecurityRepository implements SecurityStore {
  async scanLoginKeys() {
    const keys: ScannedKey[] = []
    let cursor = '0'
    let calls = 0
    let truncated = false
    do {
      const [next, batch] = await redis.scan(
        cursor,
        'MATCH',
        '*login*',
        'COUNT',
        SCAN_COUNT
      )
      cursor = next
      calls += 1
      for (const key of batch) {
        const login = classifyLoginKey(key)
        if (!login) continue
        if (keys.length >= MAX_CANDIDATES) {
          truncated = true
          break
        }
        keys.push({ key, login })
      }
      if (calls >= SCAN_MAX_CALLS && cursor !== '0') truncated = true
    } while (cursor !== '0' && calls < SCAN_MAX_CALLS && !truncated)
    return { keys, truncated }
  }

  async counters(keys: string[]): Promise<KeyCounter[]> {
    if (keys.length === 0) return []
    const pipeline = redis.pipeline()
    for (const key of keys) {
      pipeline.get(key)
      pipeline.pttl(key)
    }
    const results = (await pipeline.exec()) ?? []
    const counters: KeyCounter[] = []
    keys.forEach((key, index) => {
      const value = results[index * 2]?.[1]
      const pttlMs = Number(results[index * 2 + 1]?.[1])
      const count = Number(value)
      if (value === null || !Number.isFinite(count) || !(pttlMs > 0)) return
      counters.push({ key, count, pttlMs })
    })
    return counters
  }

  async handlesByEmailHash(hashes: string[]) {
    if (hashes.length === 0) return new Map<string, string>()
    const rows = await prisma.$queryRaw<{ user_name: string; h: string }[]>`
      SELECT user_name, encode(sha256(convert_to(lower(trim(email)), 'UTF8')), 'hex') AS h
      FROM users
      WHERE encode(sha256(convert_to(lower(trim(email)), 'UTF8')), 'hex') = ANY(${hashes}::text[])`
    return new Map(rows.map(row => [row.h, row.user_name]))
  }

  async sessionTotals(now: Date): Promise<SessionTotals> {
    const rows = await prisma.$queryRaw<SessionTotals[]>`
      SELECT count(*)::int AS sessions, count(DISTINCT "userId")::int AS users
      FROM refresh_token
      WHERE "isValid" = true AND "expiresAt" > ${now}`
    return { sessions: rows[0].sessions, users: rows[0].users }
  }

  async oldestSessions(now: Date, limit: number): Promise<SessionRow[]> {
    const rows = await prisma.refreshToken.findMany({
      where: { isValid: true, expiresAt: { gt: now } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        user: { select: { userName: true } }
      }
    })
    return rows.map(row => ({
      id: row.id,
      handle: row.user.userName,
      renewedAt: row.createdAt,
      expiresAt: row.expiresAt
    }))
  }

  deleteKey(key: string) {
    return redis.del(key)
  }

  async revokeSession(
    id: string,
    now: Date,
    actor: AdminActor,
    action: string
  ): Promise<string | null> {
    return prisma.$transaction(async tx => {
      const active = { id, isValid: true, expiresAt: { gt: now } }
      const row = await tx.refreshToken.findFirst({
        where: active,
        select: { user: { select: { userName: true } } }
      })
      if (!row) return null
      const { count } = await tx.refreshToken.updateMany({
        where: active,
        data: { isValid: false }
      })
      if (count !== 1) return null
      await tx.auditLog.create({
        data: {
          actorId: actor.actorId,
          action,
          area: 'USERS',
          target: `@${row.user.userName}`,
          detail: 'a renovação da sessão foi cancelada',
          result: 'OK',
          ip: actor.ip
        }
      })
      return row.user.userName
    })
  }

  termsPending(version: string) {
    return prisma.user.count({
      where: {
        OR: [{ termsVersion: null }, { termsVersion: { not: version } }]
      }
    })
  }

  emailsPending() {
    return prisma.user.count({ where: { emailVerifiedAt: null } })
  }
}
