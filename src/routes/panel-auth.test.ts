import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fastify, { FastifyInstance } from 'fastify'
import { ClientError } from '../errors/client-error'
import { errorHandler } from '../error-handler'

const panelAuthService = vi.hoisted(() => ({
  login: vi.fn(),
  logout: vi.fn(),
  profile: vi.fn()
}))

vi.mock('../services/panel-auth.service', () => ({
  PanelAuthService: class {
    login = panelAuthService.login
    logout = panelAuthService.logout
    profile = panelAuthService.profile
  }
}))

import { panelAuthRoutes } from './panel-auth'
import { adminRoutes } from './admin'

interface CapturedRoute {
  method: string | string[]
  url: string
  config?: { rateLimit?: { max: number; timeWindow: string } }
}

async function buildApp(
  authenticateAdmin: FastifyInstance['authenticateAdmin']
) {
  const app = fastify()
  app.setErrorHandler(errorHandler)
  app.decorate('authenticateAdmin', authenticateAdmin)
  const routes: CapturedRoute[] = []
  app.addHook('onRoute', route => {
    routes.push(route as unknown as CapturedRoute)
  })
  await app.register(panelAuthRoutes, { prefix: '/panel/auth' })
  await app.register(adminRoutes, { prefix: '/admin' })
  await app.ready()
  return { app, routes }
}

const allowAdmin: FastifyInstance['authenticateAdmin'] = async request => {
  ;(request as { user?: unknown }).user = { userId: 'admin-1' }
}

const denyAll: FastifyInstance['authenticateAdmin'] = async (
  _request,
  reply
) => {
  return reply.status(401).send({ status: 'unauthorized' })
}

beforeEach(() => {
  panelAuthService.login.mockReset()
  panelAuthService.logout.mockReset().mockResolvedValue(undefined)
  panelAuthService.profile.mockReset()
})

afterEach(() => vi.restoreAllMocks())

describe('POST /panel/auth/login', () => {
  it('is limited to 3 attempts per minute', async () => {
    const { routes } = await buildApp(allowAdmin)

    const login = routes.find(r => r.url === '/panel/auth/login')

    expect(login?.config?.rateLimit).toEqual({ max: 3, timeWindow: '1 minute' })
  })

  it('answers the service result and sets no cookie', async () => {
    const { app } = await buildApp(allowAdmin)
    panelAuthService.login.mockResolvedValue({
      user: { id: 'admin-1', name: 'dono', email: 'dono@exemplo.com' },
      token: 'panel-token'
    })

    const response = await app.inject({
      method: 'POST',
      url: '/panel/auth/login',
      payload: { email: 'Dono@Exemplo.com', password: 'senha' }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      user: { id: 'admin-1', name: 'dono', email: 'dono@exemplo.com' },
      token: 'panel-token'
    })
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(panelAuthService.login).toHaveBeenCalledWith(
      'dono@exemplo.com',
      'senha',
      expect.any(String)
    )
  })

  it('answers 400 with the field errors for an invalid body', async () => {
    const { app } = await buildApp(allowAdmin)

    const response = await app.inject({
      method: 'POST',
      url: '/panel/auth/login',
      payload: { email: 'nao-e-email' }
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toHaveProperty('email')
    expect(panelAuthService.login).not.toHaveBeenCalled()
  })

  it('passes the 401 of the service through as a problem body', async () => {
    const { app } = await buildApp(allowAdmin)
    panelAuthService.login.mockRejectedValue(
      new ClientError('Email ou senha incorretos.', 401)
    )

    const response = await app.inject({
      method: 'POST',
      url: '/panel/auth/login',
      payload: { email: 'dono@exemplo.com', password: 'errada' }
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({
      message: 'Email ou senha incorretos.'
    })
  })
})

describe('POST /panel/auth/logout', () => {
  it('requires the admin guard', async () => {
    const { app } = await buildApp(denyAll)

    const response = await app.inject({
      method: 'POST',
      url: '/panel/auth/logout'
    })

    expect(response.statusCode).toBe(401)
    expect(panelAuthService.logout).not.toHaveBeenCalled()
  })

  it('revokes the Bearer token and answers 204', async () => {
    const { app } = await buildApp(allowAdmin)

    const response = await app.inject({
      method: 'POST',
      url: '/panel/auth/logout',
      headers: { authorization: 'Bearer panel-token' }
    })

    expect(response.statusCode).toBe(204)
    expect(panelAuthService.logout).toHaveBeenCalledWith(
      'panel-token',
      'admin-1',
      expect.any(String)
    )
  })
})

describe('GET /admin/me', () => {
  it('is guarded by the admin guard before anything else', async () => {
    const { app } = await buildApp(denyAll)

    const response = await app.inject({ method: 'GET', url: '/admin/me' })

    expect(response.statusCode).toBe(401)
    expect(panelAuthService.profile).not.toHaveBeenCalled()
  })

  it('answers the admin profile', async () => {
    const { app } = await buildApp(allowAdmin)
    panelAuthService.profile.mockResolvedValue({
      id: 'admin-1',
      name: 'dono',
      email: 'dono@exemplo.com',
      role: 'ADMIN'
    })

    const response = await app.inject({ method: 'GET', url: '/admin/me' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: 'admin-1', role: 'ADMIN' })
  })
})
