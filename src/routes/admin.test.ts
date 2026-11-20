import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fastify, { FastifyInstance } from 'fastify'
import { errorHandler } from '../error-handler'

const auditQueryService = vi.hoisted(() => ({
  list: vi.fn(),
  summary: vi.fn()
}))
const panelAuthService = vi.hoisted(() => ({
  login: vi.fn(),
  logout: vi.fn(),
  profile: vi.fn()
}))

vi.mock('../services/audit-query.service', () => ({
  AuditQueryService: class {
    list = auditQueryService.list
    summary = auditQueryService.summary
  }
}))
vi.mock('../services/panel-auth.service', () => ({
  PanelAuthService: class {
    login = panelAuthService.login
    logout = panelAuthService.logout
    profile = panelAuthService.profile
  }
}))

import { adminRoutes } from './admin'

async function buildApp(
  authenticateAdmin: FastifyInstance['authenticateAdmin']
) {
  const app = fastify()
  app.setErrorHandler(errorHandler)
  app.decorate('authenticateAdmin', authenticateAdmin)
  await app.register(adminRoutes, { prefix: '/admin' })
  await app.ready()
  return app
}

const allowAdmin: FastifyInstance['authenticateAdmin'] = async request => {
  ;(request as { user?: unknown }).user = { userId: 'admin-1' }
}

const denyAll: FastifyInstance['authenticateAdmin'] = async (_request, reply) =>
  reply.status(401).send({ status: 'unauthorized' })

const emptyList = { items: [], page: 1, pageSize: 20, total: 0, period: 7 }

beforeEach(() => {
  auditQueryService.list.mockReset().mockResolvedValue(emptyList)
  auditQueryService.summary.mockReset().mockResolvedValue({ actionsToday: 0 })
})

afterEach(() => vi.restoreAllMocks())

describe('/admin/audit is behind the admin guard', () => {
  it.each(['/admin/audit', '/admin/audit/summary'])(
    '%s answers 401 and never reaches the service',
    async url => {
      const app = await buildApp(denyAll)

      const response = await app.inject({ method: 'GET', url })

      expect(response.statusCode).toBe(401)
      expect(auditQueryService.list).not.toHaveBeenCalled()
      expect(auditQueryService.summary).not.toHaveBeenCalled()
    }
  )

  it('the guard runs before validation, so a bad query is a 401 and not a 400 for a stranger', async () => {
    const app = await buildApp(denyAll)

    const response = await app.inject({
      method: 'GET',
      url: '/admin/audit?page=0&area=banana'
    })

    expect(response.statusCode).toBe(401)
  })
})

describe('GET /admin/audit', () => {
  it('answers the service result', async () => {
    const app = await buildApp(allowAdmin)
    auditQueryService.list.mockResolvedValue({ ...emptyList, total: 41 })

    const response = await app.inject({ method: 'GET', url: '/admin/audit' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ total: 41, pageSize: 20 })
  })

  it('applies the defaults: page 1, the last 7 days, no filters', async () => {
    const app = await buildApp(allowAdmin)

    await app.inject({ method: 'GET', url: '/admin/audit' })

    expect(auditQueryService.list).toHaveBeenCalledWith({
      area: undefined,
      q: undefined,
      page: 1,
      period: 7
    })
  })

  it('parses and trims the parameters', async () => {
    const app = await buildApp(allowAdmin)

    await app.inject({
      method: 'GET',
      url: '/admin/audit?area=users&q=%20kenzo%20&page=2&period=30'
    })

    expect(auditQueryService.list).toHaveBeenCalledWith({
      area: 'users',
      q: 'kenzo',
      page: 2,
      period: 30
    })
  })

  it('treats empty parameters as absent', async () => {
    const app = await buildApp(allowAdmin)

    await app.inject({ method: 'GET', url: '/admin/audit?area=&q=' })

    expect(auditQueryService.list).toHaveBeenCalledWith(
      expect.objectContaining({ area: undefined, q: undefined })
    )
  })

  it.each([
    'area=banana',
    'page=0',
    'page=abc',
    'period=14',
    `q=${'x'.repeat(101)}`
  ])('answers 400 with the field errors for %s', async query => {
    const app = await buildApp(allowAdmin)

    const response = await app.inject({
      method: 'GET',
      url: `/admin/audit?${query}`
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().message).toBe('Invalid input')
    expect(auditQueryService.list).not.toHaveBeenCalled()
  })
})

describe('GET /admin/audit/summary', () => {
  it('answers the service result', async () => {
    const app = await buildApp(allowAdmin)
    auditQueryService.summary.mockResolvedValue({
      actionsToday: 12,
      actionsLast7Days: 41,
      backfillsToday: 3,
      suspensionsLast7Days: 1,
      failuresLast7Days: 0
    })

    const response = await app.inject({
      method: 'GET',
      url: '/admin/audit/summary'
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      actionsToday: 12,
      actionsLast7Days: 41,
      backfillsToday: 3,
      suspensionsLast7Days: 1,
      failuresLast7Days: 0
    })
  })

  it('a failure in the service is a 500 with the generic message, no internals', async () => {
    const app = await buildApp(allowAdmin)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    auditQueryService.summary.mockRejectedValue(
      new Error('relation "audit_logs" does not exist')
    )

    const response = await app.inject({
      method: 'GET',
      url: '/admin/audit/summary'
    })

    expect(response.statusCode).toBe(500)
    expect(response.json().message).toBe('Internal server error')
  })
})
