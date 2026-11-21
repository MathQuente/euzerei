import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { buildPanelAuthController } from './panel-auth'
import { adminAuditRoutes } from './admin-audit'
import { adminSettingsRoutes } from './admin-settings'
import { adminUsersRoutes } from './admin-users'
import { adminSecurityRoutes } from './admin-security'
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
  app.register(adminAuditRoutes, { prefix: '/audit' })
  app.register(adminImportsRoutes, { prefix: '/imports' })
  app.register(adminQueuesRoutes, { prefix: '/queues' })
  app.register(adminUsersRoutes, { prefix: '/users' })
  app.register(adminSettingsRoutes, { prefix: '/settings' })
}
