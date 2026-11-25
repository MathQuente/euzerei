import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import fastifyCookie from '@fastify/cookie'
import fastifyCors from '@fastify/cors'
import { AuthRepository } from './repositories/auth.repository'
import { AuthService, revokedAccessTokenKey } from './services/auth.service'
import { sessionsRevokedAtKey } from './utils/session-revocation'
import { CacheRepository } from './repositories/cache.repository'
import { clearAuthCookies, setAccessTokenCookie } from './utils/auth-cookies'
import { logError, respondUnavailable } from './utils/respond-unavailable'
import { respondUnauthorized } from './utils/respond-unauthorized'
import { AdminRepository } from './repositories/admin.repository'
import { passwordFingerprint, readBearerToken } from './utils/panel-token'
import { sendProblem } from './utils/problem'

const MIN_SECRET_LENGTH = 32

const authRepository = new AuthRepository()
const cacheRepository = new CacheRepository()
const adminRepository = new AdminRepository()

const RENEWABLE_ERROR_CODES = new Set([
  'FST_JWT_NO_AUTHORIZATION_IN_COOKIE',
  'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED'
])

function findActiveRefreshUser(fastify: FastifyInstance, refreshToken: string) {
  const authService = new AuthService(
    authRepository,
    fastify.jwt,
    cacheRepository
  )
  return authService.isRefreshTokenActive(refreshToken)
}

async function issueRenewedAccessToken(
  fastify: FastifyInstance,
  request: FastifyRequest,
  response: FastifyReply,
  userId: string
) {
  const newAccessToken = fastify.jwt.sign({ userId, tokenType: 'access' })

  request.cookies.accessToken = newAccessToken

  await verifyAccessCookie(request)

  setAccessTokenCookie(response, newAccessToken)
}

function verifyAccessCookie(request: FastifyRequest) {
  return request.jwtVerify({ onlyCookie: true })
}

/**
 * Lê as duas marcas de revogação num comando só: a do token e a da conta (`sessionsRevokedAt`).
 * Eram dois GET por requisição autenticada.
 */
async function readRevocation(
  token: string,
  userId: string
): Promise<{ tokenRevoked: boolean; revokedAt: unknown }> {
  const [revokedToken, revokedAt] = await cacheRepository.mget([
    revokedAccessTokenKey(token),
    sessionsRevokedAtKey(userId)
  ])
  return { tokenRevoked: revokedToken !== null, revokedAt }
}

async function isSessionRevoked(request: FastifyRequest): Promise<boolean> {
  const accessToken = request.cookies.accessToken
  if (!accessToken) return true

  const { userId, iat } = request.user as { userId: string; iat?: number }
  const { tokenRevoked, revokedAt } = await readRevocation(accessToken, userId)
  if (tokenRevoked) return true
  return typeof revokedAt === 'number' && (iat ?? 0) < revokedAt
}

interface PanelTokenPayload {
  userId: string
  tokenType?: string
  pv?: string
  iat?: number
}

async function isPanelTokenRevoked(
  token: string,
  payload: PanelTokenPayload
): Promise<boolean> {
  const { tokenRevoked, revokedAt } = await readRevocation(
    token,
    payload.userId
  )
  if (tokenRevoked) return true
  return typeof revokedAt === 'number' && (payload.iat ?? 0) < revokedAt
}

