import { FastifyReply, FastifyRequest } from 'fastify'
import { ImportListQuerySchema } from '../schemas/admin-imports.schema'
import { AdminImportsService } from '../services/admin-imports.service'

export class AdminImportsController {
  constructor(private adminImportsService: AdminImportsService) {}

  async list(request: FastifyRequest, reply: FastifyReply) {
    const query = ImportListQuerySchema.parse(request.query)

    return reply.send(await this.adminImportsService.list(query))
  }

  async summary(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.adminImportsService.summary())
  }

  async failures(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.adminImportsService.failures())
  }

  async queues(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.adminImportsService.queues())
  }
}
