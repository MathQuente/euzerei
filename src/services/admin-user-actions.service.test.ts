import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '../database/prisma-client'
import { ClientError } from '../errors/client-error'
import { AdminUserActionsService } from './admin-user-actions.service'

const cloudinary = vi.hoisted(() => ({
  isConfigured: vi.fn(),
  publicIdFromUrl: vi.fn(),
  destroy: vi.fn()
}))
vi.mock('./cloudinary.service', () => ({ CloudinaryService: cloudinary }))

const ACTOR = { actorId: 'admin-1', ip: '127.0.0.1' }
const target = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  userName: 'kenzo',
  role: 'USER',
  suspendedAt: null,
  profilePicture: null,
  userBanner: null,
  ...over
})

const repository = {
  findTarget: vi.fn(),
  suspend: vi.fn(),
  reactivate: vi.fn(),
  deleteUser: vi.fn()
}
const cache = { set: vi.fn(), get: vi.fn(), del: vi.fn() }
const strictAudit = { create: vi.fn(), markFailed: vi.fn() }
const queues = { removeUserJobs: vi.fn() }
const images = { findImageUrlsInUse: vi.fn() }

const service = new AdminUserActionsService(
  repository,
  cache,
  strictAudit,
  queues,
  images
)

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  repository.findTarget.mockResolvedValue(target())
  repository.suspend.mockResolvedValue(true)
  repository.reactivate.mockResolvedValue(true)
  repository.deleteUser.mockResolvedValue({ id: 'u1' })
  cache.set.mockResolvedValue(undefined)
  cache.get.mockResolvedValue(null)
  cache.del.mockResolvedValue(undefined)
  strictAudit.create.mockResolvedValue({ id: 'audit-1' })
  strictAudit.markFailed.mockResolvedValue(undefined)
  queues.removeUserJobs.mockResolvedValue(0)
  images.findImageUrlsInUse.mockResolvedValue([])
  cloudinary.isConfigured.mockReturnValue(false)
})

describe.each([
  ['suspend', () => service.suspend('u1', ACTOR)],
  ['reactivate', () => service.reactivate('u1', ACTOR)],
  ['delete', () => service.deleteAccount('u1', 'kenzo', ACTOR)]
] as const)('guardas de %s', (_name, run) => {
  it('404 quando o usuário não existe, sem auditoria', async () => {
    repository.findTarget.mockResolvedValue(null)

    await expect(run()).rejects.toMatchObject({ statusCode: 404 })
    expect(repository.suspend).not.toHaveBeenCalled()
    expect(strictAudit.create).not.toHaveBeenCalled()
  })

  it('recusa o próprio admin (403)', async () => {
    repository.findTarget.mockResolvedValue(target({ id: 'admin-1' }))
    const actorIsTarget = service.suspend('admin-1', ACTOR)

    await expect(actorIsTarget).rejects.toMatchObject({ statusCode: 403 })
  })

  it('recusa alvo ADMIN (403) sem tocar em nada', async () => {
    repository.findTarget.mockResolvedValue(target({ role: 'ADMIN' }))

    await expect(run()).rejects.toMatchObject({ statusCode: 403 })
    expect(cache.set).not.toHaveBeenCalled()
    expect(repository.deleteUser).not.toHaveBeenCalled()
    expect(strictAudit.create).not.toHaveBeenCalled()
  })
})

describe('suspend', () => {
  it('revoga os access tokens antes e grava a transação com o handle, sem e-mail', async () => {
    const order: string[] = []
    cache.set.mockImplementation(async () => void order.push('revoke'))
    repository.suspend.mockImplementation(async () => {
      order.push('suspend')
      return true
    })

    const result = await service.suspend('u1', ACTOR)

    expect(result).toEqual({ changed: true })
    // depois do commit a marca é regravada: cobre o token emitido entre a primeira marca e o commit
    expect(order).toEqual(['revoke', 'suspend', 'revoke'])
    expect(cache.set).toHaveBeenCalledWith(
      'sessions-revoked-at:u1',
      expect.any(Number),
      900
    )
    // 1 s à frente: um token emitido no mesmo segundo da suspensão também cai.
    const marked = cache.set.mock.calls[0][1] as number
    expect(marked).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + 1)
    const [, , audit] = repository.suspend.mock.calls[0]
    expect(audit).toMatchObject({
      actorId: 'admin-1',
      action: 'Suspendeu a conta',
      target: '@kenzo'
    })
    expect(JSON.stringify(audit)).not.toContain('@exemplo')
  })

  it('já suspenso: changed false, sem revogar e sem auditoria', async () => {
    repository.findTarget.mockResolvedValue(target({ suspendedAt: new Date() }))

    expect(await service.suspend('u1', ACTOR)).toEqual({ changed: false })
    expect(cache.set).not.toHaveBeenCalled()
    expect(repository.suspend).not.toHaveBeenCalled()
  })

  it('Redis fora: 503 e nada muda', async () => {
    cache.set.mockRejectedValue(new Error('redis down'))

    await expect(service.suspend('u1', ACTOR)).rejects.toMatchObject({
      statusCode: 503
    })
    expect(repository.suspend).not.toHaveBeenCalled()
  })

  it('regravar a marca depois do commit falha: a suspensão vale e o erro é só registrado', async () => {
    cache.set
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('redis down'))

    expect(await service.suspend('u1', ACTOR)).toEqual({ changed: true })
    expect(cache.set).toHaveBeenCalledTimes(2)
  })

  it('corrida: outra requisição suspendeu primeiro, changed false', async () => {
    repository.suspend.mockResolvedValue(false)

    expect(await service.suspend('u1', ACTOR)).toEqual({ changed: false })
  })

  it('cancela a troca de e-mail pendente', async () => {
    cache.get.mockResolvedValue({ tokenHash: 'h1', newEmail: 'x@y.z' })

    await service.suspend('u1', ACTOR)

    expect(cache.del).toHaveBeenCalledWith('email-change:h1')
    expect(cache.del).toHaveBeenCalledWith('email-change-current:u1')
  })
})

