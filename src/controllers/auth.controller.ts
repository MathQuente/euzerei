import { FastifyReply, FastifyRequest } from 'fastify'
import { AuthService } from '../services/auth.service'
import * as AuthSchema from '../schemas/auth.schema'
import { ClientError } from '../errors/client-error'
import { TermsRequiredError } from '../errors/terms-required-error'
import { clearAuthCookies, setAuthCookies } from '../utils/auth-cookies'
import { respondUnavailable } from '../utils/respond-unavailable'
import { ReauthRequiredError } from '../errors/reauth-required-error'
import { sendProblem } from '../utils/problem'
import { ProviderLinkError } from '../errors/provider-link-error'
import type { OAuthState } from '../utils/oauth-state'
import type { OAuthProvider } from '../services/auth.service'

export class AuthController {
  constructor(private authService: AuthService) {}

  private oauthErrorCode(error: unknown) {
    if (error instanceof TermsRequiredError) return 'terms_required'
    if (error instanceof ClientError && error.statusCode === 403) {
      return 'email_not_verified'
    }
    return 'oauth_failed'
  }

  private redirectWithOAuthError(
    reply: FastifyReply,
    provider: string,
    error: unknown
  ) {
    console.error(`${provider} OAuth Error:`, {
      error: error instanceof Error ? error.message : 'unknown error'
    })
    const code = this.oauthErrorCode(error)
    return reply.redirect(process.env.FRONTEND_URL + '/auth?error=' + code)
  }

  async createUser(request: FastifyRequest, reply: FastifyReply) {
    const data = AuthSchema.RegisterBodySchema.parse(request.body)

    await this.authService.createUser(data)

    return reply.status(202).send({
      message:
        'Se o email puder ser usado, enviamos um link para concluir o cadastro.'
    })
  }

  async confirmRegistration(request: FastifyRequest, reply: FastifyReply) {
    const { token } = AuthSchema.VerifyEmailBodySchema.parse(request.body)

    const { accessToken, refreshToken, user } =
      await this.authService.confirmRegistration(token)

    setAuthCookies(reply, accessToken, refreshToken).send({ user })
  }

  async loginHandler(request: FastifyRequest, reply: FastifyReply) {
    const { email, password } = AuthSchema.LoginBodySchema.parse(request.body)

    const { user } = await this.authService.validateUser(
      email,
      password,
      request.ip
    )

    const { accessToken, refreshToken } = await this.authService.generateTokens(
      user.id
    )

    setAuthCookies(reply, accessToken, refreshToken).send({ user })
  }

  async forgotPassword(request: FastifyRequest, reply: FastifyReply) {
    const { email } = AuthSchema.ForgotPasswordBodySchema.parse(request.body)

    await this.authService.requestPasswordReset(email)

    return reply.status(200).send({
      message:
        'Se existir uma conta com esse email, um link de redefinição foi enviado.'
    })
  }

  async validateResetToken(request: FastifyRequest, reply: FastifyReply) {
    const { token } = AuthSchema.ResetTokenBodySchema.parse(request.body)

    const valid = await this.authService.isPasswordResetTokenValid(token)

    return reply.status(200).send({ valid })
  }

  async resetPassword(request: FastifyRequest, reply: FastifyReply) {
    const { token, password } = AuthSchema.ResetPasswordBodySchema.parse(
      request.body
    )

    await this.authService.resetPassword(token, password, request.ip)

    return reply.status(200).send({ message: 'Senha atualizada com sucesso.' })
  }

  async verifyEmail(request: FastifyRequest, reply: FastifyReply) {
    const { token } = AuthSchema.VerifyEmailBodySchema.parse(request.body)

    await this.authService.verifyEmail(token)

    return reply.status(200).send({ message: 'Email confirmado com sucesso.' })
  }

  private replyReauthRequired(reply: FastifyReply, error: ReauthRequiredError) {
    return sendProblem(reply, 403, {
      status: 'reauth_required',
      message: error.message
    })
  }

  async changePassword(request: FastifyRequest, reply: FastifyReply) {
    const body = AuthSchema.ChangePasswordBodySchema.parse(request.body)

    let result: Awaited<ReturnType<AuthService['changePassword']>>
    try {
      result = await this.authService.changePassword(request.user.userId, body)
    } catch (error) {
      if (error instanceof ReauthRequiredError) {
        return this.replyReauthRequired(reply, error)
      }
      throw error
    }

    const { accessToken, refreshToken, expiresAt, wasSet } = result

    setAuthCookies(reply, accessToken, refreshToken, expiresAt).send({
      message: wasSet ? 'Senha definida.' : 'Senha alterada.'
    })
  }

