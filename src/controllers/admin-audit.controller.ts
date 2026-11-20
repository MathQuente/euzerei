import { FastifyReply, FastifyRequest } from 'fastify'
import { AuditListQuerySchema } from '../schemas/audit.schema'
import { AuditQueryService } from '../services/audit-query.service'

export class AdminAuditController {
  constructor(private auditQueryService: AuditQueryService) {}

  async list(request: FastifyRequest, reply: FastifyReply) {
    const query = AuditListQuerySchema.parse(request.query)

    return reply.send(await this.auditQueryService.list(query))
  }

  async summary(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.auditQueryService.summary())
  }
}
