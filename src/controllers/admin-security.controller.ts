import { FastifyReply, FastifyRequest } from 'fastify'
import {
  BlockParamsSchema,
  SessionParamsSchema
} from '../schemas/admin-security.schema'
import { AdminSecurityService } from '../services/admin-security.service'

export class AdminSecurityController {
  constructor(private adminSecurityService: AdminSecurityService) {}

  async summary(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.adminSecurityService.summary())
  }

  async blocks(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.adminSecurityService.blocks())
  }

  async sessions(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.adminSecurityService.sessions())
  }

  async releaseBlock(request: FastifyRequest, reply: FastifyReply) {
    const { id } = BlockParamsSchema.parse(request.params)

    return reply.send(
      await this.adminSecurityService.releaseBlock(id, {
        actorId: request.user.userId,
        ip: request.ip
      })
    )
  }

  async endSession(request: FastifyRequest, reply: FastifyReply) {
    const { id } = SessionParamsSchema.parse(request.params)

    return reply.send(
      await this.adminSecurityService.endSession(id, {
        actorId: request.user.userId,
        ip: request.ip
      })
    )
  }

  async protections(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(this.adminSecurityService.protections())
  }
}