  async requestEmailChange(request: FastifyRequest, reply: FastifyReply) {
    const body = AuthSchema.EmailChangeBodySchema.parse(request.body)

    try {
      const result = await this.authService.requestEmailChange(
        request.user.userId,
        body
      )
      return reply.status(200).send(result)
    } catch (error) {
      if (error instanceof ReauthRequiredError) {
        return this.replyReauthRequired(reply, error)
      }
      throw error
    }
  }

  async resendEmailChange(request: FastifyRequest, reply: FastifyReply) {
    const result = await this.authService.resendEmailChange(request.user.userId)
    return reply.status(200).send(result)
  }

  async cancelEmailChange(request: FastifyRequest, reply: FastifyReply) {
    await this.authService.cancelEmailChange(request.user.userId)
    return reply.status(204).send()
  }

  async confirmEmailChange(request: FastifyRequest, reply: FastifyReply) {
    const { token } = AuthSchema.ConfirmEmailChangeBodySchema.parse(
      request.body
    )
    const { email } = await this.authService.confirmEmailChange(token)
    return reply.status(200).send({ message: 'E-mail alterado.', email })
  }

  async resendEmailVerification(request: FastifyRequest, reply: FastifyReply) {
    await this.authService.resendEmailVerification(request.user.userId)

    return reply.status(200).send({
      message: 'Se o email ainda não foi confirmado, enviamos um novo link.'
    })
  }

  async refreshTokenHandler(request: FastifyRequest, reply: FastifyReply) {
    const refreshToken = request.cookies.refreshToken

    if (!refreshToken)
      throw new ClientError('Token de atualização não enviado.', 401)

    let tokens: Awaited<ReturnType<AuthService['refreshTokens']>>
    try {
      tokens = await this.authService.refreshTokens(refreshToken)
    } catch (error) {
      if (error instanceof ClientError) throw error
      return respondUnavailable(reply, 'Refresh failed:', error)
    }

    const { accessToken, refreshToken: newRefreshToken, expiresAt } = tokens

    setAuthCookies(reply, accessToken, newRefreshToken, expiresAt).send({
      message: 'Tokens atualizados'
    })
  }

  async logoutHandler(request: FastifyRequest, reply: FastifyReply) {
    const refreshToken = request.cookies.refreshToken
    const accessToken = request.cookies.accessToken

    if (refreshToken || accessToken) {
      await this.authService.logout(refreshToken, accessToken)
    }

    clearAuthCookies(reply).send({ message: 'Sessão encerrada com sucesso.' })
  }

  private sessionUserId(request: FastifyRequest) {
    const user = request.user as { userId?: string } | undefined
    return user?.userId ?? null
  }

  private providerErrorCode(error: unknown) {
    if (error instanceof ProviderLinkError) return error.code
    return 'falhou'
  }

  private redirectLinkFailure(
    reply: FastifyReply,
    error: unknown,
    provider: OAuthProvider
  ) {
    console.error('Provider link OAuth error:', {
      error: error instanceof Error ? error.message : 'unknown error'
    })
    return reply.redirect(
      `${process.env.FRONTEND_URL}/configuracoes/seguranca?vinculo_erro=${this.providerErrorCode(error)}&provedor=${provider}`
    )
  }

  private async finishProviderLink(
    request: FastifyRequest,
    reply: FastifyReply,
    provider: OAuthProvider,
    linkUserId: string,
    providerId: string,
    verifiedByProvider: boolean
  ) {
    const back = `${process.env.FRONTEND_URL}/configuracoes/seguranca`
    try {
      if (this.sessionUserId(request) !== linkUserId) {
        return reply.redirect(
          `${back}?vinculo_erro=sessao&provedor=${provider}`
        )
      }
      await this.authService.linkProviderToUser(
        linkUserId,
        provider,
        providerId,
        verifiedByProvider
      )
      return reply.redirect(`${back}?vinculado=${provider}`)
    } catch (error) {
      console.error(`${provider} link error:`, {
        error: error instanceof Error ? error.message : 'unknown error'
      })
      return reply.redirect(
        `${back}?vinculo_erro=${this.providerErrorCode(error)}&provedor=${provider}`
      )
    }
  }

