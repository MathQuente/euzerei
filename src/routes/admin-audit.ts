import { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { AdminAuditController } from '../controllers/admin-audit.controller'
import { AuditQueryService } from '../services/audit-query.service'

export async function adminAuditRoutes(app: FastifyInstance) {
  const controller = new AdminAuditController(new AuditQueryService())

  app
    .withTypeProvider<ZodTypeProvider>()
    .get('/', async (request, reply) => controller.list(request, reply))

  app
    .withTypeProvider<ZodTypeProvider>()
    .get('/summary', async (request, reply) =>
      controller.summary(request, reply)
    )
}
