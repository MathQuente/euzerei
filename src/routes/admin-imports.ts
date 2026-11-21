import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { AdminImportsController } from '../controllers/admin-imports.controller'
import { importQueues, importQueuesRedis } from '../queues/import-queues'
import { AdminRepository } from '../repositories/admin.repository'
import { ImportQueueRepository } from '../repositories/import-queue.repository'
import { AdminImportsService } from '../services/admin-imports.service'

function buildController() {
  return new AdminImportsController(
    new AdminImportsService(
      new ImportQueueRepository(importQueues, importQueuesRedis),
      new AdminRepository()
    )
  )
}

export async function adminImportsRoutes(app: FastifyInstance) {
  const controller = buildController()
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.get('/', async (request, reply) => controller.list(request, reply))
  typed.get('/summary', async (request, reply) =>
    controller.summary(request, reply)
  )
  typed.get('/failures', async (request, reply) =>
    controller.failures(request, reply)
  )
}

export async function adminQueuesRoutes(app: FastifyInstance) {
  const controller = buildController()

  app
    .withTypeProvider<ZodTypeProvider>()
    .get('/', async (request, reply) => controller.queues(request, reply))
}
