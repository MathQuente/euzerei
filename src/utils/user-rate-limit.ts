import { FastifyRequest } from 'fastify'

// Runs in preHandler, after `authenticate`, so request.user is set even when
// the access token was renewed from the refresh cookie. In onRequest a request
// carrying only the refresh cookie had no user and fell back to the IP key.
export function userRateLimit(
  prefix: string,
  max: number,
  timeWindow: string = '1 minute'
) {
  return {
    max,
    timeWindow,
    hook: 'preHandler' as const,
    keyGenerator: (request: FastifyRequest) => {
      const userId = (request.user as { userId?: string } | undefined)?.userId
      return userId ? `${prefix}:user:${userId}` : `${prefix}:ip:${request.ip}`
    }
  }
}
