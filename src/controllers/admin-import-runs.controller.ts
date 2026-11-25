import { FastifyReply, FastifyRequest } from 'fastify'
import { ImportRunsSummaryQuerySchema } from '../schemas/admin-imports.schema'
import { AdminImportRunsService } from '../services/admin-import-runs.service'

export class AdminImportRunsController {
  constructor(private service: AdminImportRunsService) {}

  async summary(request: FastifyRequest, reply: FastifyReply) {
    const { days } = ImportRunsSummaryQuerySchema.parse(request.query)

    return reply.send(await this.service.summary(days))
  }
}
