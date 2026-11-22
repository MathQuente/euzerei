import { FastifyReply, FastifyRequest } from 'fastify'
import {
  CatalogGameParamsSchema,
  CatalogSearchQuerySchema,
  CatalogTopAddedQuerySchema
} from '../schemas/admin-catalog.schema'
import { AdminCatalogService } from '../services/admin-catalog.service'

export class AdminCatalogController {
  constructor(private adminCatalogService: AdminCatalogService) {}

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
}
