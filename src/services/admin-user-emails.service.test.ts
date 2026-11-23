import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClientError } from '../errors/client-error'
import {
  AdminUserEmailsService,
  cooldownKey
} from './admin-user-emails.service'

const ACTOR = { actorId: 'admin-1', ip: '127.0.0.1' }
const target = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  userName: 'kenzo',
  role: 'USER',
  suspendedAt: null,
  emailVerifiedAt: null,
  profilePicture: null,
  userBanner: null,
  ...over
})

const auth = {
  resendEmailVerificationAsAdmin: vi.fn(),
  requestPasswordResetAsAdmin: vi.fn()
}
const repository = { findTarget: vi.fn() }
const cache = { setIfAbsent: vi.fn(), del: vi.fn() }
const strictAudit = { create: vi.fn(), markFailed: vi.fn() }
const service = new AdminUserEmailsService(auth, repository, cache, strictAudit)

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  repository.findTarget.mockResolvedValue(target())
  cache.setIfAbsent.mockResolvedValue(true)
  cache.del.mockResolvedValue(undefined)
  strictAudit.create.mockResolvedValue({ id: 'audit-1' })
  strictAudit.markFailed.mockResolvedValue({})
  auth.resendEmailVerificationAsAdmin.mockResolvedValue(undefined)
  auth.requestPasswordResetAsAdmin.mockResolvedValue(undefined)
})

describe.each([
  [
    'verification',
    () => service.resendVerification('u1', ACTOR),
    'resendEmailVerificationAsAdmin',
    'Reenviou a verificação de e-mail'
  ],
  [
    'reset',
    () => service.resetPassword('u1', ACTOR),
    'requestPasswordResetAsAdmin',
    'Enviou a redefinição de senha'
  ]
] as const)('%s', (kind, run, method, action) => {
  it('grava a auditoria ANTES do envio, com o handle e sem e-mail', async () => {
    const order: string[] = []
    strictAudit.create.mockImplementation(
      async () => (order.push('audit'), { id: 'audit-1' })
    )
    auth[method].mockImplementation(async () => void order.push('send'))

    expect(await run()).toEqual({ sent: true })
    expect(order).toEqual(['audit', 'send'])
    const entry = strictAudit.create.mock.calls[0][0]
    expect(entry).toMatchObject({
      action,
      area: 'USERS',
      target: '@kenzo',
      actorId: 'admin-1'
    })
    expect(JSON.stringify(entry)).not.toMatch(/@exemplo|@x\.co|token|http/)
  })

  it('404 se não existe e 409 se a conta está suspensa, sem auditoria nem envio', async () => {
    repository.findTarget.mockResolvedValueOnce(null)
    await expect(run()).rejects.toMatchObject({ statusCode: 404 })
    repository.findTarget.mockResolvedValueOnce(
      target({ suspendedAt: new Date() })
    )
    await expect(run()).rejects.toMatchObject({ statusCode: 409 })

    expect(strictAudit.create).not.toHaveBeenCalled()
    expect(auth[method]).not.toHaveBeenCalled()
  })

  it('repetir dentro de um minuto: 429, sem auditoria nem envio', async () => {
    cache.setIfAbsent.mockResolvedValue(false)

    await expect(run()).rejects.toMatchObject({ statusCode: 429 })
    expect(cache.setIfAbsent).toHaveBeenCalledWith(
      cooldownKey(kind, 'u1'),
      true,
      60
    )
    expect(strictAudit.create).not.toHaveBeenCalled()
    expect(auth[method]).not.toHaveBeenCalled()
  })

  it('auditoria falha: nada é enviado e o intervalo é liberado', async () => {
    strictAudit.create.mockRejectedValue(new Error('db'))

    await expect(run()).rejects.toThrow('db')
    expect(auth[method]).not.toHaveBeenCalled()
    expect(cache.del).toHaveBeenCalledWith(cooldownKey(kind, 'u1'))
  })

  it('envio falha: a MESMA linha vira FAILED com o motivo, o intervalo é liberado e o erro sobe', async () => {
    auth[method].mockRejectedValue(
      new ClientError('Não foi possível enviar o email agora.', 503)
    )

    await expect(run()).rejects.toMatchObject({ statusCode: 503 })
    expect(strictAudit.markFailed).toHaveBeenCalledWith(
      'audit-1',
      'Não foi possível enviar o email agora.'
    )
    expect(strictAudit.create).toHaveBeenCalledTimes(1)
    expect(cache.del).toHaveBeenCalledWith(cooldownKey(kind, 'u1'))
  })

  it('markFailed que falha não esconde o erro do envio', async () => {
    auth[method].mockRejectedValue(new Error('smtp'))
    strictAudit.markFailed.mockRejectedValue(new Error('audit down'))

    await expect(run()).rejects.toThrow('smtp')
  })
})

it('reenviar verificação de e-mail já verificado: 409 antes de qualquer auditoria', async () => {
  repository.findTarget.mockResolvedValue(
    target({ emailVerifiedAt: new Date() })
  )

  await expect(service.resendVerification('u1', ACTOR)).rejects.toMatchObject({
    statusCode: 409
  })
  expect(strictAudit.create).not.toHaveBeenCalled()
  expect(cache.setIfAbsent).not.toHaveBeenCalled()
})

it('redefinir senha vale mesmo com e-mail ainda não verificado', async () => {
  repository.findTarget.mockResolvedValue(target({ emailVerifiedAt: null }))

  expect(await service.resetPassword('u1', ACTOR)).toEqual({ sent: true })
})
