import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { AdminUsersController } from '../controllers/admin-users.controller'
import { importQueues, importQueuesRedis } from '../queues/import-queues'
import { ImportQueueRepository } from '../repositories/import-queue.repository'
import { AdminUserActionsService } from '../services/admin-user-actions.service'
import { AdminUsersService } from '../services/admin-users.service'

export async function adminUsersRoutes(app: FastifyInstance) {
  const controller = new AdminUsersController(
    new AdminUsersService(),
    new AdminUserActionsService(
      undefined,
      undefined,
      undefined,
      new ImportQueueRepository(importQueues, importQueuesRedis)
    )
  )
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.get('/', async (request, reply) => controller.list(request, reply))
  typed.get('/summary', async (request, reply) =>
    controller.summary(request, reply)
  )
  typed.get('/:id', async (request, reply) => controller.detail(request, reply))
  typed.post('/:id/suspend', async (request, reply) =>
    controller.suspend(request, reply)
  )
  typed.post('/:id/reactivate', async (request, reply) =>
    controller.reactivate(request, reply)
  )
  typed.delete('/:id', async (request, reply) =>
    controller.deleteAccount(request, reply)
  )
}
