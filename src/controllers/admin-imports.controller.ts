import { FastifyReply, FastifyRequest } from 'fastify'
import { ImportListQuerySchema } from '../schemas/admin-imports.schema'
import {
  FailedJobsQuerySchema,
  QueueStoreParamsSchema
} from '../schemas/admin-queues.schema'
import { AdminImportsService } from '../services/admin-imports.service'

export class AdminImportsController {
  constructor(private adminImportsService: AdminImportsService) {}

  async list(request: FastifyRequest, reply: FastifyReply) {
    const query = ImportListQuerySchema.parse(request.query)

    return reply.send(await this.adminImportsService.list(query))
  }

  async summary(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.adminImportsService.summary())
  }

  async failures(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.adminImportsService.failures())
  }

  async pauseQueue(request: FastifyRequest, reply: FastifyReply) {
    return this.setQueuePaused(request, reply, true)
  }

  async resumeQueue(request: FastifyRequest, reply: FastifyReply) {
    return this.setQueuePaused(request, reply, false)
  }

  private async setQueuePaused(
    request: FastifyRequest,
    reply: FastifyReply,
    paused: boolean
  ) {
    const { store } = QueueStoreParamsSchema.parse(request.params)

    return reply.send(
      await this.adminImportsService.setQueuePaused(store, paused, {
        actorId: request.user.userId,
        ip: request.ip
      })
    )
  }

  async queues(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send(await this.adminImportsService.queues())
  }

  async failedJobs(request: FastifyRequest, reply: FastifyReply) {
    const { store } = FailedJobsQuerySchema.parse(request.query)

    return reply.send(await this.adminImportsService.failedJobs(store))
  }
}
