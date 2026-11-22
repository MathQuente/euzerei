import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { AdminSecurityController } from '../controllers/admin-security.controller'
import { AdminSecurityRepository } from '../repositories/admin-security.repository'
import { AdminSecurityService } from '../services/admin-security.service'

export async function adminSecurityRoutes(app: FastifyInstance) {
  const controller = new AdminSecurityController(
    new AdminSecurityService(new AdminSecurityRepository())
  )
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.get('/summary', async (request, reply) =>
    controller.summary(request, reply)
  )
  typed.get('/blocks', async (request, reply) =>
    controller.blocks(request, reply)
  )
  typed.get('/sessions', async (request, reply) =>
    controller.sessions(request, reply)
  )
  typed.delete('/blocks/:id', async (request, reply) =>
    controller.releaseBlock(request, reply)
  )
  typed.delete('/sessions/:id', async (request, reply) =>
    controller.endSession(request, reply)
  )
  typed.get('/protections', async (request, reply) =>
    controller.protections(request, reply)
  )
}
