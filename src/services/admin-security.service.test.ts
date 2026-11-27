import { describe, it, expect, vi, afterEach } from 'vitest'
import { AdminSecurityService, BLOCKS_LIMIT } from './admin-security.service'
import { READ_TIMEOUT_MS } from '../utils/admin-read-limit'
import { blockId, classifyLoginKey } from '../utils/admin-security-keys'
import type { AuditEntryInput } from '../repositories/audit.repository'
import type {
  KeyCounter,
  SecurityStore
} from '../repositories/admin-security.repository'
import { TERMS_VERSION } from '../utils/terms'

const now = new Date('2026-11-21T15:00:00.000Z')
const EMAIL_A = 'a'.repeat(64)
const EMAIL_B = 'b'.repeat(64)
const IP_HASH = 'c'.repeat(64)

function scanned(...keys: string[]) {
  return {
    keys: keys.map(key => ({ key, login: classifyLoginKey(key)! })),
    truncated: false
  }
}

function setup(
  counters: KeyCounter[],
  keys: string[] = counters.map(c => c.key),
  overrides: Partial<SecurityStore> = {}
) {
  const store: SecurityStore = {
    scanLoginKeys: vi.fn(async () => scanned(...keys)),
    counters: vi.fn(async () => counters),
    handlesByEmailHash: vi.fn(async () => new Map([[EMAIL_A, 'kenzo']])),
    sessionTotals: vi.fn(async () => ({ sessions: 214, users: 180 })),
    oldestSessions: vi.fn(async () => [
      {
        id: '7d71976e-7b52-4bee-92f1-a2b198d62431',
        handle: 'maria.rpg',
        renewedAt: new Date('2026-11-14T10:00:00.000Z'),
        expiresAt: new Date('2026-11-21T10:00:00.000Z')
      }
    ]),
    deleteKey: vi.fn(async () => 1),
    revokeSession: vi.fn(async () => 'maria.rpg'),
    termsPending: vi.fn(async () => 58),
    emailsPending: vi.fn(async () => 9),
    loginHours: vi.fn(async () => []),
    loginsEarliest: vi.fn(async () => null),
    purgeLoginAttempts: vi.fn(async () => 0),
    ...overrides
  }
  return { service: new AdminSecurityService(store, {}), store }
}

const ipCounter = (ip: string, count: number, pttlMs = 41_000): KeyCounter => ({
  key: `rate-limitPOST/auth/login-${ip}`,
  count,
  pttlMs
})

