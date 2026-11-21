import { FastifyReply, FastifyRequest } from 'fastify'
import { AdminSettingsService } from '../services/admin-settings.service'

export class AdminSettingsController {
  constructor(private adminSettingsService: AdminSettingsService) {}

  async get(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.adminSettingsService.get())
  }

  async update(request: FastifyRequest, reply: FastifyReply) {
    return reply.send(
      await this.adminSettingsService.update(
        request.user.userId,
        request.body,
        request.ip
      )
    )
  }
}
