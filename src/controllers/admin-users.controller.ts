import { FastifyReply, FastifyRequest } from 'fastify'
import {
  AdminUserParamsSchema,
  AdminUsersListQuerySchema
} from '../schemas/admin-users.schema'
import { AdminUsersService } from '../services/admin-users.service'

export class AdminUsersController {
  constructor(private adminUsersService: AdminUsersService) {}

  async list(request: FastifyRequest, reply: FastifyReply) {
    const query = AdminUsersListQuerySchema.parse(request.query)

    return reply.send(await this.adminUsersService.list(query))
  }

  async summary(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.adminUsersService.summary())
  }

  async detail(request: FastifyRequest, reply: FastifyReply) {
    const { id } = AdminUserParamsSchema.parse(request.params)

    return reply.send(await this.adminUsersService.detail(id))
  }
}
