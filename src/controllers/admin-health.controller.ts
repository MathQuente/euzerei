import { FastifyReply, FastifyRequest } from 'fastify'
import { AdminHealthService } from '../services/admin-health.service'

export class AdminHealthController {
  constructor(private adminHealthService: AdminHealthService) {}

  async health(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.adminHealthService.health())
  }
}
