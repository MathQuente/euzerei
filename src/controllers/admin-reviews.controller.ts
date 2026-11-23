import { FastifyReply, FastifyRequest } from 'fastify'
import {
  AdminReviewDeleteQuerySchema,
  AdminReviewParamsSchema,
  AdminReviewsListQuerySchema
} from '../schemas/admin-reviews.schema'
import {
  AdminReviewActionsService,
  type ReviewActionActor
} from '../services/admin-review-actions.service'
import { AdminReviewsService } from '../services/admin-reviews.service'

export class AdminReviewsController {
  constructor(
    private service: AdminReviewsService,
    private actions: AdminReviewActionsService
  ) {}

  private actor(request: FastifyRequest): ReviewActionActor {
    return {
      actorId: (request.user as { userId: string }).userId,
      ip: request.ip
    }
  }

  async list(request: FastifyRequest, reply: FastifyReply) {
    const query = AdminReviewsListQuerySchema.parse(request.query)
    return reply.send(await this.service.list(query))
  }

  async summary(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.service.summary())
  }

  async detail(request: FastifyRequest, reply: FastifyReply) {
    const { id } = AdminReviewParamsSchema.parse(request.params)
    return reply.send(await this.service.detail(id))
  }

  async hide(request: FastifyRequest, reply: FastifyReply) {
    const { id } = AdminReviewParamsSchema.parse(request.params)
    return reply.send(await this.actions.hide(id, this.actor(request)))
  }

  async restore(request: FastifyRequest, reply: FastifyReply) {
    const { id } = AdminReviewParamsSchema.parse(request.params)
    return reply.send(await this.actions.restore(id, this.actor(request)))
  }

  async dismiss(request: FastifyRequest, reply: FastifyReply) {
    const { id } = AdminReviewParamsSchema.parse(request.params)
    return reply.send(await this.actions.dismiss(id, this.actor(request)))
  }

  async remove(request: FastifyRequest, reply: FastifyReply) {
    const { id } = AdminReviewParamsSchema.parse(request.params)
    const { handle } = AdminReviewDeleteQuerySchema.parse(request.query)
    return reply.send(
      await this.actions.removeReview(id, handle, this.actor(request))
    )
  }
}
