import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { sendProblem } from './utils/problem'

export const ORIGIN_SECRET_HEADER = 'x-origin-secret'
export const MIN_ORIGIN_SECRET_LENGTH = 32

type OriginGuardOptions = {
  secret: string | undefined
  exemptPaths?: string[]
}

function digest(value: string) {
  return crypto.createHash('sha256').update(value).digest()
}

export function registerOriginGuard(
  app: FastifyInstance,
  { secret, exemptPaths = ['/health'] }: OriginGuardOptions
): boolean {
  if (!secret) return false
  if (secret.length < MIN_ORIGIN_SECRET_LENGTH) {
    throw new Error(
      `ORIGIN_SECRET must have at least ${MIN_ORIGIN_SECRET_LENGTH} characters`
    )
  }

  const expected = digest(secret)

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]
    if (exemptPaths.includes(path)) return

    const sent = request.headers[ORIGIN_SECRET_HEADER]
    const received = typeof sent === 'string' ? sent : ''
    if (!crypto.timingSafeEqual(digest(received), expected)) {
      return sendProblem(reply, 403, { message: 'Forbidden' })
    }
  })

  return true
}
