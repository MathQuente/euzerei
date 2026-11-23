import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { AdminReviewsController } from '../controllers/admin-reviews.controller'
import { AdminReviewActionsService } from '../services/admin-review-actions.service'
import { AdminReviewsService } from '../services/admin-reviews.service'

export async function adminReviewsRoutes(app: FastifyInstance) {
  const controller = new AdminReviewsController(
    new AdminReviewsService(),
    new AdminReviewActionsService()
  )
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.get('/', async (request, reply) => controller.list(request, reply))
  typed.get('/summary', async (request, reply) =>
    controller.summary(request, reply)
  )
  typed.get('/:id', async (request, reply) => controller.detail(request, reply))
  typed.post('/:id/hide', async (request, reply) =>
    controller.hide(request, reply)
  )
  typed.post('/:id/restore', async (request, reply) =>
    controller.restore(request, reply)
  )
  typed.post('/:id/dismiss', async (request, reply) =>
    controller.dismiss(request, reply)
  )
  typed.delete('/:id', async (request, reply) =>
    controller.remove(request, reply)
  )
}
