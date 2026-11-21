import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { buildPanelAuthController } from './panel-auth'
import { adminAuditRoutes } from './admin-audit'
import { adminSettingsRoutes } from './admin-settings'
import { adminUsersRoutes } from './admin-users'
import { adminImportsRoutes, adminQueuesRoutes } from './admin-imports'

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticateAdmin)

  const panelAuthController = buildPanelAuthController(app)

  app
    .withTypeProvider<ZodTypeProvider>()
    .get('/me', async (request, reply) =>
      panelAuthController.me(request, reply)
    )

  app.register(adminAuditRoutes, { prefix: '/audit' })
  app.register(adminImportsRoutes, { prefix: '/imports' })
  app.register(adminQueuesRoutes, { prefix: '/queues' })
  app.register(adminUsersRoutes, { prefix: '/users' })
  app.register(adminSettingsRoutes, { prefix: '/settings' })
}
