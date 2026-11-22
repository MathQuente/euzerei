import { describe, it, expect, vi, beforeEach } from 'vitest'
import { JWT } from '@fastify/jwt'
import { AuthService } from './auth.service'
import { AuthRepository } from '../repositories/auth.repository'
import { CacheRepository } from '../repositories/cache.repository'
import { EmailService } from './email.service'

const email = {
  sendPasswordResetEmail: vi.fn(),
  sendEmailVerificationEmail: vi.fn()
}
const cache = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  increment: vi.fn()
}
const repo = { findById: vi.fn(), findProviderState: vi.fn() }

function build() {
  return new AuthService(
    repo as unknown as AuthRepository,
    {} as JWT,
    cache as unknown as CacheRepository,
    email as unknown as EmailService
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  process.env.FRONTEND_URL = 'http://localhost:5173'
  cache.get.mockResolvedValue(null)
  cache.set.mockResolvedValue(undefined)
  cache.del.mockResolvedValue(undefined)
  cache.increment.mockResolvedValue(1)
  email.sendPasswordResetEmail.mockResolvedValue(undefined)
  email.sendEmailVerificationEmail.mockResolvedValue(undefined)
})

describe('resendEmailVerificationAsAdmin', () => {
  it('conta já verificada: 409 em vez de voltar em silêncio, e nada é enviado', async () => {
    repo.findById.mockResolvedValue({
      id: 'u1',
      email: 'a@x.co',
      emailVerifiedAt: new Date()
    })

    await expect(
      build().resendEmailVerificationAsAdmin('u1')
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(email.sendEmailVerificationEmail).not.toHaveBeenCalled()
  })

  it('usuário inexistente: 404', async () => {
    repo.findById.mockResolvedValue(null)

    await expect(
      build().resendEmailVerificationAsAdmin('u1')
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('envia ao e-mail da conta, uma vez', async () => {
    repo.findById.mockResolvedValue({
      id: 'u1',
      email: 'a@x.co',
      emailVerifiedAt: null
    })

    await build().resendEmailVerificationAsAdmin('u1')

    expect(email.sendEmailVerificationEmail).toHaveBeenCalledTimes(1)
    expect(email.sendEmailVerificationEmail.mock.calls[0][0]).toBe('a@x.co')
  })

  it('limite por hora estourado: 429 e nada é enviado (o admin não contorna o limite)', async () => {
    repo.findById.mockResolvedValue({
      id: 'u1',
      email: 'a@x.co',
      emailVerifiedAt: null
    })
    cache.increment.mockResolvedValue(99)

    await expect(
      build().resendEmailVerificationAsAdmin('u1')
    ).rejects.toMatchObject({ statusCode: 429 })
    expect(email.sendEmailVerificationEmail).not.toHaveBeenCalled()
  })

  it('SMTP falha: 503', async () => {
    repo.findById.mockResolvedValue({
      id: 'u1',
      email: 'a@x.co',
      emailVerifiedAt: null
    })
    email.sendEmailVerificationEmail.mockRejectedValue(new Error('smtp'))

    await expect(
      build().resendEmailVerificationAsAdmin('u1')
    ).rejects.toMatchObject({ statusCode: 503 })
  })
})

describe('requestPasswordResetAsAdmin', () => {
  const state = {
    id: 'u1',
    email: 'a@x.co',
    hasPassword: true,
    googleId: null,
    discordId: null
  }

  it('guarda o token, envia ao e-mail da conta e aguarda o envio', async () => {
    repo.findProviderState.mockResolvedValue(state)

    await build().requestPasswordResetAsAdmin('u1')

    expect(cache.set).toHaveBeenCalledTimes(1)
    expect(email.sendPasswordResetEmail).toHaveBeenCalledTimes(1)
    const [to, url] = email.sendPasswordResetEmail.mock.calls[0]
    expect(to).toBe('a@x.co')
    expect(url).toMatch(/^http:\/\/localhost:5173\/reset-password\?token=.+/)
  })

  it('usuário inexistente: 404 (o pedido público é que engole)', async () => {
    repo.findProviderState.mockResolvedValue(null)

    await expect(
      build().requestPasswordResetAsAdmin('u1')
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('limite estourado: 429 explícito, sem token e sem envio', async () => {
    repo.findProviderState.mockResolvedValue(state)
    cache.increment.mockResolvedValue(99)

    await expect(
      build().requestPasswordResetAsAdmin('u1')
    ).rejects.toMatchObject({ statusCode: 429 })
    expect(cache.set).not.toHaveBeenCalled()
    expect(email.sendPasswordResetEmail).not.toHaveBeenCalled()
  })

  it('SMTP falha: 503 e o token que tinha sido guardado é apagado', async () => {
    repo.findProviderState.mockResolvedValue(state)
    email.sendPasswordResetEmail.mockRejectedValue(new Error('smtp'))

    await expect(
      build().requestPasswordResetAsAdmin('u1')
    ).rejects.toMatchObject({ statusCode: 503 })
    expect(cache.del).toHaveBeenCalledTimes(1)
    expect(cache.del.mock.calls[0][0]).toBe(cache.set.mock.calls[0][0])
  })
})
