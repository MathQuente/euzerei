import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { buildPanelAuthController } from './panel-auth'

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticateAdmin)

  const panelAuthController = buildPanelAuthController(app)

  app
    .withTypeProvider<ZodTypeProvider>()
    .get('/me', async (request, reply) =>
      panelAuthController.me(request, reply)
    )
}