describe('AdminSecurityService.blocks', () => {
  afterEach(() => vi.useRealTimers())

  it('lists only what is really blocked, most requests first', async () => {
    const { service } = setup([
      ipCounter('1.1.1.1', 3),
      ipCounter('187.4.22.91', 12, 41_200),
      ipCounter('2.2.2.2', 4, 10_000),
      { key: `login-failures:${EMAIL_A}`, count: 49, pttlMs: 5_000 },
      { key: `login-failures:${EMAIL_A}:${IP_HASH}`, count: 10, pttlMs: 61_000 }
    ])

    const result = await service.blocks(now)

    expect(result.total).toBe(3)
    expect(result.items.map(i => [i.kind, i.count])).toEqual([
      ['ip', 12],
      ['email-ip', 10],
      ['ip', 4]
    ])
    expect(result.items[0]).toEqual({
      id: blockId('rate-limitPOST/auth/login-187.4.22.91'),
      kind: 'ip',
      route: 'login',
      target: '187.4.22.91',
      ref: null,
      count: 12,
      limit: 3,
      expiresInSeconds: 42
    })
  })

  it('turns an e-mail hash into the handle and keeps only a short ref', async () => {
    const { service } = setup([
      { key: `login-failures:${EMAIL_A}`, count: 50, pttlMs: 600_000 },
      { key: `login-failures:${EMAIL_B}`, count: 50, pttlMs: 600_000 }
    ])

    const { items } = await service.blocks(now)

    expect(items.find(i => i.ref === 'aaaaaa')).toMatchObject({
      kind: 'email',
      target: 'kenzo',
      limit: 50
    })
    expect(items.find(i => i.ref === 'bbbbbb')).toMatchObject({ target: null })
  })

  it('never carries the full hash, an e-mail or the ip hash', async () => {
    const { service } = setup([
      { key: `login-failures:${EMAIL_A}:${IP_HASH}`, count: 12, pttlMs: 60_000 }
    ])

    const text = JSON.stringify(await service.blocks(now))

    expect(text).not.toContain(EMAIL_A)
    expect(text).not.toContain(IP_HASH)
    expect(text).not.toContain('@')
  })

  it('says which login route the ip was blocked on', async () => {
    const { service } = setup([
      {
        key: 'rate-limitPOST/panel/auth/login-9.9.9.9',
        count: 5,
        pttlMs: 9_000
      }
    ])

    expect((await service.blocks(now)).items[0]?.route).toBe('panel')
  })

  it('no block is an empty list, not an error', async () => {
    const { service, store } = setup([])

    expect(await service.blocks(now)).toMatchObject({
      total: 0,
      items: [],
      truncated: false
    })
    expect(store.handlesByEmailHash).toHaveBeenCalledWith([])
  })

  it('caps the list, keeps the real total and flags it as truncated', async () => {
    const counters = Array.from({ length: BLOCKS_LIMIT + 5 }, (_, n) =>
      ipCounter(`10.0.0.${n}`, 100 - n)
    )
    const { service } = setup(counters)

    const result = await service.blocks(now)

    expect(result.items).toHaveLength(BLOCKS_LIMIT)
    expect(result.total).toBe(BLOCKS_LIMIT + 5)
    expect(result.truncated).toBe(true)
  })

  it('a scan that hit its cap is flagged as truncated', async () => {
    const store = setup([]).store
    store.scanLoginKeys = vi.fn(async () => ({ keys: [], truncated: true }))

    const result = await new AdminSecurityService(store, {}).blocks(now)

    expect(result.truncated).toBe(true)
  })

  it('shares one scan inside the cache window', async () => {
    const { service, store } = setup([])
    await service.blocks(now)
    await service.blocks(now)

    expect(store.scanLoginKeys).toHaveBeenCalledTimes(1)
  })

  it('gives up after the limit with a 503 instead of hanging', async () => {
    vi.useFakeTimers()
    const store = setup([]).store
    store.scanLoginKeys = () => new Promise<never>(() => {})

    const outcome = expect(
      new AdminSecurityService(store, {}).blocks(now)
    ).rejects.toMatchObject({ statusCode: 503 })
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS)
    await outcome
  })
})

describe('AdminSecurityService.summary', () => {
  it('counts blocks, sessions, terms and e-mails, with the real terms version', async () => {
    const { service } = setup([ipCounter('2.2.2.2', 4)])

    expect(await service.summary(now)).toEqual({
      generatedAt: now.toISOString(),
      blocks: { active: 1, truncated: false },
      sessions: { sessions: 214, users: 180 },
      terms: { version: TERMS_VERSION, pending: 58 },
      emailsPending: 9,
      logins: {
        windowHours: 0,
        total: 0,
        failed: 0,
        historySince: null,
        partial: true
      }
    })
  })

  it('a part that fails becomes null and the others still answer', async () => {
    const { service } = setup([], [], {
      sessionTotals: vi.fn(async () => {
        throw new Error('relation "refresh_token" does not exist')
      }),
      scanLoginKeys: vi.fn(async () => {
        throw new Error('READONLY')
      })
    })

    const summary = await service.summary(now)

    expect(summary.sessions).toBeNull()
    expect(summary.blocks).toBeNull()
    expect(summary.terms).toMatchObject({ pending: 58 })
    expect(summary.emailsPending).toBe(9)
    expect(JSON.stringify(summary)).not.toContain('refresh_token')
  })

  it('a failing login history becomes null and the rest still answers', async () => {
    const { service } = setup([], [], {
      loginHours: vi.fn(async () => {
        throw new Error('relation "login_attempts" does not exist')
      })
    })

    const summary = await service.summary(now)

    expect(summary.logins).toBeNull()
    expect(summary.emailsPending).toBe(9)
    expect(JSON.stringify(summary)).not.toContain('login_attempts')
  })
})

