import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FastifyReply, FastifyRequest } from 'fastify'
import { AccountSuspendedError } from '../errors/account-suspended-error'
import { AuthController } from './auth.controller'
import { AuthService } from '../services/auth.service'
import { ClientError } from '../errors/client-error'
import { ReauthRequiredError } from '../errors/reauth-required-error'
import { ProviderLinkError } from '../errors/provider-link-error'

function fakeReply() {
  const reply = {
    status: vi.fn(() => reply),
    send: vi.fn(() => reply),
    header: vi.fn(() => reply),
    type: vi.fn(() => reply),
    setCookie: vi.fn(() => reply)
  }
  return reply as unknown as FastifyReply & {
    status: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
    header: ReturnType<typeof vi.fn>
    setCookie: ReturnType<typeof vi.fn>
  }
}

function setup(refreshTokens: ReturnType<typeof vi.fn>) {
  const controller = new AuthController({
    refreshTokens
  } as unknown as AuthService)
  const request = {
    cookies: { refreshToken: 'refresh-token' }
  } as unknown as FastifyRequest
  return { controller, request }
}

describe('AuthController.refreshTokenHandler', () => {
  it('answers 503 with status and message, without touching the cookies, when the refresh cannot be checked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { controller, request } = setup(
      vi.fn().mockRejectedValue(new Error('database down'))
    )
    const reply = fakeReply()

    await controller.refreshTokenHandler(request, reply)

    expect(reply.status).toHaveBeenCalledWith(503)
    expect(reply.header).toHaveBeenCalledWith('Retry-After', '5')
    expect(reply.send).toHaveBeenCalledWith({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 'unavailable',
      detail: 'Serviço indisponível no momento. Tente novamente em instantes.',
      message: 'Serviço indisponível no momento. Tente novamente em instantes.'
    })
    expect(reply.setCookie).not.toHaveBeenCalled()
  })

  it('rethrows a client error instead of answering 503', async () => {
    const error = new ClientError('Sessão inválida.', 401)
    const { controller, request } = setup(vi.fn().mockRejectedValue(error))

    await expect(
      controller.refreshTokenHandler(request, fakeReply())
    ).rejects.toBe(error)
  })
})

describe('AuthController.changePassword', () => {
  const body = { newPassword: 'uma-senha-nova-forte' }

  it('answers 403 reauth_required when the service asks for a new sign-in', async () => {
    const controller = new AuthController({
      changePassword: vi.fn().mockRejectedValue(new ReauthRequiredError())
    } as unknown as AuthService)
    const request = {
      body,
      user: { userId: 'user-1' }
    } as unknown as FastifyRequest
    const reply = fakeReply()

    await controller.changePassword(request, reply)

    expect(reply.status).toHaveBeenCalledWith(403)
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'reauth_required',
        message: 'Entre novamente para confirmar esta ação.'
      })
    )
  })

  it('rethrows other errors', async () => {
    const error = new ClientError('A senha atual está incorreta.')
    const controller = new AuthController({
      changePassword: vi.fn().mockRejectedValue(error)
    } as unknown as AuthService)
    const request = {
      body: { ...body, currentPassword: 'x' },
      user: { userId: 'user-1' }
    } as unknown as FastifyRequest

    await expect(controller.changePassword(request, fakeReply())).rejects.toBe(
      error
    )
  })
})

