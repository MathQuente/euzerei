import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { AdminReviewsController } from '../controllers/admin-reviews.controller'
import { AdminReviewsService } from '../services/admin-reviews.service'

export async function adminReviewsRoutes(app: FastifyInstance) {
  const controller = new AdminReviewsController(new AdminReviewsService())
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.get('/', async (request, reply) => controller.list(request, reply))
  typed.get('/summary', async (request, reply) =>
    controller.summary(request, reply)
  )
  typed.get('/:id', async (request, reply) => controller.detail(request, reply))
}