describe('AdminSecurityService.logins', () => {
  const hourAt = (offset: number) =>
    new Date(Date.parse('2026-11-21T15:00:00.000Z') + offset * 3_600_000)
  const hours = Array.from({ length: 24 }, (_, i) => ({
    hour: hourAt(i - 23),
    total: i === 23 ? 10 : 1,
    failed: i === 23 ? 4 : 0
  }))

  it('sums the 24 hours and flags a history that starts inside the window', async () => {
    const { service } = setup([], [], {
      loginHours: vi.fn(async () => hours),
      loginsEarliest: vi.fn(async () => hourAt(-5))
    })

    const result = await service.logins(now)

    expect(result).toMatchObject({
      windowHours: 24,
      total: 33,
      failed: 4,
      historySince: hourAt(-5).toISOString(),
      partial: true
    })
    expect(result.hours).toHaveLength(24)
    expect(result.hours[23]).toEqual({
      hour: hourAt(0).toISOString(),
      total: 10,
      failed: 4
    })
  })

  it('is complete when the history reaches back before the window', async () => {
    const { service } = setup([], [], {
      loginHours: vi.fn(async () => hours),
      loginsEarliest: vi.fn(async () => hourAt(-72))
    })

    expect((await service.logins(now)).partial).toBe(false)
  })

  it('purges at most one batch of attempts older than 30 days, and a failing purge does not break the read', async () => {
    const purge = vi.fn(async () => {
      throw new Error('boom')
    })
    const { service } = setup([], [], {
      loginHours: vi.fn(async () => hours),
      loginsEarliest: vi.fn(async () => hourAt(-72)),
      purgeLoginAttempts: purge
    })

    await expect(service.logins(now)).resolves.toMatchObject({ failed: 4 })

    expect(purge).toHaveBeenCalledWith(
      new Date(now.getTime() - 30 * 24 * 3_600_000),
      5000
    )
  })
})

describe('AdminSecurityService.sessions', () => {
  it('lists the sessions that expire first, by handle', async () => {
    const { service } = setup([])

    expect(await service.sessions(now)).toEqual({
      generatedAt: now.toISOString(),
      total: 214,
      users: 180,
      items: [
        {
          id: '7d71976e-7b52-4bee-92f1-a2b198d62431',
          handle: 'maria.rpg',
          renewedAt: '2026-11-14T10:00:00.000Z',
          expiresAt: '2026-11-21T10:00:00.000Z'
        }
      ]
    })
  })

  it('no active session is an empty list', async () => {
    const { service } = setup([], [], {
      sessionTotals: vi.fn(async () => ({ sessions: 0, users: 0 })),
      oldestSessions: vi.fn(async () => [])
    })

    expect(await service.sessions(now)).toMatchObject({ total: 0, items: [] })
  })
})

