import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { AdminImportsController } from '../controllers/admin-imports.controller'
import { importQueues, importQueuesRedis } from '../queues/import-queues'
import { AdminRepository } from '../repositories/admin.repository'
import { ImportQueueRepository } from '../repositories/import-queue.repository'
import { AdminImportsService } from '../services/admin-imports.service'

let shared: AdminImportsController | undefined

function buildController() {
  shared ??= new AdminImportsController(
    new AdminImportsService(
      new ImportQueueRepository(importQueues, importQueuesRedis),
      new AdminRepository()
    )
  )
  return shared
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
    .get('/failed', async (request, reply) =>
      controller.failedJobs(request, reply)
    )
    .post('/:store/jobs/:id/retry', async (request, reply) =>
      controller.retryJob(request, reply)
    )
    .delete('/:store/jobs/:id', async (request, reply) =>
      controller.discardJob(request, reply)
    )
    .post('/:store/pause', async (request, reply) =>
      controller.pauseQueue(request, reply)
    )
    .post('/:store/resume', async (request, reply) =>
      controller.resumeQueue(request, reply)
    )
}
