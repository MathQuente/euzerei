import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { buildPanelAuthController } from './panel-auth'
import { adminAuditRoutes } from './admin-audit'
import { adminSettingsRoutes } from './admin-settings'
import { adminUsersRoutes } from './admin-users'
import { adminCatalogRoutes } from './admin-catalog'
import { adminOverviewRoutes } from './admin-overview'
import { adminSecurityRoutes } from './admin-security'
import { adminReviewsRoutes } from './admin-reviews'
import { adminHealthRoutes } from './admin-health'
import { adminImportsRoutes, adminQueuesRoutes } from './admin-imports'

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticateAdmin)

  const panelAuthController = buildPanelAuthController(app)

  app
    .withTypeProvider<ZodTypeProvider>()
    .get('/me', async (request, reply) =>
      panelAuthController.me(request, reply)
    )

  app.register(adminHealthRoutes, { prefix: '/health' })
  app.register(adminSecurityRoutes, { prefix: '/security' })
  app.register(adminOverviewRoutes, { prefix: '/overview' })
  app.register(adminCatalogRoutes, { prefix: '/catalog' })
  app.register(adminAuditRoutes, { prefix: '/audit' })
  app.register(adminImportsRoutes, { prefix: '/imports' })
  app.register(adminQueuesRoutes, { prefix: '/queues' })
  app.register(adminUsersRoutes, { prefix: '/users' })
  app.register(adminReviewsRoutes, { prefix: '/reviews' })
  app.register(adminSettingsRoutes, { prefix: '/settings' })
}
