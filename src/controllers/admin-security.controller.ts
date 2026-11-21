import { FastifyReply, FastifyRequest } from 'fastify'
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

  async protections(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(this.adminSecurityService.protections())
  }
}
