import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { AdminCatalogController } from '../controllers/admin-catalog.controller'
import { AdminCatalogRepository } from '../repositories/admin-catalog.repository'
import { AdminCatalogService } from '../services/admin-catalog.service'

let shared: AdminCatalogService | undefined

export function getAdminCatalogService() {
  shared ??= new AdminCatalogService(new AdminCatalogRepository())
  return shared
}

export async function adminCatalogRoutes(app: FastifyInstance) {
  const controller = new AdminCatalogController(getAdminCatalogService())
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.get('/summary', async (request, reply) =>
    controller.summary(request, reply)
  )
  typed.get('/jobs', async (request, reply) => controller.jobs(request, reply))
  typed.get('/games', async (request, reply) =>
    controller.search(request, reply)
  )
  typed.get('/games/:igdbId', async (request, reply) =>
    controller.game(request, reply)
  )
  typed.get('/top-added', async (request, reply) =>
    controller.topAdded(request, reply)
  )
}
