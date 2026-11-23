import { FastifyReply, FastifyRequest } from 'fastify'
import {
  AdminReviewParamsSchema,
  AdminReviewsListQuerySchema
} from '../schemas/admin-reviews.schema'
import { AdminReviewsService } from '../services/admin-reviews.service'

export class AdminReviewsController {
  constructor(private service: AdminReviewsService) {}

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
}
