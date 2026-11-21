import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { AdminUsersController } from '../controllers/admin-users.controller'
import { AdminUsersService } from '../services/admin-users.service'

export async function adminUsersRoutes(app: FastifyInstance) {
  const controller = new AdminUsersController(new AdminUsersService())
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.get('/', async (request, reply) => controller.list(request, reply))
  typed.get('/summary', async (request, reply) =>
    controller.summary(request, reply)
  )
  typed.get('/:id', async (request, reply) => controller.detail(request, reply))
}
