import { FastifyRequest } from 'fastify'

export function userRateLimit(prefix: string, max: number) {
  return {
    max,
    timeWindow: '1 minute',
    keyGenerator: async (request: FastifyRequest) => {
      try {
        await request.jwtVerify({ onlyCookie: true })
        return `${prefix}:${request.user.userId}`
      } catch {
        return request.ip
      }
    }
  }
}
