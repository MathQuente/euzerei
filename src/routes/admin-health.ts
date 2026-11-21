import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { AdminHealthController } from '../controllers/admin-health.controller'
import { AdminHealthRepository } from '../repositories/admin-health.repository'
import { AdminHealthService } from '../services/admin-health.service'

export async function adminHealthRoutes(app: FastifyInstance) {
  const controller = new AdminHealthController(
    new AdminHealthService(new AdminHealthRepository())
  )

  app
    .withTypeProvider<ZodTypeProvider>()
    .get('/', async (request, reply) => controller.health(request, reply))
}