describe('AdminSecurityService.protections', () => {
  it('reads only presence, never the secret or the proxy value', () => {
    const service = new AdminSecurityService(setup([]).store, {
      ORIGIN_SECRET: 'x'.repeat(40),
      TRUST_PROXY: '1'
    })

    const result = service.protections(now)

    expect(result.originSecret).toEqual({ enabled: true })
    expect(result.trustProxy).toEqual({ enabled: true })
    expect(JSON.stringify(result)).not.toContain('xxxx')
  })

  it('an unset or false value is off, like the server reads it', () => {
    for (const env of [
      {},
      { TRUST_PROXY: 'false' },
      { TRUST_PROXY: '' },
      { TRUST_PROXY: '0' },
      { TRUST_PROXY: '00' }
    ]) {
      const result = new AdminSecurityService(setup([]).store, env).protections(
        now
      )
      expect(result.trustProxy.enabled).toBe(false)
      expect(result.originSecret.enabled).toBe(false)
    }
  })

  it.each(['true', '1', '2', '10.0.0.0/8', 'loopback'])(
    'TRUST_PROXY=%s is on, like the server reads it',
    value => {
      const result = new AdminSecurityService(setup([]).store, {
        TRUST_PROXY: value
      }).protections(now)

      expect(result.trustProxy.enabled).toBe(true)
    }
  )

  it('reports the limits the code enforces', () => {
    const result = new AdminSecurityService(setup([]).store, {}).protections(
      now
    )

    expect(result).toMatchObject({
      loginPerMinute: 3,
      loginFailures: { perIp: 10, perEmail: 50, windowMinutes: 15 },
      commonPasswordsBlocked: true,
      recentAuthMinutes: 10,
      emailVerificationRequired: false,
      maxSessionsPerUser: 10
    })
  })
})