describe('AuthController e-mail change', () => {
  const request = (body: unknown = {}) =>
    ({ body, user: { userId: 'user-1' } }) as unknown as FastifyRequest

  it('answers 403 reauth_required when an account without password needs a new sign-in', async () => {
    const controller = new AuthController({
      requestEmailChange: vi.fn().mockRejectedValue(new ReauthRequiredError())
    } as unknown as AuthService)
    const reply = fakeReply()

    await controller.requestEmailChange(
      request({ newEmail: 'novo@a.com' }),
      reply
    )

    expect(reply.status).toHaveBeenCalledWith(403)
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reauth_required' })
    )
  })

  it('returns the pending address and rethrows other errors', async () => {
    const ok = new AuthController({
      requestEmailChange: vi
        .fn()
        .mockResolvedValue({ pendingEmail: 'novo@a.com' })
    } as unknown as AuthService)
    const reply = fakeReply()
    await ok.requestEmailChange(
      request({ newEmail: 'Novo@A.com', currentPassword: 'x' }),
      reply
    )
    expect(reply.status).toHaveBeenCalledWith(200)
    expect(reply.send).toHaveBeenCalledWith({ pendingEmail: 'novo@a.com' })

    const error = new ClientError('Este e-mail já está em uso.', 409)
    const failing = new AuthController({
      requestEmailChange: vi.fn().mockRejectedValue(error)
    } as unknown as AuthService)
    await expect(
      failing.requestEmailChange(request({ newEmail: 'a@a.com' }), fakeReply())
    ).rejects.toBe(error)
  })

  it('rejects an invalid address before reaching the service', async () => {
    const requestEmailChange = vi.fn()
    const controller = new AuthController({
      requestEmailChange
    } as unknown as AuthService)

    await expect(
      controller.requestEmailChange(
        request({ newEmail: 'nao-e-email' }),
        fakeReply()
      )
    ).rejects.toThrow()
    expect(requestEmailChange).not.toHaveBeenCalled()
  })

  it('cancel answers 204 and confirm returns the new address without touching the cookies', async () => {
    const controller = new AuthController({
      cancelEmailChange: vi.fn().mockResolvedValue(undefined),
      confirmEmailChange: vi.fn().mockResolvedValue({ email: 'novo@a.com' })
    } as unknown as AuthService)

    const cancelReply = fakeReply()
    await controller.cancelEmailChange(request(), cancelReply)
    expect(cancelReply.status).toHaveBeenCalledWith(204)

    const confirmReply = fakeReply()
    await controller.confirmEmailChange(request({ token: 'abc' }), confirmReply)
    expect(confirmReply.send).toHaveBeenCalledWith({
      message: 'E-mail alterado.',
      email: 'novo@a.com'
    })
    expect(confirmReply.setCookie).not.toHaveBeenCalled()
  })
})

