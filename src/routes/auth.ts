import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AuthController } from '../controllers/auth.controller'
import { AuthRepository } from '../repositories/auth.repository'
import { AuthService, OAuthProvider } from '../services/auth.service'
import { CacheRepository } from '../repositories/cache.repository'
import { EmailService } from '../services/email.service'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import crypto from 'crypto'
import { z } from 'zod'
import { BASE_COOKIE_OPTIONS, setAuthCookies } from '../utils/auth-cookies'
import { sendProblem } from '../utils/problem'
import { ReauthRequiredError } from '../errors/reauth-required-error'
import {
  OAUTH_STATE_TTL_SECONDS,
  oauthStateKey,
  parseAcceptedTerms,
  readOAuthState,
  saveOAuthState
} from '../utils/oauth-state'
import { buildDiscordAuthUrl, buildGoogleAuthUrl } from '../utils/oauth-urls'
const OAUTH_STATE_COOKIE = 'oauth_state'

function setOAuthStateCookie(reply: FastifyReply, state: string) {
  reply.setCookie(OAUTH_STATE_COOKIE, state, {
    ...BASE_COOKIE_OPTIONS,
    maxAge: OAUTH_STATE_TTL_SECONDS
  })
}

function matchesOAuthStateCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  state: string
): boolean {
  const cookieState = request.cookies[OAUTH_STATE_COOKIE] ?? ''
  reply.clearCookie(OAUTH_STATE_COOKIE, BASE_COOKIE_OPTIONS)

  const expected = Buffer.from(state)
  const received = Buffer.from(cookieState)
  return (
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received)
  )
}

