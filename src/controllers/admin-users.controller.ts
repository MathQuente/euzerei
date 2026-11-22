import { FastifyReply, FastifyRequest } from 'fastify'
import {
  AdminUserDeleteQuerySchema,
  AdminUserParamsSchema,
  AdminUsersListQuerySchema
} from '../schemas/admin-users.schema'
import { AdminUserActionsService } from '../services/admin-user-actions.service'
import { AdminUsersService } from '../services/admin-users.service'

export class AdminUsersController {
  constructor(
    private adminUsersService: AdminUsersService,
    private actions: AdminUserActionsService
  ) {}

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

  async suspend(request: FastifyRequest, reply: FastifyReply) {
    const { id } = AdminUserParamsSchema.parse(request.params)

    return reply.send(await this.actions.suspend(id, this.actor(request)))
  }

  async reactivate(request: FastifyRequest, reply: FastifyReply) {
    const { id } = AdminUserParamsSchema.parse(request.params)

    return reply.send(await this.actions.reactivate(id, this.actor(request)))
  }

  async deleteAccount(request: FastifyRequest, reply: FastifyReply) {
    const { id } = AdminUserParamsSchema.parse(request.params)
    const { handle } = AdminUserDeleteQuerySchema.parse(request.query)

    return reply.send(
      await this.actions.deleteAccount(id, handle, this.actor(request))
    )
  }

  private actor(request: FastifyRequest) {
    return { actorId: request.user.userId, ip: request.ip }
  }
}
