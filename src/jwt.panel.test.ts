import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll
} from 'vitest'
import fastify, { FastifyInstance } from 'fastify'

const cache = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn()
}))
const authRepository = vi.hoisted(() => ({
  findToken: vi.fn()
}))
const adminRepository = vi.hoisted(() => ({
  findById: vi.fn()
}))

vi.mock('./repositories/cache.repository', () => ({
  CacheRepository: class {
    get = cache.get
    set = cache.set
    del = cache.del
  }
}))
vi.mock('./repositories/auth.repository', () => ({
  AuthRepository: class {
    findToken = authRepository.findToken
  }
}))
vi.mock('./repositories/admin.repository', () => ({
  AdminRepository: class {
    findById = adminRepository.findById
  }
}))

import { Jwt } from './jwt'
import { revokedAccessTokenKey } from './services/auth.service'
import { sessionsRevokedAtKey } from './utils/session-revocation'
import { passwordFingerprint } from './utils/panel-token'

const PASSWORD_HASH = '$2b$12$hash-of-the-admin-password'

let app: FastifyInstance

function panelToken(
  overrides: { userId?: string; pv?: string; expiresIn?: string } = {}
) {
  return app.jwt.sign(
    {
      userId: overrides.userId ?? 'admin-1',
      tokenType: 'panel',
      pv: overrides.pv ?? passwordFingerprint(PASSWORD_HASH)
    },
    { expiresIn: overrides.expiresIn ?? '8h' }
  )
}

function accessToken(userId = 'admin-1') {
  return app.jwt.sign({ userId, tokenType: 'access' })
}

