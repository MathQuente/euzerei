import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { AdminSettingsController } from '../controllers/admin-settings.controller'
import { AdminSettingsService } from '../services/admin-settings.service'

export async function adminSettingsRoutes(app: FastifyInstance) {
  const controller = new AdminSettingsController(new AdminSettingsService())
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.get('/', async (request, reply) => controller.get(request, reply))
  typed.put('/', async (request, reply) => controller.update(request, reply))
}
