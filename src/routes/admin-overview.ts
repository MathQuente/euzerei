import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { AdminOverviewController } from '../controllers/admin-overview.controller'
import { AdminOverviewRepository } from '../repositories/admin-overview.repository'
import { AdminOverviewService } from '../services/admin-overview.service'
import { getAdminCatalogService } from './admin-catalog'

export async function adminOverviewRoutes(app: FastifyInstance) {
  const controller = new AdminOverviewController(
    new AdminOverviewService(
      new AdminOverviewRepository(),
      getAdminCatalogService()
    )
  )
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.get('/metrics', async (request, reply) =>
    controller.metrics(request, reply)
  )
  typed.get('/catalog', async (request, reply) =>
    controller.catalog(request, reply)
  )
}