function refreshToken(userId = 'admin-1') {
  return app.jwt.sign(
    { userId, tokenType: 'refresh', jti: crypto.randomUUID() },
    { expiresIn: '7d' }
  )
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` }
}

function adminRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'admin-1',
    userName: 'dono',
    email: 'dono@exemplo.com',
    role: 'ADMIN',
    password: PASSWORD_HASH,
    ...overrides
  }
}

beforeAll(async () => {
  process.env.SECRET_JWT_KEY = 'test-secret-with-more-than-32-characters'
  process.env.FRONTEND_URL = 'http://localhost:5173'

  app = fastify()
  Jwt.initSetup(app)
  app.get(
    '/admin-only',
    { onRequest: [app.authenticateAdmin] },
    async request => ({
      userId: request.user.userId
    })
  )
  app.get('/private', { preHandler: [app.authenticate] }, async request => ({
    userId: request.user.userId
  }))
  app.get('/public', { preHandler: [app.tryAuthenticate] }, async request => ({
    userId: request.user?.userId ?? null
  }))
  await app.ready()
})

beforeEach(() => {
  cache.get.mockReset().mockResolvedValue(null)
  authRepository.findToken.mockReset().mockResolvedValue(null)
  adminRepository.findById.mockReset().mockResolvedValue(adminRow())
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

afterAll(async () => {
  await app.close()
})

describe('app.authenticateAdmin', () => {
  it('accepts a valid panel token in the Authorization header of an admin', async () => {
    const response = await app.inject({
      url: '/admin-only',
      headers: bearer(panelToken())
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ userId: 'admin-1' })
  })

  it('answers 401 without a token or with a malformed header', async () => {
    const none = await app.inject({ url: '/admin-only' })
    const malformed = await app.inject({
      url: '/admin-only',
      headers: { authorization: panelToken() }
    })

    expect(none.statusCode).toBe(401)
    expect(malformed.statusCode).toBe(401)
  })

  it('does not read the token from cookies', async () => {
    const response = await app.inject({
      url: '/admin-only',
      cookies: { accessToken: panelToken() }
    })

    expect(response.statusCode).toBe(401)
  })

  it('rejects an app access token sent as Bearer', async () => {
    const response = await app.inject({
      url: '/admin-only',
      headers: bearer(accessToken())
    })

    expect(response.statusCode).toBe(401)
  })

  it('rejects an app access token placed in the cookie', async () => {
    const response = await app.inject({
      url: '/admin-only',
      cookies: { accessToken: accessToken() }
    })

    expect(response.statusCode).toBe(401)
  })

  it('rejects a refresh token sent as Bearer', async () => {
    const response = await app.inject({
      url: '/admin-only',
      headers: bearer(refreshToken())
    })

    expect(response.statusCode).toBe(401)
  })

  it('rejects an expired panel token', async () => {
    const token = panelToken({ expiresIn: '1s' })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 5_000)

    const response = await app.inject({
      url: '/admin-only',
      headers: bearer(token)
    })

    expect(response.statusCode).toBe(401)
  })

  it('answers 403 when the account is no longer an admin', async () => {
    adminRepository.findById.mockResolvedValue(adminRow({ role: 'USER' }))

    const response = await app.inject({
      url: '/admin-only',
      headers: bearer(panelToken())
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({
      status: 'forbidden',
      message: 'Acesso restrito a administradores.'
    })
  })

  it('reads the role on every request, so a demotion takes effect at once', async () => {
    const token = panelToken()
    const before = await app.inject({
      url: '/admin-only',
      headers: bearer(token)
    })
    adminRepository.findById.mockResolvedValue(adminRow({ role: 'USER' }))
    const after = await app.inject({
      url: '/admin-only',
      headers: bearer(token)
    })

    expect([before.statusCode, after.statusCode]).toEqual([200, 403])
  })

  it('answers 401 when the account was deleted', async () => {
    adminRepository.findById.mockResolvedValue(null)

    const response = await app.inject({
      url: '/admin-only',
      headers: bearer(panelToken())
    })

    expect(response.statusCode).toBe(401)
  })

  it('answers 401 after the password changed, however old the revocation mark is', async () => {
    adminRepository.findById.mockResolvedValue(
      adminRow({ password: '$2b$12$a-brand-new-password-hash' })
    )

    const response = await app.inject({
      url: '/admin-only',
      headers: bearer(panelToken())
    })

    expect(response.statusCode).toBe(401)
  })

  it('rejects a token revoked at logout', async () => {
    const token = panelToken()
    cache.get.mockImplementation(async (key: string) =>
      key === revokedAccessTokenKey(token) ? true : null
    )

    const response = await app.inject({
      url: '/admin-only',
      headers: bearer(token)
    })

    expect(response.statusCode).toBe(401)
  })

  it('rejects a token issued before the user sessions were revoked', async () => {
    cache.get.mockImplementation(async (key: string) =>
      key === sessionsRevokedAtKey('admin-1')
        ? Math.floor(Date.now() / 1000) + 60
        : null
    )

    const response = await app.inject({
      url: '/admin-only',
      headers: bearer(panelToken())
    })

    expect(response.statusCode).toBe(401)
  })

  it('answers 503 when the revocation check cannot be made, instead of failing open', async () => {
    cache.get.mockRejectedValue(new Error('redis down'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await app.inject({
      url: '/admin-only',
      headers: bearer(panelToken())
    })

    expect(response.statusCode).toBe(503)
  })

  it('answers 503 when the role cannot be read', async () => {
    adminRepository.findById.mockRejectedValue(new Error('database down'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await app.inject({
      url: '/admin-only',
      headers: bearer(panelToken())
    })

    expect(response.statusCode).toBe(503)
  })
})

function issuedTokenCookies(header: string | string[] | undefined) {
  const cookies = Array.isArray(header) ? header : header ? [header] : []
  return cookies.filter(cookie =>
    /^(accessToken|refreshToken)=[^;]+/.test(cookie)
  )
}

function activeRefreshRow() {
  return { isValid: true, expiresAt: new Date(Date.now() + 60_000) }
}

describe('app side rejects panel tokens', () => {
  it('app.authenticate does not renew a session from a panel token in the refresh cookie, even if the database finds it', async () => {
    authRepository.findToken.mockResolvedValue(activeRefreshRow())

    const response = await app.inject({
      url: '/private',
      cookies: { refreshToken: panelToken() }
    })

    expect(response.statusCode).toBe(401)
    expect(issuedTokenCookies(response.headers['set-cookie'])).toEqual([])
  })

  it('app.tryAuthenticate does not renew either, and the request stays anonymous', async () => {
    authRepository.findToken.mockResolvedValue(activeRefreshRow())

    const response = await app.inject({
      url: '/public',
      cookies: { refreshToken: panelToken() }
    })

    expect(response.json()).toEqual({ userId: null })
    expect(issuedTokenCookies(response.headers['set-cookie'])).toEqual([])
  })

  it('app.authenticate rejects a panel token placed in the cookie', async () => {
    const response = await app.inject({
      url: '/private',
      cookies: { accessToken: panelToken() }
    })

    expect(response.statusCode).toBe(401)
  })

  it('app.tryAuthenticate leaves a request with a panel token anonymous', async () => {
    const response = await app.inject({
      url: '/public',
      cookies: { accessToken: panelToken() }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ userId: null })
  })
})
