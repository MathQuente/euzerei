import { FastifyReply, FastifyRequest } from 'fastify'
import {
  CatalogGameParamsSchema,
  CatalogJobParamsSchema,
  CatalogRunBodySchema,
  CatalogSearchQuerySchema,
  CatalogTopAddedQuerySchema
} from '../schemas/admin-catalog.schema'
import { AdminCatalogRunService } from '../services/admin-catalog-run.service'
import { AdminCatalogService } from '../services/admin-catalog.service'

export class AdminCatalogController {
  constructor(
    private adminCatalogService: AdminCatalogService,
    private runs: AdminCatalogRunService
  ) {}

  async summary(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.adminCatalogService.summary())
  }

  async jobs(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.adminCatalogService.jobs())
  }

  async search(request: FastifyRequest, reply: FastifyReply) {
    const { q } = CatalogSearchQuerySchema.parse(request.query)

    return reply.send(await this.adminCatalogService.search(q))
  }

  async game(request: FastifyRequest, reply: FastifyReply) {
    const { igdbId } = CatalogGameParamsSchema.parse(request.params)

    return reply.send(await this.adminCatalogService.game(igdbId))
  }

  async topAdded(request: FastifyRequest, reply: FastifyReply) {
    const { days } = CatalogTopAddedQuerySchema.parse(request.query)

    return reply.send(await this.adminCatalogService.topAdded(days))
  }

  async runJob(request: FastifyRequest, reply: FastifyReply) {
    const { key } = CatalogJobParamsSchema.parse(request.params)
    const { mode } = CatalogRunBodySchema.parse(request.body)

    return reply.status(202).send(
      await this.runs.start(key, mode, {
        actorId: request.user.userId,
        ip: request.ip
      })
    )
  }

  async currentRun(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.runs.current())
  }

  async cancelRun(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.runs.cancel())
  }
}