export class Jwt {
  private static getSecret(): string {
    const secret = process.env.SECRET_JWT_KEY
    if (!secret) {
      throw new Error('SECRET_JWT_KEY environment variable is required')
    }
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `SECRET_JWT_KEY must have at least ${MIN_SECRET_LENGTH} characters`
      )
    }
    return secret
  }

  public static initSetup(fastify: FastifyInstance) {
    this.registerJwtPlugin(fastify)
    this.registerCookiePlugin(fastify)
    this.authenticateDecorator(fastify)
    this.tryAuthenticateDecorator(fastify)
    this.authenticateAdminDecorator(fastify)
    this.registerCorsPlugin(fastify)
  }

  private static registerJwtPlugin(fastify: FastifyInstance) {
    fastify.register(fastifyJwt, {
      secret: this.getSecret(),
      sign: {
        expiresIn: '15m'
      },
      cookie: {
        cookieName: 'accessToken',
        signed: false
      }
    })
  }

  public static registerCorsPlugin = (fastify: FastifyInstance) => {
    if (!process.env.FRONTEND_URL) {
      throw new Error('FRONTEND_URL environment variable is required')
    }

    fastify.register(fastifyCors, {
      origin: process.env.FRONTEND_URL,
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
    })
  }

  private static authenticateDecorator = (fastify: FastifyInstance) => {
    fastify.decorate(
      'authenticate',
      async (request: FastifyRequest, response: FastifyReply) => {
        try {
          await verifyAccessCookie(request)

          if (
            request.user.tokenType === 'refresh' ||
            request.user.tokenType === 'panel'
          ) {
            return respondUnauthorized(response)
          }

          let revoked: boolean
          try {
            revoked = await isSessionRevoked(request)
          } catch (revocationCheckError) {
            return respondUnavailable(
              response,
              'Revocation check failed:',
              revocationCheckError
            )
          }

          if (revoked) {
            return respondUnauthorized(clearAuthCookies(response))
          }
        } catch (error) {
          const code = (error as { code?: string }).code
          if (!RENEWABLE_ERROR_CODES.has(code ?? '')) {
            return respondUnauthorized(response)
          }

          const refreshToken = request.cookies.refreshToken

          if (!refreshToken) {
            return respondUnauthorized(response)
          }

          let userId: string | null
          try {
            userId = await findActiveRefreshUser(fastify, refreshToken)
          } catch (refreshCheckError) {
            return respondUnavailable(
              response,
              'Refresh check failed:',
              refreshCheckError
            )
          }

          if (!userId) {
            return respondUnauthorized(clearAuthCookies(response))
          }

          try {
            await issueRenewedAccessToken(fastify, request, response, userId)
          } catch (renewalError) {
            return respondUnavailable(
              response,
              'Session renewal failed:',
              renewalError
            )
          }
        }
      }
    )
  }

  private static authenticateAdminDecorator = (fastify: FastifyInstance) => {
    fastify.decorate(
      'authenticateAdmin',
      async (request: FastifyRequest, response: FastifyReply) => {
        const token = readBearerToken(request.headers.authorization)
        if (!token) return respondUnauthorized(response)

        let payload: PanelTokenPayload
        try {
          payload = fastify.jwt.verify<PanelTokenPayload>(token)
        } catch {
          return respondUnauthorized(response)
        }
        if (payload.tokenType !== 'panel') return respondUnauthorized(response)

        let revoked: boolean
        try {
          revoked = await isPanelTokenRevoked(token, payload)
        } catch (revocationCheckError) {
          return respondUnavailable(
            response,
            'Panel revocation check failed:',
            revocationCheckError
          )
        }
        if (revoked) return respondUnauthorized(response)

        let admin: Awaited<ReturnType<AdminRepository['findById']>>
        try {
          admin = await adminRepository.findById(payload.userId)
        } catch (roleCheckError) {
          return respondUnavailable(
            response,
            'Panel role check failed:',
            roleCheckError
          )
        }

        if (
          !admin ||
          admin.suspendedAt ||
          payload.pv !== passwordFingerprint(admin.password)
        ) {
          return respondUnauthorized(response)
        }
        if (admin.role !== 'ADMIN') {
          return sendProblem(response, 403, {
            status: 'forbidden',
            message: 'Acesso restrito a administradores.'
          })
        }

        request.user = {
          userId: admin.id,
          tokenType: 'panel',
          iat: payload.iat
        } as typeof request.user
      }
    )
  }

  private static tryAuthenticateDecorator = (fastify: FastifyInstance) => {
    fastify.decorate(
      'tryAuthenticate',
      async (request: FastifyRequest, response: FastifyReply) => {
        try {
          await verifyAccessCookie(request)
        } catch (error) {
          const code = (error as { code?: string }).code
          const refreshToken = request.cookies.refreshToken

          if (RENEWABLE_ERROR_CODES.has(code ?? '') && refreshToken) {
            try {
              const userId = await findActiveRefreshUser(fastify, refreshToken)
              if (userId) {
                await issueRenewedAccessToken(
                  fastify,
                  request,
                  response,
                  userId
                )
                return
              }
            } catch (renewalError) {
              logError('Optional session renewal failed:', renewalError)
            }
            ;(request as { user?: unknown }).user = undefined
          }
          return
        }

        try {
          const isAccessToken =
            request.user.tokenType !== 'refresh' &&
            request.user.tokenType !== 'panel'
          if (isAccessToken && !(await isSessionRevoked(request))) return
        } catch (revocationCheckError) {
          logError('Revocation check failed:', revocationCheckError)
        }

        ;(request as { user?: unknown }).user = undefined
      }
    )
  }

  public static registerCookiePlugin = (fastify: FastifyInstance) => {
    fastify.register(fastifyCookie, { hook: 'onRequest' })
  }
}
