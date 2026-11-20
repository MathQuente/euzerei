import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { PanelAuthController } from '../controllers/panel-auth.controller'
import { AdminRepository } from '../repositories/admin.repository'
import { AuthRepository } from '../repositories/auth.repository'
import { CacheRepository } from '../repositories/cache.repository'
import { AuditService } from '../services/audit.service'
import { AuthService } from '../services/auth.service'
import { PanelAuthService } from '../services/panel-auth.service'

export function buildPanelAuthController(app: FastifyInstance) {
  const cacheRepository = new CacheRepository()
  const authService = new AuthService(
    new AuthRepository(),
    app.jwt,
    cacheRepository
  )
  const panelAuthService = new PanelAuthService(
    authService,
    new AdminRepository(),
    app.jwt,
    cacheRepository,
    new AuditService()
  )
  return new PanelAuthController(panelAuthService)
}

export async function panelAuthRoutes(app: FastifyInstance) {
  const controller = buildPanelAuthController(app)

  app.withTypeProvider<ZodTypeProvider>().post(
    '/login',
    {
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '1 minute'
        }
      }
    },
    async (request, reply) => controller.login(request, reply)
  )

  app
    .withTypeProvider<ZodTypeProvider>()
    .post(
      '/logout',
      { preHandler: [app.authenticateAdmin] },
      async (request, reply) => controller.logout(request, reply)
    )
}
