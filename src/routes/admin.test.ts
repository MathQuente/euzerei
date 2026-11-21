import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fastify, { FastifyInstance } from 'fastify'
import { errorHandler } from '../error-handler'
import { ClientError } from '../errors/client-error'

const auditQueryService = vi.hoisted(() => ({
  list: vi.fn(),
  summary: vi.fn()
}))
const adminImportsService = vi.hoisted(() => ({
  list: vi.fn(),
  summary: vi.fn(),
  failures: vi.fn(),
  queues: vi.fn()
}))
const adminUsersService = vi.hoisted(() => ({
  list: vi.fn(),
  summary: vi.fn(),
  detail: vi.fn()
}))
const adminSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn()
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
vi.mock('../queues/import-queues', () => ({
  importQueues: {},
  importQueuesRedis: {}
}))
vi.mock('../services/admin-imports.service', () => ({
  AdminImportsService: class {
    list = adminImportsService.list
    summary = adminImportsService.summary
    failures = adminImportsService.failures
    queues = adminImportsService.queues
  }
}))
vi.mock('../services/admin-users.service', () => ({
  AdminUsersService: class {
    list = adminUsersService.list
    summary = adminUsersService.summary
    detail = adminUsersService.detail
  }
}))
vi.mock('../services/admin-settings.service', () => ({
  AdminSettingsService: class {
    get = adminSettingsService.get
    update = adminSettingsService.update
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
import { AdminUpdateSettingsBodySchema } from '../schemas/admin-settings.schema'

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

const USER_ID = '2f1c3a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const emptyImports = { items: [], page: 1, pageSize: 20, total: 0 }
const emptyList = { items: [], page: 1, pageSize: 20, total: 0, period: 7 }

beforeEach(() => {
  auditQueryService.list.mockReset().mockResolvedValue(emptyList)
  auditQueryService.summary.mockReset().mockResolvedValue({ actionsToday: 0 })
  adminImportsService.list.mockReset().mockResolvedValue(emptyImports)
  adminImportsService.summary.mockReset().mockResolvedValue({ queued: 0 })
  adminImportsService.failures.mockReset().mockResolvedValue({ total: 0 })
  adminImportsService.queues.mockReset().mockResolvedValue({ queues: [] })
  adminUsersService.list
    .mockReset()
    .mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 })
  adminUsersService.summary
    .mockReset()
    .mockResolvedValue({ total: 0, active7d: 0 })
  adminUsersService.detail.mockReset().mockResolvedValue({ id: USER_ID })
  adminSettingsService.get
    .mockReset()
    .mockResolvedValue({ settings: {}, termsPending: 0 })
  adminSettingsService.update
    .mockReset()
    .mockResolvedValue({ settings: {}, termsPending: 0 })
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

const IMPORT_PATHS = [
  '/admin/imports',
  '/admin/imports/summary',
  '/admin/imports/failures',
  '/admin/queues'
]

function importServiceCalls() {
  return [
    adminImportsService.list,
    adminImportsService.summary,
    adminImportsService.failures,
    adminImportsService.queues
  ]
}

describe('the import reads are behind the admin guard', () => {
  it.each(IMPORT_PATHS)(
    '%s answers 401 and never reaches the service',
    async url => {
      const app = await buildApp(denyAll)

      const response = await app.inject({ method: 'GET', url })

      expect(response.statusCode).toBe(401)
      for (const call of importServiceCalls())
        expect(call).not.toHaveBeenCalled()
    }
  )

  it('a bad query is a 401, not a 400, for a stranger', async () => {
    const app = await buildApp(denyAll)

    const response = await app.inject({
      method: 'GET',
      url: '/admin/imports?status=banana'
    })

    expect(response.statusCode).toBe(401)
  })
})

describe('GET /admin/imports', () => {
  it('answers the service result with the defaults', async () => {
    const app = await buildApp(allowAdmin)
    adminImportsService.list.mockResolvedValue({ ...emptyImports, total: 7 })

    const response = await app.inject({ method: 'GET', url: '/admin/imports' })

    expect(response.statusCode).toBe(200)
    expect(response.json().total).toBe(7)
    expect(adminImportsService.list).toHaveBeenCalledWith({ page: 1 })
  })

  it('parses status, store and page', async () => {
    const app = await buildApp(allowAdmin)

    await app.inject({
      method: 'GET',
      url: '/admin/imports?status=failed&store=psn&page=2'
    })

    expect(adminImportsService.list).toHaveBeenCalledWith({
      status: 'failed',
      store: 'psn',
      page: 2
    })
  })

  it('treats empty filters as absent', async () => {
    const app = await buildApp(allowAdmin)

    await app.inject({ method: 'GET', url: '/admin/imports?status=&store=' })

    expect(adminImportsService.list).toHaveBeenCalledWith({ page: 1 })
  })

  it.each([
    'status=banana',
    'status=completed',
    'status=warning',
    'store=epic',
    'page=0',
    'page=26'
  ])('answers 400 for %s', async query => {
    const app = await buildApp(allowAdmin)

    const response = await app.inject({
      method: 'GET',
      url: `/admin/imports?${query}`
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().message).toBe('Invalid input')
    expect(adminImportsService.list).not.toHaveBeenCalled()
  })
})

describe('the other import reads', () => {
  it.each([
    [
      '/admin/imports/summary',
      () => adminImportsService.summary,
      { queued: 3 }
    ],
    [
      '/admin/imports/failures',
      () => adminImportsService.failures,
      { total: 2 }
    ],
    ['/admin/queues', () => adminImportsService.queues, { queues: [] }]
  ] as const)(
    '%s answers the service result',
    async (url, service, payload) => {
      const app = await buildApp(allowAdmin)
      service().mockResolvedValue(payload)

      const response = await app.inject({ method: 'GET', url })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual(payload)
    }
  )

  it('an unavailable queue is a 503 with the message, no internals', async () => {
    const app = await buildApp(allowAdmin)
    adminImportsService.summary.mockRejectedValue(
      new ClientError('Não foi possível ler as filas agora.', 503)
    )

    const response = await app.inject({
      method: 'GET',
      url: '/admin/imports/summary'
    })

    expect(response.statusCode).toBe(503)
    expect(response.json().message).toBe('Não foi possível ler as filas agora.')
  })
})

const USER_PATHS = [
  '/admin/users',
  '/admin/users/summary',
  `/admin/users/${USER_ID}`
]

describe('the user reads are behind the admin guard', () => {
  it.each(USER_PATHS)(
    '%s answers 401 and never reaches the service',
    async url => {
      const app = await buildApp(denyAll)

      const response = await app.inject({ method: 'GET', url })

      expect(response.statusCode).toBe(401)
      expect(adminUsersService.list).not.toHaveBeenCalled()
      expect(adminUsersService.summary).not.toHaveBeenCalled()
      expect(adminUsersService.detail).not.toHaveBeenCalled()
    }
  )

  it('the guard runs before validation, so a bad query is a 401 and not a 400 for a stranger', async () => {
    const app = await buildApp(denyAll)

    const bad = await app.inject({
      method: 'GET',
      url: '/admin/users?page=0&filter=banana'
    })
    const badId = await app.inject({ method: 'GET', url: '/admin/users/x' })

    expect(bad.statusCode).toBe(401)
    expect(badId.statusCode).toBe(401)
  })
})

describe('GET /admin/users', () => {
  it('applies the defaults and answers the service result', async () => {
    const app = await buildApp(allowAdmin)
    adminUsersService.list.mockResolvedValue({
      items: [],
      page: 1,
      pageSize: 20,
      total: 72
    })

    const response = await app.inject({ method: 'GET', url: '/admin/users' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ total: 72, pageSize: 20 })
    expect(adminUsersService.list).toHaveBeenCalledWith({
      q: undefined,
      filter: 'all',
      page: 1
    })
  })

  it('parses and trims the parameters', async () => {
    const app = await buildApp(allowAdmin)

    await app.inject({
      method: 'GET',
      url: '/admin/users?q=%20kenzo%20&filter=noTerms&page=3'
    })

    expect(adminUsersService.list).toHaveBeenCalledWith({
      q: 'kenzo',
      filter: 'noTerms',
      page: 3
    })
  })

  it.each([
    '?page=0',
    '?page=10001',
    '?page=abc',
    '?filter=suspended',
    `?q=${'a'.repeat(101)}`
  ])('rejects %s with a 400 and never reaches the service', async query => {
    const app = await buildApp(allowAdmin)

    const response = await app.inject({
      method: 'GET',
      url: `/admin/users${query}`
    })

    expect(response.statusCode).toBe(400)
    expect(adminUsersService.list).not.toHaveBeenCalled()
  })

  it('a failure in the service is a 500 with the generic message, no internals', async () => {
    const app = await buildApp(allowAdmin)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    adminUsersService.list.mockRejectedValue(
      new Error('relation "users" does not exist')
    )

    const response = await app.inject({ method: 'GET', url: '/admin/users' })

    expect(response.statusCode).toBe(500)
    expect(response.json().message).toBe('Internal server error')
  })
})

describe('GET /admin/users/summary', () => {
  it('answers the service result', async () => {
    const app = await buildApp(allowAdmin)
    adminUsersService.summary.mockResolvedValue({ total: 72, active7d: 4 })

    const response = await app.inject({
      method: 'GET',
      url: '/admin/users/summary'
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ total: 72, active7d: 4 })
  })

  it('a failure in the service is a 500 with the generic message', async () => {
    const app = await buildApp(allowAdmin)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    adminUsersService.summary.mockRejectedValue(new Error('connection refused'))

    const response = await app.inject({
      method: 'GET',
      url: '/admin/users/summary'
    })

    expect(response.statusCode).toBe(500)
    expect(response.json().message).toBe('Internal server error')
  })
})

describe('GET /admin/users/:id', () => {
  it('passes the id to the service', async () => {
    const app = await buildApp(allowAdmin)

    const response = await app.inject({
      method: 'GET',
      url: `/admin/users/${USER_ID}`
    })

    expect(response.statusCode).toBe(200)
    expect(adminUsersService.detail).toHaveBeenCalledWith(USER_ID)
  })

  it('rejects an id that is not a uuid with a 400', async () => {
    const app = await buildApp(allowAdmin)

    const response = await app.inject({
      method: 'GET',
      url: '/admin/users/nope'
    })

    expect(response.statusCode).toBe(400)
    expect(adminUsersService.detail).not.toHaveBeenCalled()
  })

  it('a missing user is the 404 the service raised', async () => {
    const app = await buildApp(allowAdmin)
    adminUsersService.detail.mockRejectedValue(
      new ClientError('Usuário não encontrado.', 404)
    )

    const response = await app.inject({
      method: 'GET',
      url: `/admin/users/${USER_ID}`
    })

    expect(response.statusCode).toBe(404)
  })

  it('a failure in the service is a 500 with the generic message', async () => {
    const app = await buildApp(allowAdmin)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    adminUsersService.detail.mockRejectedValue(new Error('boom'))

    const response = await app.inject({
      method: 'GET',
      url: `/admin/users/${USER_ID}`
    })

    expect(response.statusCode).toBe(500)
    expect(response.json().message).toBe('Internal server error')
  })
})

describe('the settings routes are behind the admin guard', () => {
  it.each([
    ['GET', undefined],
    ['PUT', { signupsOpen: false }]
  ] as const)(
    '%s /admin/settings answers 401 and never reaches the service',
    async (method, payload) => {
      const app = await buildApp(denyAll)

      const response = await app.inject({
        method,
        url: '/admin/settings',
        payload
      })

      expect(response.statusCode).toBe(401)
      expect(adminSettingsService.get).not.toHaveBeenCalled()
      expect(adminSettingsService.update).not.toHaveBeenCalled()
    }
  )

  it('the guard runs before validation, so a bad body is a 401 and not a 400 for a stranger', async () => {
    const app = await buildApp(denyAll)

    const response = await app.inject({
      method: 'PUT',
      url: '/admin/settings',
      payload: { importsPerUserPerHour: 0, bannerText: 'x' }
    })

    expect(response.statusCode).toBe(401)
  })
})

describe('GET /admin/settings', () => {
  it('answers the service result', async () => {
    const app = await buildApp(allowAdmin)
    adminSettingsService.get.mockResolvedValue({
      settings: { signupsOpen: true },
      termsPending: 3
    })

    const response = await app.inject({ method: 'GET', url: '/admin/settings' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      settings: { signupsOpen: true },
      termsPending: 3
    })
  })

  it('a failure in the service is a 500 with the generic message, no internals', async () => {
    const app = await buildApp(allowAdmin)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    adminSettingsService.get.mockRejectedValue(
      new Error('relation "app_settings" does not exist')
    )

    const response = await app.inject({ method: 'GET', url: '/admin/settings' })

    expect(response.statusCode).toBe(500)
    expect(response.json().message).toBe('Internal server error')
  })
})

describe('PUT /admin/settings', () => {
  it('passes the actor, the body and the ip to the service', async () => {
    const app = await buildApp(allowAdmin)

    const response = await app.inject({
      method: 'PUT',
      url: '/admin/settings',
      payload: { signupsOpen: false }
    })

    expect(response.statusCode).toBe(200)
    expect(adminSettingsService.update).toHaveBeenCalledWith(
      'admin-1',
      { signupsOpen: false },
      expect.any(String)
    )
  })

  it('answers the keys that really changed', async () => {
    const app = await buildApp(allowAdmin)
    adminSettingsService.update.mockResolvedValue({
      settings: {},
      termsPending: 0,
      changed: []
    })

    const response = await app.inject({
      method: 'PUT',
      url: '/admin/settings',
      payload: { signupsOpen: true }
    })

    expect(response.json().changed).toEqual([])
  })

  it('a validation error from the service is a 400 with the fields in error', async () => {
    const app = await buildApp(allowAdmin)
    adminSettingsService.update.mockImplementation(
      async (_actor: string, body: unknown) =>
        AdminUpdateSettingsBodySchema.parse(body)
    )

    const response = await app.inject({
      method: 'PUT',
      url: '/admin/settings',
      payload: { importsPerUserPerHour: 0, popularSyncTime: '99:99' }
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatchObject({
      importsPerUserPerHour: expect.any(Array),
      popularSyncTime: expect.any(Array)
    })
  })

  it('a failure in the service is a 500 with the generic message', async () => {
    const app = await buildApp(allowAdmin)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    adminSettingsService.update.mockRejectedValue(new Error('boom'))

    const response = await app.inject({
      method: 'PUT',
      url: '/admin/settings',
      payload: { signupsOpen: false }
    })

    expect(response.statusCode).toBe(500)
    expect(response.json().message).toBe('Internal server error')
  })
})
