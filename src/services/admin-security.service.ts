import type { SecurityStore } from '../repositories/admin-security.repository'
import { withReadLimit } from '../utils/admin-read-limit'
import {
  blockLimit,
  isBlocked,
  shortRef,
  type LoginKey
} from '../utils/admin-security-keys'
import {
  LOGIN_FAILURES_PER_EMAIL,
  LOGIN_FAILURES_PER_IP,
  LOGIN_FAILURES_WINDOW_MINUTES,
  LOGIN_ROUTE_LIMIT,
  MAX_SESSIONS_PER_USER,
  RECENT_AUTH_MINUTES
} from '../utils/admin-security-limits'
import { TERMS_VERSION } from '../utils/terms'
import { createTtlCache } from '../utils/ttl-cache'

export const SECURITY_TTL_MS = 30_000
export const BLOCKS_LIMIT = 50
export const SESSIONS_LIMIT = 10
const UNAVAILABLE = 'Não foi possível ler a segurança agora.'

export type SecurityEnv = Record<string, string | undefined>

export function isTrustProxyOn(value: string | undefined): boolean {
  if (!value || value === 'false') return false
  return !(/^\d+$/.test(value) && Number(value) === 0)
}

function routeOf(key: LoginKey) {
  return key.kind === 'ip' ? key.route : null
}

export class AdminSecurityService {
  private cached = createTtlCache(SECURITY_TTL_MS)

  constructor(
    private store: SecurityStore,
    private env: SecurityEnv = process.env
  ) {}

  blocks(now: Date = new Date()) {
    return this.cached('blocks', () =>
      withReadLimit(() => this.buildBlocks(now), UNAVAILABLE)
    )
  }

  private async buildBlocks(now: Date) {
    const { keys, truncated } = await this.store.scanLoginKeys()
    const counters = await this.store.counters(keys.map(entry => entry.key))
    const byKey = new Map(keys.map(entry => [entry.key, entry.login]))

    const blocked = counters
      .map(counter => ({ counter, login: byKey.get(counter.key)! }))
      .filter(({ counter, login }) => isBlocked(login, counter.count))
      .sort(
        (a, b) =>
          b.counter.count - a.counter.count ||
          b.counter.pttlMs - a.counter.pttlMs
      )

    const shown = blocked.slice(0, BLOCKS_LIMIT)
    const hashes = [
      ...new Set(
        shown.flatMap(({ login }) =>
          login.kind === 'ip' ? [] : [login.emailHash]
        )
      )
    ]
    const handles = await this.store.handlesByEmailHash(hashes)

    return {
      generatedAt: now.toISOString(),
      total: blocked.length,
      truncated: truncated || blocked.length > BLOCKS_LIMIT,
      items: shown.map(({ counter, login }) => ({
        kind: login.kind,
        route: routeOf(login),
        target:
          login.kind === 'ip'
            ? login.ip
            : (handles.get(login.emailHash) ?? null),
        ref: login.kind === 'ip' ? null : shortRef(login.emailHash),
        count: counter.count,
        limit: blockLimit(login),
        expiresInSeconds: Math.ceil(counter.pttlMs / 1000)
      }))
    }
  }

  summary(now: Date = new Date()) {
    return this.cached('summary', () =>
      withReadLimit(() => this.buildSummary(now), UNAVAILABLE)
    )
  }

  private async buildSummary(now: Date) {
    const [blocks, sessions, terms, emails] = await Promise.allSettled([
      this.blocks(now),
      this.store.sessionTotals(now),
      this.store.termsPending(TERMS_VERSION),
      this.store.emailsPending()
    ])
    const value = <T>(result: PromiseSettledResult<T>) =>
      result.status === 'fulfilled' ? result.value : null
    const blockList = value(blocks)
    const sessionTotals = value(sessions)
    const termsPending = value(terms)

    return {
      generatedAt: now.toISOString(),
      blocks: blockList
        ? { active: blockList.total, truncated: blockList.truncated }
        : null,
      sessions: sessionTotals,
      terms:
        termsPending === null
          ? null
          : { version: TERMS_VERSION, pending: termsPending },
      emailsPending: value(emails)
    }
  }

  sessions(now: Date = new Date()) {
    return this.cached('sessions', () =>
      withReadLimit(() => this.buildSessions(now), UNAVAILABLE)
    )
  }

  private async buildSessions(now: Date) {
    const [totals, rows] = await Promise.all([
      this.store.sessionTotals(now),
      this.store.oldestSessions(now, SESSIONS_LIMIT)
    ])
    return {
      generatedAt: now.toISOString(),
      total: totals.sessions,
      users: totals.users,
      items: rows.map(row => ({
        handle: row.handle,
        renewedAt: row.renewedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString()
      }))
    }
  }

  protections(now: Date = new Date()) {
    const secret = this.env.ORIGIN_SECRET
    const proxy = this.env.TRUST_PROXY
    return {
      generatedAt: now.toISOString(),
      originSecret: { enabled: Boolean(secret) },
      trustProxy: { enabled: isTrustProxyOn(proxy) },
      loginPerMinute: LOGIN_ROUTE_LIMIT,
      loginFailures: {
        perIp: LOGIN_FAILURES_PER_IP,
        perEmail: LOGIN_FAILURES_PER_EMAIL,
        windowMinutes: LOGIN_FAILURES_WINDOW_MINUTES
      },
      commonPasswordsBlocked: true,
      recentAuthMinutes: RECENT_AUTH_MINUTES,
      emailVerificationRequired: false,
      maxSessionsPerUser: MAX_SESSIONS_PER_USER
    }
  }
}
