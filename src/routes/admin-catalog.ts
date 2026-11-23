import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { AdminCatalogController } from '../controllers/admin-catalog.controller'
import { AdminCatalogRepository } from '../repositories/admin-catalog.repository'
import { AdminCatalogRunService } from '../services/admin-catalog-run.service'
import { AdminCatalogService } from '../services/admin-catalog.service'

let shared: AdminCatalogService | undefined

export function getAdminCatalogService() {
  shared ??= new AdminCatalogService(new AdminCatalogRepository())
  return shared
}

let sharedRuns: AdminCatalogRunService | undefined

/** Um só por processo: a trava de "um job por vez" e o filho em andamento vivem aqui. */
export function getAdminCatalogRunService() {
  sharedRuns ??= new AdminCatalogRunService(undefined, undefined, {
    onFinished: () => getAdminCatalogService().invalidate()
  })
  return sharedRuns
}

export async function adminCatalogRoutes(app: FastifyInstance) {
  const controller = new AdminCatalogController(
    getAdminCatalogService(),
    getAdminCatalogRunService()
  )
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.get('/summary', async (request, reply) =>
    controller.summary(request, reply)
  )
  typed.get('/jobs', async (request, reply) => controller.jobs(request, reply))
  typed.post('/jobs/:key/run', async (request, reply) =>
    controller.runJob(request, reply)
  )
  typed.get('/runs/current', async (request, reply) =>
    controller.currentRun(request, reply)
  )
  typed.post('/runs/current/cancel', async (request, reply) =>
    controller.cancelRun(request, reply)
  )
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
