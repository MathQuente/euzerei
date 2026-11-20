import { FastifyReply, FastifyRequest } from 'fastify'
import * as AuthSchema from '../schemas/auth.schema'
import { PanelAuthService } from '../services/panel-auth.service'
import { readBearerToken } from '../utils/panel-token'
import { respondUnauthorized } from '../utils/respond-unauthorized'

export class PanelAuthController {
  constructor(private panelAuthService: PanelAuthService) {}

  async login(request: FastifyRequest, reply: FastifyReply) {
    const { email, password } = AuthSchema.LoginBodySchema.parse(request.body)

    const result = await this.panelAuthService.login(
      email,
      password,
      request.ip
    )

    return reply.send(result)
  }

  async logout(request: FastifyRequest, reply: FastifyReply) {
    const token = readBearerToken(request.headers.authorization)
    if (!token) return respondUnauthorized(reply)

    await this.panelAuthService.logout(token, request.user.userId, request.ip)

    return reply.status(204).send()
  }

  async me(request: FastifyRequest, reply: FastifyReply) {
    const profile = await this.panelAuthService.profile(request.user.userId)
    if (!profile) return respondUnauthorized(reply)

    return reply.send(profile)
  }
}