describe('AdminSecurityService: ações', () => {
  const actor = { actorId: 'admin-1', ip: '10.0.0.5' }
  const audit = () => ({
    record: vi.fn<(entry: AuditEntryInput) => Promise<void>>(
      async () => undefined
    )
  })
  const build = (
    counters: KeyCounter[],
    overrides: Partial<SecurityStore> = {}
  ) => {
    const log = audit()
    const store: SecurityStore = {
      scanLoginKeys: vi.fn(async () => scanned(...counters.map(c => c.key))),
      counters: vi.fn(async keys =>
        counters.filter(counter => keys.includes(counter.key))
      ),
      handlesByEmailHash: vi.fn(async () => new Map([[EMAIL_A, 'kenzo']])),
      sessionTotals: vi.fn(async () => ({ sessions: 1, users: 1 })),
      oldestSessions: vi.fn(async () => []),
      deleteKey: vi.fn(async () => 1),
      revokeSession: vi.fn(async () => 'maria.rpg'),
      termsPending: vi.fn(async () => 0),
      emailsPending: vi.fn(async () => 0),
      loginHours: vi.fn(async () => []),
      loginsEarliest: vi.fn(async () => null),
      purgeLoginAttempts: vi.fn(async () => 0),
      ...overrides
    }
    return { service: new AdminSecurityService(store, {}, log), store, log }
  }

  describe('releaseBlock', () => {
    const ip = ipCounter('187.4.22.91', 12)

    it('apaga só a chave achada pelo id e audita com o IP', async () => {
      const { service, store, log } = build([ip, ipCounter('2.2.2.2', 9)])

      expect(await service.releaseBlock(blockId(ip.key), actor)).toEqual({
        released: true
      })
      expect(store.deleteKey).toHaveBeenCalledTimes(1)
      expect(store.deleteKey).toHaveBeenCalledWith(ip.key)
      expect(log.record).toHaveBeenCalledWith({
        actorId: 'admin-1',
        action: 'Liberou um bloqueio de login',
        area: 'USERS',
        target: '187.4.22.91',
        detail: 'limite de requisições de login (login)',
        ip: '10.0.0.5'
      })
    })

    it('bloqueio por e-mail audita o handle, nunca o hash inteiro', async () => {
      const key = `login-failures:${EMAIL_A}`
      const { service, log } = build([{ key, count: 49, pttlMs: 5_000 }])

      await service.releaseBlock(blockId(key), actor)

      const entry = vi.mocked(log.record).mock.calls[0][0]
      expect(entry.target).toBe('@kenzo')
      expect(JSON.stringify(entry)).not.toContain(EMAIL_A)
    })

    it('sem handle conhecido audita só o prefixo do hash', async () => {
      const key = `login-failures:${EMAIL_B}`
      const { service, log } = build([{ key, count: 49, pttlMs: 5_000 }], {
        handlesByEmailHash: vi.fn(async () => new Map())
      })

      await service.releaseBlock(blockId(key), actor)

      expect(vi.mocked(log.record).mock.calls[0][0].target).toBe('bbbbbb')
    })

    it('id que não corresponde a nenhuma chave: 404 "já expirou", nada é apagado', async () => {
      const { service, store, log } = build([ip])

      await expect(
        service.releaseBlock('0123456789abcdef', actor)
      ).rejects.toMatchObject({
        statusCode: 404,
        message: 'Esse bloqueio já expirou.'
      })
      expect(store.deleteKey).not.toHaveBeenCalled()
      expect(log.record).not.toHaveBeenCalled()
    })

    it('varredura parcial sem achar o id: 503, não "já expirou"', async () => {
      const { service, store } = build([ip], {
        scanLoginKeys: vi.fn(async () => ({ keys: [], truncated: true }))
      })

      await expect(
        service.releaseBlock(blockId(ip.key), actor)
      ).rejects.toMatchObject({
        statusCode: 503,
        message: 'Leitura parcial do Redis. Atualize a lista e tente de novo.'
      })
      expect(store.deleteKey).not.toHaveBeenCalled()
    })

    it('varredura parcial mas o id foi achado: libera normalmente', async () => {
      const { service, store } = build([ip], {
        scanLoginKeys: vi.fn(async () => ({
          keys: [{ key: ip.key, login: classifyLoginKey(ip.key)! }],
          truncated: true
        }))
      })

      await service.releaseBlock(blockId(ip.key), actor)

      expect(store.deleteKey).toHaveBeenCalledWith(ip.key)
    })

    it('a chave sumiu entre a varredura e a leitura: 404', async () => {
      const { service, store } = build([ip], {
        counters: vi.fn(async () => [])
      })

      await expect(
        service.releaseBlock(blockId(ip.key), actor)
      ).rejects.toMatchObject({ statusCode: 404 })
      expect(store.deleteKey).not.toHaveBeenCalled()
    })

    it('duplo clique: o segundo DEL não apaga nada, dá 404 e não audita de novo', async () => {
      const { service, log } = build([ip], {
        deleteKey: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0)
      })

      await service.releaseBlock(blockId(ip.key), actor)
      await expect(
        service.releaseBlock(blockId(ip.key), actor)
      ).rejects.toMatchObject({ statusCode: 404 })
      expect(log.record).toHaveBeenCalledTimes(1)
    })

    it('depois de liberar, a lista deixa de vir do cache', async () => {
      const { service, store } = build([ip])
      await service.blocks(now)
      await service.blocks(now)
      expect(store.scanLoginKeys).toHaveBeenCalledTimes(1)

      await service.releaseBlock(blockId(ip.key), actor)
      await service.blocks(now)

      expect(store.scanLoginKeys).toHaveBeenCalledTimes(3)
    })
  })

  describe('endSession', () => {
    const id = '7d71976e-7b52-4bee-92f1-a2b198d62431'

    it('revoga pelo id, passa o ator e a ação para a transação', async () => {
      const { service, store } = build([])

      expect(await service.endSession(id, actor, now)).toEqual({ ended: true })
      expect(store.revokeSession).toHaveBeenCalledWith(
        id,
        now,
        actor,
        'Encerrou uma sessão'
      )
    })

    it('sessão já renovada ou inválida: 409 com o aviso para atualizar', async () => {
      const { service } = build([], { revokeSession: vi.fn(async () => null) })

      await expect(service.endSession(id, actor, now)).rejects.toMatchObject({
        statusCode: 409,
        message: 'A sessão foi renovada. Atualize a lista.'
      })
    })

    it('depois de encerrar, a lista de sessões deixa de vir do cache', async () => {
      const { service, store } = build([])
      await service.sessions(now)
      await service.sessions(now)
      expect(store.oldestSessions).toHaveBeenCalledTimes(1)

      await service.endSession(id, actor, now)
      await service.sessions(now)

      expect(store.oldestSessions).toHaveBeenCalledTimes(2)
    })
  })
})
