import { FastifyReply, FastifyRequest } from 'fastify'
import { AdminOverviewService } from '../services/admin-overview.service'

export class AdminOverviewController {
  constructor(private adminOverviewService: AdminOverviewService) {}

  async metrics(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.adminOverviewService.metrics())
  }

  async catalog(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.adminOverviewService.catalog())
  }
}