describe('AuthController provider callbacks', () => {
  const profileFetch = (profile: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => profile })
    )
  const oauth2 = {
    getNewAccessTokenUsingRefreshToken: vi
      .fn()
      .mockResolvedValue({ access_token: 'tok' }),
    getAccessTokenFromAuthorizationCodeFlow: vi
      .fn()
      .mockResolvedValue({ access_token: 'tok' })
  }
  const request = (userId: string | null) =>
    ({
      cookies: { accessToken: 'tok' },
      query: { code: 'c', state: 's' },
      server: { googleOAuth2: oauth2, discordOAuth2: oauth2 },
      user: userId ? { userId, tokenType: 'access' } : undefined
    }) as unknown as FastifyRequest

  function reply() {
    const r = { redirect: vi.fn(() => r), setCookie: vi.fn(() => r) }
    return r as unknown as FastifyReply & { redirect: ReturnType<typeof vi.fn> }
  }

  beforeEach(() => {
    vi.stubEnv('FRONTEND_URL', 'http://localhost:5173')
    vi.stubEnv('GOOGLE_OAUTH_CALLBACK_URL', 'http://x/cb')
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('links instead of signing in when the state was made by a logged in user', async () => {
    profileFetch({ sub: 'g-1', email: 'a@a.com', email_verified: true })
    const linkProviderToUser = vi.fn().mockResolvedValue(undefined)
    const loginWithGoogle = vi.fn()
    const controller = new AuthController({
      linkProviderToUser,
      loginWithGoogle
    } as unknown as AuthService)
    const r = reply()

    await controller.googleCallback(request('user-1'), r, {
      acceptedTerms: false,
      linkUserId: 'user-1'
    })

    expect(linkProviderToUser).toHaveBeenCalledWith(
      'user-1',
      'google',
      'g-1',
      true
    )
    expect(loginWithGoogle).not.toHaveBeenCalled()
    expect(r.redirect).toHaveBeenCalledWith(
      'http://localhost:5173/configuracoes/seguranca?vinculado=google'
    )
  })

  it.each(['google', 'discord'] as const)(
    '%s: conta suspensa volta ao app com error=account_suspended, não email_not_verified',
    async provider => {
      profileFetch({ sub: 'p-1', email: 'a@a.com', email_verified: true })
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const login = vi.fn().mockRejectedValue(new AccountSuspendedError())
      const controller = new AuthController({
        loginWithGoogle: login,
        loginWithDiscord: login
      } as unknown as AuthService)
      const r = reply()
      const callback =
        provider === 'google'
          ? controller.googleCallback.bind(controller)
          : controller.discordCallback.bind(controller)

      await callback(request(null), r, { acceptedTerms: true })

      expect(r.redirect).toHaveBeenCalledWith(
        'http://localhost:5173/auth?error=account_suspended'
      )
    }
  )

  it('does not link when the browser is signed in as someone else, or not at all', async () => {
    profileFetch({ sub: 'g-1', email: 'a@a.com', email_verified: true })
    const linkProviderToUser = vi.fn()
    const controller = new AuthController({
      linkProviderToUser
    } as unknown as AuthService)

    for (const session of ['other-user', null]) {
      const r = reply()
      await controller.googleCallback(request(session), r, {
        acceptedTerms: false,
        linkUserId: 'user-1'
      })
      expect(r.redirect).toHaveBeenCalledWith(
        'http://localhost:5173/configuracoes/seguranca?vinculo_erro=sessao&provedor=google'
      )
    }
    expect(linkProviderToUser).not.toHaveBeenCalled()
  })

  it('goes back to the settings page with the reason when the identity belongs to another account', async () => {
    profileFetch({ id: 'd-1', email: 'a@a.com', verified: true })
    const controller = new AuthController({
      linkProviderToUser: vi
        .fn()
        .mockRejectedValue(
          new ProviderLinkError('ja_ligado_outra_conta', 'ocupado')
        )
    } as unknown as AuthService)
    const r = reply()

    await controller.discordCallback(request('user-1'), r, {
      acceptedTerms: false,
      linkUserId: 'user-1'
    })

    expect(r.redirect).toHaveBeenCalledWith(
      'http://localhost:5173/configuracoes/seguranca?vinculo_erro=ja_ligado_outra_conta&provedor=discord'
    )
  })

  it('sends a provider failure during a link back to the settings page, not to the login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 })
    )
    const controller = new AuthController({} as unknown as AuthService)
    const r = reply()

    await controller.googleCallback(request('user-1'), r, {
      acceptedTerms: false,
      linkUserId: 'user-1'
    })

    expect(r.redirect).toHaveBeenCalledWith(
      'http://localhost:5173/configuracoes/seguranca?vinculo_erro=falhou&provedor=google'
    )
  })

  it('still signs in as before when the state is not a link', async () => {
    profileFetch({ sub: 'g-1', email: 'a@a.com', email_verified: true })
    const loginWithGoogle = vi.fn().mockResolvedValue({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date()
    })
    const controller = new AuthController({
      loginWithGoogle
    } as unknown as AuthService)
    const r = reply()

    await controller.googleCallback(request(null), r, { acceptedTerms: true })

    expect(loginWithGoogle).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'g-1' }),
      true
    )
  })

  it('does not link when the session is gone by the time the provider answers', async () => {
    profileFetch({ sub: 'g-1', email: 'a@a.com', email_verified: true })
    const linkProviderToUser = vi.fn()
    const controller = new AuthController({
      linkProviderToUser
    } as unknown as AuthService)
    const r = reply()

    await controller.googleCallback(request(null), r, {
      acceptedTerms: false,
      linkUserId: 'user-1'
    })

    expect(linkProviderToUser).not.toHaveBeenCalled()
    expect(r.redirect).toHaveBeenCalledWith(
      'http://localhost:5173/configuracoes/seguranca?vinculo_erro=sessao&provedor=google'
    )
  })
})