describe('reactivate', () => {
  it('limpa a suspensão e audita', async () => {
    repository.findTarget.mockResolvedValue(target({ suspendedAt: new Date() }))

    expect(await service.reactivate('u1', ACTOR)).toEqual({ changed: true })
    expect(repository.reactivate.mock.calls[0][1]).toMatchObject({
      action: 'Reativou a conta',
      target: '@kenzo'
    })
  })

  it('conta que não está suspensa: changed false, sem auditoria', async () => {
    expect(await service.reactivate('u1', ACTOR)).toEqual({ changed: false })
    expect(repository.reactivate).not.toHaveBeenCalled()
  })
})

describe('deleteAccount', () => {
  it('409 quando o handle não confere, sem auditoria nem exclusão', async () => {
    await expect(
      service.deleteAccount('u1', 'outro', ACTOR)
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(strictAudit.create).not.toHaveBeenCalled()
    expect(repository.deleteUser).not.toHaveBeenCalled()
  })

  it('grava a auditoria ANTES, revoga e só então apaga', async () => {
    const order: string[] = []
    strictAudit.create.mockImplementation(async () => {
      order.push('audit')
      return { id: 'audit-1' }
    })
    cache.set.mockImplementation(async () => void order.push('revoke'))
    repository.deleteUser.mockImplementation(async () => {
      order.push('delete')
      return { id: 'u1' }
    })

    expect(await service.deleteAccount('u1', 'kenzo', ACTOR)).toEqual({
      deleted: true
    })
    expect(order).toEqual(['audit', 'revoke', 'delete', 'revoke'])
    expect(strictAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'Excluiu a conta',
        area: 'USERS',
        target: '@kenzo'
      })
    )
    expect(strictAudit.markFailed).not.toHaveBeenCalled()
  })

  it('auditoria falha: nada é apagado', async () => {
    strictAudit.create.mockRejectedValue(new Error('db'))

    await expect(service.deleteAccount('u1', 'kenzo', ACTOR)).rejects.toThrow()
    expect(cache.set).not.toHaveBeenCalled()
    expect(repository.deleteUser).not.toHaveBeenCalled()
  })

  it('revogação falha: 503, a linha vira FAILED e nada é apagado', async () => {
    cache.set.mockRejectedValue(new Error('redis down'))

    await expect(
      service.deleteAccount('u1', 'kenzo', ACTOR)
    ).rejects.toMatchObject({ statusCode: 503 })
    expect(strictAudit.markFailed).toHaveBeenCalledWith(
      'audit-1',
      expect.any(String)
    )
    expect(repository.deleteUser).not.toHaveBeenCalled()
  })

  it('exclusão falha: a MESMA linha vira FAILED e o erro sobe', async () => {
    repository.deleteUser.mockRejectedValue(new Error('db'))

    await expect(service.deleteAccount('u1', 'kenzo', ACTOR)).rejects.toThrow(
      'db'
    )
    expect(strictAudit.markFailed).toHaveBeenCalledWith(
      'audit-1',
      expect.any(String)
    )
    expect(strictAudit.create).toHaveBeenCalledTimes(1)
    expect(queues.removeUserJobs).not.toHaveBeenCalled()
  })

  it('exclusão falha e o markFailed também: o erro original sobe e nada fica sem tratar', async () => {
    repository.deleteUser.mockRejectedValue(new Error('db'))
    strictAudit.markFailed.mockRejectedValue(new Error('audit down'))

    await expect(service.deleteAccount('u1', 'kenzo', ACTOR)).rejects.toThrow(
      'db'
    )
    expect(strictAudit.markFailed).toHaveBeenCalledTimes(1)
  })

  it('já apagado por outra requisição: 404 e linha FAILED', async () => {
    repository.deleteUser.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('gone', {
        code: 'P2025',
        clientVersion: 'test'
      })
    )

    await expect(
      service.deleteAccount('u1', 'kenzo', ACTOR)
    ).rejects.toBeInstanceOf(ClientError)
    expect(strictAudit.markFailed).toHaveBeenCalled()
  })

  it('depois de apagar remove os jobs e as imagens; falha na limpeza não desfaz', async () => {
    const photo = 'https://res.cloudinary.com/x/image/upload/v1/foto.png'
    repository.findTarget.mockResolvedValue(target({ profilePicture: photo }))
    cloudinary.isConfigured.mockReturnValue(true)
    cloudinary.publicIdFromUrl.mockReturnValue('foto')
    queues.removeUserJobs.mockRejectedValue(new Error('redis'))

    expect(await service.deleteAccount('u1', 'kenzo', ACTOR)).toEqual({
      deleted: true
    })
    expect(queues.removeUserJobs).toHaveBeenCalledWith('u1')
    expect(cloudinary.destroy).toHaveBeenCalledWith('foto')
  })

  it('não apaga imagem que outra conta ainda usa', async () => {
    const photo = 'https://res.cloudinary.com/x/image/upload/v1/foto.png'
    repository.findTarget.mockResolvedValue(target({ profilePicture: photo }))
    cloudinary.isConfigured.mockReturnValue(true)
    cloudinary.publicIdFromUrl.mockReturnValue('foto')
    images.findImageUrlsInUse.mockResolvedValue([photo])

    await service.deleteAccount('u1', 'kenzo', ACTOR)

    expect(cloudinary.destroy).not.toHaveBeenCalled()
  })
})