export async function authRoutes(app: FastifyInstance) {
  const authRepository = new AuthRepository()
  const cacheRepository = new CacheRepository()
  const emailService = new EmailService()
  const authService = new AuthService(
    authRepository,
    app.jwt,
    cacheRepository,
    emailService
  )
  const authController = new AuthController(authService)

  app.withTypeProvider<ZodTypeProvider>().post(
    '/register',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute'
        }
      }
    },
    async (request, reply) => authController.createUser(request, reply)
  )

  app.withTypeProvider<ZodTypeProvider>().post(
    '/register/confirm',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute'
        }
      }
    },
    async (request, reply) => authController.confirmRegistration(request, reply)
  )

  app.withTypeProvider<ZodTypeProvider>().post(
    '/login',
    {
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '1 minute'
        }
      }
    },
    async (request, reply) => authController.loginHandler(request, reply)
  )

  app.withTypeProvider<ZodTypeProvider>().post(
    '/forgot-password',
    {
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '1 minute'
        }
      }
    },
    async (request, reply) => authController.forgotPassword(request, reply)
  )

  app.withTypeProvider<ZodTypeProvider>().post(
    '/reset-password',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute'
        }
      }
    },
    async (request, reply) => authController.resetPassword(request, reply)
  )

  app.withTypeProvider<ZodTypeProvider>().post(
    '/reset-password/validate',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute'
        }
      }
    },
    async (request, reply) => authController.validateResetToken(request, reply)
  )

  app.withTypeProvider<ZodTypeProvider>().post(
    '/verify-email',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute'
        }
      }
    },
    async (request, reply) => authController.verifyEmail(request, reply)
  )

  app.withTypeProvider<ZodTypeProvider>().put(
    '/password',
    {
      preHandler: [app.authenticate],
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '15 minutes'
        }
      }
    },
    async (request, reply) => authController.changePassword(request, reply)
  )

  app.withTypeProvider<ZodTypeProvider>().post(
    '/email-change',
    {
      preHandler: [app.authenticate],
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 hour'
        }
      }
    },
    async (request, reply) => authController.requestEmailChange(request, reply)
  )

  app.withTypeProvider<ZodTypeProvider>().post(
    '/email-change/resend',
    {
      preHandler: [app.authenticate],
      config: {
        rateLimit: {
          max: 6,
          timeWindow: '1 hour'
        }
      }
    },
    async (request, reply) => authController.resendEmailChange(request, reply)
  )

  app.withTypeProvider<ZodTypeProvider>().delete(
    '/email-change',
    {
      preHandler: [app.authenticate],
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 hour'
        }
      }
    },
    async (request, reply) => authController.cancelEmailChange(request, reply)
  )

  app.withTypeProvider<ZodTypeProvider>().post(
    '/email-change/confirm',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute'
        }
      }
    },
    async (request, reply) => authController.confirmEmailChange(request, reply)
  )

  app.withTypeProvider<ZodTypeProvider>().post(
    '/resend-verification',
    {
      preHandler: [app.authenticate],
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '1 hour'
        }
      }
    },
    async (request, reply) =>
      authController.resendEmailVerification(request, reply)
  )

  async function redirectDeniedLink(
    provider: OAuthProvider,
    request: FastifyRequest,
    reply: FastifyReply,
    state: string | undefined,
    providerError: string
  ) {
    const linking =
      state && matchesOAuthStateCookie(request, reply, state)
        ? await readOAuthState(cacheRepository, state).catch(() => null)
        : null
    if (!linking?.linkUserId || !state) return null
    await cacheRepository.del(oauthStateKey(state)).catch(() => undefined)
    return reply.redirect(
      `${process.env.FRONTEND_URL}/configuracoes/seguranca?vinculo_erro=${
        providerError === 'access_denied' ? 'negado' : 'falhou'
      }&provedor=${provider}`
    )
  }

  const providerLinkRoute = (provider: OAuthProvider) => {
    const buildUrl =
      provider === 'google' ? buildGoogleAuthUrl : buildDiscordAuthUrl

    app.withTypeProvider<ZodTypeProvider>().post(
      `/${provider}/link`,
      {
        preHandler: [app.authenticate],
        config: { rateLimit: { max: 10, timeWindow: '1 hour' } }
      },
      async (request, reply) => {
        try {
          await authService.assertCanLinkProvider(request.user.userId, provider)
        } catch (error) {
          if (error instanceof ReauthRequiredError) {
            return sendProblem(reply, 403, {
              status: 'reauth_required',
              message: error.message
            })
          }
          throw error
        }

        const state = crypto.randomBytes(16).toString('hex')
        await saveOAuthState(cacheRepository, state, false, request.user.userId)
        setOAuthStateCookie(reply, state)
        return reply.status(200).send({ url: buildUrl(state) })
      }
    )

    app.withTypeProvider<ZodTypeProvider>().delete(
      `/${provider}/link`,
      {
        preHandler: [app.authenticate],
        schema: {
          body: z
            .object({ currentPassword: z.string().max(200).optional() })
            .optional()
        },
        config: { rateLimit: { max: 10, timeWindow: '1 hour' } }
      },
      async (request, reply) => {
        let tokens: Awaited<ReturnType<typeof authService.unlinkProvider>>
        try {
          tokens = await authService.unlinkProvider(
            request.user.userId,
            provider,
            request.body?.currentPassword
          )
        } catch (error) {
          if (error instanceof ReauthRequiredError) {
            return sendProblem(reply, 403, {
              status: 'reauth_required',
              message: error.message
            })
          }
          throw error
        }
        if (tokens) {
          setAuthCookies(
            reply,
            tokens.accessToken,
            tokens.refreshToken,
            tokens.expiresAt
          )
        }
        return reply.status(204).send()
      }
    )
  }
  providerLinkRoute('google')
  providerLinkRoute('discord')

  app
    .withTypeProvider<ZodTypeProvider>()
    .post('/refresh', async (request, reply) =>
      authController.refreshTokenHandler(request, reply)
    )

  app
    .withTypeProvider<ZodTypeProvider>()
    .post('/logout', async (request, reply) =>
      authController.logoutHandler(request, reply)
    )

  app.get('/google', async (request, reply) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const oauth2 = (app as any).googleOAuth2

      if (!oauth2) {
        console.error('❌ OAuth2 plugin não encontrado!')
        return sendProblem(reply, 500, {
          message: 'OAuth2 not configured',
          error: 'OAuth2 not configured'
        })
      }

      const state = crypto.randomBytes(16).toString('hex')
      await saveOAuthState(
        cacheRepository,
        state,
        parseAcceptedTerms(
          (request.query as { acceptedTerms?: unknown }).acceptedTerms
        )
      )
      setOAuthStateCookie(reply, state)

      const authUrl = buildGoogleAuthUrl(state)

      return reply.redirect(authUrl)
    } catch (error) {
      console.error('Erro ao iniciar OAuth:', error)
      return sendProblem(reply, 500, {
        message: 'Failed to start OAuth flow',
        error: 'Failed to start OAuth flow'
      })
    }
  })

  app.get(
    '/google/callback',
    { preHandler: [app.tryAuthenticate] },
    async (request, reply) => {
      const query = request.query as {
        state?: string
        code?: string
        error?: string
      }
      const stateFromQuery = query.state
      const code = query.code

      if (query.error) {
        console.error('❌ Erro do Google:', query.error)
        const denied = await redirectDeniedLink(
          'google',
          request,
          reply,
          stateFromQuery,
          query.error
        )
        if (denied) return denied
        return reply.redirect(
          process.env.FRONTEND_URL +
            '/auth?error=' +
            (query.error === 'access_denied' ? 'access_denied' : 'oauth_failed')
        )
      }

      if (!stateFromQuery) {
        console.error('❌ State ausente na query')
        return reply.redirect(
          process.env.FRONTEND_URL + '/auth?error=missing_state'
        )
      }

      if (!matchesOAuthStateCookie(request, reply, stateFromQuery)) {
        console.error('❌ State não pertence a este navegador')
        return reply.redirect(
          process.env.FRONTEND_URL + '/auth?error=invalid_state'
        )
      }

      const cachedState = await readOAuthState(cacheRepository, stateFromQuery)
      if (!cachedState) {
        console.error('❌ State inválido ou expirado')
        return reply.redirect(
          process.env.FRONTEND_URL + '/auth?error=invalid_state'
        )
      }

      if (!code) {
        console.error('❌ Code ausente na query')
        return reply.redirect(
          process.env.FRONTEND_URL + '/auth?error=missing_code'
        )
      }

      await cacheRepository.del(oauthStateKey(stateFromQuery))

      return authController.googleCallback(request, reply, cachedState)
    }
  )

  app.get('/discord', async (request, reply) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const oauth2 = (app as any).discordOAuth2

      if (!oauth2) {
        console.error('❌ OAuth2 plugin não encontrado!')
        return sendProblem(reply, 500, {
          message: 'OAuth2 not configured',
          error: 'OAuth2 not configured'
        })
      }

      const state = crypto.randomBytes(16).toString('hex')
      await saveOAuthState(
        cacheRepository,
        state,
        parseAcceptedTerms(
          (request.query as { acceptedTerms?: unknown }).acceptedTerms
        )
      )
      setOAuthStateCookie(reply, state)

      const authUrl = buildDiscordAuthUrl(state)

      return reply.redirect(authUrl)
    } catch (error) {
      console.error('Erro ao iniciar OAuth:', error)
      return sendProblem(reply, 500, {
        message: 'Failed to start OAuth flow',
        error: 'Failed to start OAuth flow'
      })
    }
  })

  app.get(
    '/discord/callback',
    { preHandler: [app.tryAuthenticate] },
    async (request, reply) => {
      const query = request.query as {
        state?: string
        code?: string
        error?: string
      }
      const stateFromQuery = query.state
      const code = query.code

      if (query.error) {
        console.error('❌ Erro do Discord:', query.error)
        const denied = await redirectDeniedLink(
          'discord',
          request,
          reply,
          stateFromQuery,
          query.error
        )
        if (denied) return denied
        return reply.redirect(
          process.env.FRONTEND_URL +
            '/auth?error=' +
            (query.error === 'access_denied' ? 'access_denied' : 'oauth_failed')
        )
      }

      if (!stateFromQuery) {
        console.error('❌ State inválido')
        return reply.redirect(
          process.env.FRONTEND_URL + '/auth?error=invalid_state'
        )
      }

      if (!matchesOAuthStateCookie(request, reply, stateFromQuery)) {
        console.error('❌ State não pertence a este navegador')
        return reply.redirect(
          process.env.FRONTEND_URL + '/auth?error=invalid_state'
        )
      }

      const cachedState = await readOAuthState(cacheRepository, stateFromQuery)
      if (!cachedState) {
        console.error('❌ State inválido')
        return reply.redirect(
          process.env.FRONTEND_URL + '/auth?error=invalid_state'
        )
      }

      if (!code) {
        console.error('❌ Code ausente')
        return reply.redirect(
          process.env.FRONTEND_URL + '/auth?error=missing_code'
        )
      }

      await cacheRepository.del(oauthStateKey(stateFromQuery))
      return authController.discordCallback(request, reply, cachedState)
    }
  )
}