  async googleCallback(
    request: FastifyRequest,
    reply: FastifyReply,
    state: OAuthState
  ) {
    try {
      const { code } = request.query as { code: string; state: string }

      if (!code) {
        throw new ClientError('Código de autorização ausente.', 400)
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const oauth2 = (request.server as any).googleOAuth2

      const tokenResponse = await oauth2
        .getNewAccessTokenUsingRefreshToken(oauth2.accessToken, {
          code,
          redirect_uri: process.env.GOOGLE_OAUTH_CALLBACK_URL!,
          grant_type: 'authorization_code'
        })
        .catch(async () => {
          const params = new URLSearchParams({
            code,
            client_id: process.env.GOOGLE_CLIENT_ID!,
            client_secret: process.env.GOOGLE_CLIENT_SECRET!,
            redirect_uri: process.env.GOOGLE_OAUTH_CALLBACK_URL!,
            grant_type: 'authorization_code'
          })

          const response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params
          })

          if (!response.ok) {
            throw new ClientError(
              `Falha na troca de token (status ${response.status})`,
              502
            )
          }

          return await response.json()
        })

      const accessTokenGoogle = tokenResponse.access_token

      const res = await fetch(
        'https://openidconnect.googleapis.com/v1/userinfo',
        { headers: { Authorization: `Bearer ${accessTokenGoogle}` } }
      )

      if (!res.ok) {
        throw new ClientError('Falha ao buscar informações do usuário.', 502)
      }

      const profile = (await res.json()) as {
        sub: string
        email: string
        email_verified?: boolean
        name: string
        picture: string
      }

      if (state.linkUserId) {
        return this.finishProviderLink(
          request,
          reply,
          'google',
          state.linkUserId,
          profile.sub,
          profile.email_verified === true
        )
      }

      const { accessToken, refreshToken } =
        await this.authService.loginWithGoogle(profile, state.acceptedTerms)

      setAuthCookies(reply, accessToken, refreshToken).redirect(
        process.env.FRONTEND_URL + '/'
      )
    } catch (error) {
      if (state.linkUserId) {
        return this.redirectLinkFailure(reply, error, 'google')
      }
      this.redirectWithOAuthError(reply, 'Google', error)
    }
  }

  async discordCallback(
    request: FastifyRequest,
    reply: FastifyReply,
    state: OAuthState
  ) {
    try {
      const { code } = request.query as { code: string }

      if (!code) {
        throw new ClientError('Código de autorização ausente.', 400)
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const oauth2 = (request.server as any).discordOAuth2

      const tokenResponse = await oauth2
        .getAccessTokenFromAuthorizationCodeFlow(request)
        .catch(async () => {
          const params = new URLSearchParams({
            code,
            client_id: process.env.DISCORD_CLIENT_ID!,
            client_secret: process.env.DISCORD_CLIENT_SECRET!,
            redirect_uri: process.env.DISCORD_OAUTH_CALLBACK_URL!,
            grant_type: 'authorization_code'
          })

          const response = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params
          })

          if (!response.ok) {
            throw new ClientError(
              `Falha na troca de token (status ${response.status})`,
              502
            )
          }

          return await response.json()
        })

      const accessTokenDiscord = tokenResponse.access_token

      const res = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${accessTokenDiscord}` }
      })

      if (!res.ok) {
        throw new ClientError('Falha ao buscar informações do usuário.', 502)
      }

      const profile = (await res.json()) as {
        id: string
        email: string
        verified?: boolean
        username: string
        avatar: string
      }

      if (state.linkUserId) {
        return this.finishProviderLink(
          request,
          reply,
          'discord',
          state.linkUserId,
          profile.id,
          profile.verified === true
        )
      }

      const { accessToken, refreshToken } =
        await this.authService.loginWithDiscord(profile, state.acceptedTerms)

      setAuthCookies(reply, accessToken, refreshToken).redirect(
        process.env.FRONTEND_URL + '/'
      )
    } catch (error) {
      if (state.linkUserId) {
        return this.redirectLinkFailure(reply, error, 'discord')
      }
      this.redirectWithOAuthError(reply, 'Discord', error)
    }
  }
}
