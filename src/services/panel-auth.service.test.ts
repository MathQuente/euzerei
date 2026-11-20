import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll
} from 'vitest'
import fastify, { FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { ClientError } from '../errors/client-error'
import { PanelAuthService } from './panel-auth.service'
import { revokedAccessTokenKey } from './auth.service'
import { passwordFingerprint } from '../utils/panel-token'
import type { AdminRepository } from '../repositories/admin.repository'
import type { CacheRepository } from '../repositories/cache.repository'
import type { AuditService } from './audit.service'

const PASSWORD_HASH = '$2b$12$hash-of-the-admin-password'

const authService = { validateUser: vi.fn() }
const adminRepository = { findById: vi.fn() }
const cache = { set: vi.fn() }
const audit = { record: vi.fn() }

let app: FastifyInstance
let service: PanelAuthService

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
  app = fastify()
  await app.register(fastifyJwt, {
    secret: 'test-secret-with-more-than-32-characters'
  })
  await app.ready()
  service = new PanelAuthService(
    authService,
    adminRepository as unknown as AdminRepository,
    app.jwt,
    cache as unknown as CacheRepository,
    audit as unknown as AuditService
  )
})

beforeEach(() => {
  authService.validateUser.mockReset().mockResolvedValue({
    user: { id: 'admin-1', userName: 'dono' }
  })
  adminRepository.findById.mockReset().mockResolvedValue(adminRow())
  cache.set.mockReset().mockResolvedValue(undefined)
  audit.record.mockReset().mockResolvedValue(undefined)
})

afterAll(async () => {
  await app.close()
})

describe('PanelAuthService.login', () => {
  it('answers with the shape the panel expects and no cookies or refresh token', async () => {
    const result = await service.login('dono@exemplo.com', 'senha', '1.2.3.4')

    expect(Object.keys(result).sort()).toEqual(['token', 'user'])
    expect(result.user).toEqual({
      id: 'admin-1',
      name: 'dono',
      email: 'dono@exemplo.com'
    })
    expect(typeof result.token).toBe('string')
  })

  it('signs a panel token that lasts 8 hours and binds it to the password', async () => {
    const { token } = await service.login(
      'dono@exemplo.com',
      'senha',
      '1.2.3.4'
    )

    const claims = app.jwt.verify<{
      userId: string
      tokenType: string
      pv: string
      iat: number
      exp: number
    }>(token)
    expect(claims.tokenType).toBe('panel')
    expect(claims.userId).toBe('admin-1')
    expect(claims.exp - claims.iat).toBe(8 * 60 * 60)
    expect(claims.pv).toBe(passwordFingerprint(PASSWORD_HASH))
  })

  it('reuses the app login checks with the email, password and ip', async () => {
    await service.login('dono@exemplo.com', 'senha', '1.2.3.4')

    expect(authService.validateUser).toHaveBeenCalledWith(
      'dono@exemplo.com',
      'senha',
      '1.2.3.4'
    )
  })

  it('records the login in the audit log', async () => {
    await service.login('dono@exemplo.com', 'senha', '1.2.3.4')

    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'admin-1',
      action: 'Entrou no painel',
      area: 'SYSTEM',
      target: '@dono',
      ip: '1.2.3.4'
    })
  })

  it('turns a wrong password into 401 with the same message', async () => {
    authService.validateUser.mockRejectedValue(
      new ClientError('Email ou senha incorretos.')
    )

    const error = await service
      .login('dono@exemplo.com', 'errada', '1.2.3.4')
      .catch(e => e)

    expect(error).toBeInstanceOf(ClientError)
    expect(error.statusCode).toBe(401)
    expect(error.message).toBe('Email ou senha incorretos.')
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('gives a non-admin with the right password the same 401 as a wrong password', async () => {
    authService.validateUser.mockRejectedValueOnce(
      new ClientError('Email ou senha incorretos.')
    )
    const wrongPassword = await service
      .login('user@exemplo.com', 'errada', '1.2.3.4')
      .catch(e => e)

    authService.validateUser.mockResolvedValue({
      user: { id: 'user-9', userName: 'comum' }
    })
    adminRepository.findById.mockResolvedValue(
      adminRow({ id: 'user-9', userName: 'comum', role: 'USER' })
    )
    const nonAdmin = await service
      .login('user@exemplo.com', 'certa', '1.2.3.4')
      .catch(e => e)

    expect(nonAdmin.statusCode).toBe(wrongPassword.statusCode)
    expect(nonAdmin.message).toBe(wrongPassword.message)
  })

  it('audits a non-admin trying to enter, without issuing a token', async () => {
    authService.validateUser.mockResolvedValue({
      user: { id: 'user-9', userName: 'comum' }
    })
    adminRepository.findById.mockResolvedValue(
      adminRow({ id: 'user-9', userName: 'comum', role: 'USER' })
    )

    await expect(
      service.login('user@exemplo.com', 'certa', '1.2.3.4')
    ).rejects.toMatchObject({ statusCode: 401 })

    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'user-9',
      action: 'Tentou entrar no painel sem ser admin',
      area: 'SYSTEM',
      target: '@comum',
      result: 'FAILED',
      ip: '1.2.3.4'
    })
  })

  it('lets the app lockout (429) through untouched', async () => {
    authService.validateUser.mockRejectedValue(
      new ClientError(
        'Muitas tentativas de login. Tente novamente mais tarde.',
        429
      )
    )

    await expect(
      service.login('dono@exemplo.com', 'senha', '1.2.3.4')
    ).rejects.toMatchObject({ statusCode: 429 })
  })
})

describe('PanelAuthService.logout', () => {
  it('revokes the token for its remaining life and audits it', async () => {
    const { token } = await service.login(
      'dono@exemplo.com',
      'senha',
      '1.2.3.4'
    )
    audit.record.mockClear()

    await service.logout(token, 'admin-1', '1.2.3.4')

    const [key, value, ttl] = cache.set.mock.calls[0]
    expect(key).toBe(revokedAccessTokenKey(token))
    expect(value).toBe(true)
    expect(ttl).toBeGreaterThan(8 * 60 * 60 - 5)
    expect(ttl).toBeLessThanOrEqual(8 * 60 * 60)
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'admin-1',
      action: 'Saiu do painel',
      area: 'SYSTEM',
      ip: '1.2.3.4'
    })
  })

  it('answers 503 when the revocation cannot be stored, instead of pretending it logged out', async () => {
    const { token } = await service.login(
      'dono@exemplo.com',
      'senha',
      '1.2.3.4'
    )
    cache.set.mockRejectedValue(new Error('redis down'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(
      service.logout(token, 'admin-1', '1.2.3.4')
    ).rejects.toMatchObject({ statusCode: 503 })
  })

  it('does nothing for a token that is already invalid', async () => {
    await service.logout('not-a-token', 'admin-1', '1.2.3.4')

    expect(cache.set).not.toHaveBeenCalled()
  })
})

describe('PanelAuthService.profile', () => {
  it('returns the admin without the password hash', async () => {
    const profile = await service.profile('admin-1')

    expect(profile).toEqual({
      id: 'admin-1',
      name: 'dono',
      email: 'dono@exemplo.com',
      role: 'ADMIN'
    })
  })

  it('returns null when the account is gone', async () => {
    adminRepository.findById.mockResolvedValue(null)

    await expect(service.profile('admin-1')).resolves.toBeNull()
  })
})
