import { beforeEach, describe, expect, it, vi } from 'vitest'
import fastify, { FastifyInstance } from 'fastify'
import { errorHandler } from '../error-handler'
import { ClientError } from '../errors/client-error'

const service = vi.hoisted(() => ({
  list: vi.fn(),
  summary: vi.fn(),
  detail: vi.fn()
}))
vi.mock('../services/admin-reviews.service', () => ({
  AdminReviewsService: class {
    list = service.list
    summary = service.summary
    detail = service.detail
  }
}))
vi.mock('../repositories/admin-reviews.repository', () => ({
  AdminReviewsRepository: class {}
}))
vi.mock('../routes/panel-auth', () => ({
  buildPanelAuthController: () => ({ me: vi.fn() })
}))
vi.mock('./admin-audit', () => ({ adminAuditRoutes: async () => {} }))
vi.mock('./admin-settings', () => ({ adminSettingsRoutes: async () => {} }))
vi.mock('./admin-users', () => ({ adminUsersRoutes: async () => {} }))
vi.mock('./admin-catalog', () => ({ adminCatalogRoutes: async () => {} }))
vi.mock('./admin-overview', () => ({ adminOverviewRoutes: async () => {} }))
vi.mock('./admin-security', () => ({ adminSecurityRoutes: async () => {} }))
vi.mock('./admin-health', () => ({ adminHealthRoutes: async () => {} }))
vi.mock('./admin-imports', () => ({
  adminImportsRoutes: async () => {},
  adminQueuesRoutes: async () => {}
}))

import { adminRoutes } from './admin'

const ID = '3f1c1d8e-5b0a-4f4e-9b1a-0a1b2c3d4e5f'

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

beforeEach(() => {
  service.list.mockReset().mockResolvedValue({ items: [], total: 0 })
  service.summary.mockReset().mockResolvedValue({ openReports: 0 })
  service.detail.mockReset().mockResolvedValue({ id: ID })
})

describe('the review reads are behind the admin guard', () => {
  it.each(['/admin/reviews', '/admin/reviews/summary', `/admin/reviews/${ID}`])(
    '%s answers 401 and never reaches the service',
    async url => {
      const app = await buildApp(denyAll)

      const response = await app.inject({ method: 'GET', url })

      expect(response.statusCode).toBe(401)
      expect(service.list).not.toHaveBeenCalled()
      expect(service.summary).not.toHaveBeenCalled()
      expect(service.detail).not.toHaveBeenCalled()
    }
  )

  it('the guard runs before validation, so a bad query or id is a 401, not a 400', async () => {
    const app = await buildApp(denyAll)

    const bad = await app.inject({
      method: 'GET',
      url: '/admin/reviews?page=0&status=banana'
    })
    const badId = await app.inject({ method: 'GET', url: '/admin/reviews/x' })

    expect(bad.statusCode).toBe(401)
    expect(badId.statusCode).toBe(401)
  })
})

describe('GET /admin/reviews', () => {
  it('applies the defaults', async () => {
    const app = await buildApp(allowAdmin)

    const response = await app.inject({ method: 'GET', url: '/admin/reviews' })

    expect(response.statusCode).toBe(200)
    expect(service.list).toHaveBeenCalledWith({ status: 'open', page: 1 })
  })

  it('passes the search, the status and the page', async () => {
    const app = await buildApp(allowAdmin)

    await app.inject({
      method: 'GET',
      url: '/admin/reviews?q=%40anon&status=all&page=3'
    })

    expect(service.list).toHaveBeenCalledWith({
      q: '@anon',
      status: 'all',
      page: 3
    })
  })

  it.each(['page=0', 'page=1.5', 'status=banana', `q=${'a'.repeat(101)}`])(
    'rejects %s with a 400',
    async query => {
      const app = await buildApp(allowAdmin)

      const response = await app.inject({
        method: 'GET',
        url: `/admin/reviews?${query}`
      })

      expect(response.statusCode).toBe(400)
      expect(service.list).not.toHaveBeenCalled()
    }
  )

  it('answers a generic 500 when the service throws something unexpected', async () => {
    service.list.mockRejectedValue(new Error('select * from users leaked'))
    const app = await buildApp(allowAdmin)

    const response = await app.inject({ method: 'GET', url: '/admin/reviews' })

    expect(response.statusCode).toBe(500)
    expect(response.body).not.toContain('leaked')
  })
})

describe('GET /admin/reviews/summary and /:id', () => {
  it('answers the summary', async () => {
    const app = await buildApp(allowAdmin)

    const response = await app.inject({
      method: 'GET',
      url: '/admin/reviews/summary'
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ openReports: 0 })
  })

  it('passes the id to the service and rejects one that is not a uuid', async () => {
    const app = await buildApp(allowAdmin)

    const ok = await app.inject({ method: 'GET', url: `/admin/reviews/${ID}` })
    const bad = await app.inject({ method: 'GET', url: '/admin/reviews/nope' })

    expect(ok.statusCode).toBe(200)
    expect(service.detail).toHaveBeenCalledWith(ID)
    expect(bad.statusCode).toBe(400)
  })

  it('passes a 404 from the service through', async () => {
    service.detail.mockRejectedValue(
      new ClientError('Review não encontrada.', 404)
    )
    const app = await buildApp(allowAdmin)

    const response = await app.inject({
      method: 'GET',
      url: `/admin/reviews/${ID}`
    })

    expect(response.statusCode).toBe(404)
  })
})
