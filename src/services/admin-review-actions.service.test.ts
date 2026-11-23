import { describe, expect, it, vi } from 'vitest'
import { Prisma } from '../database/prisma-client'
import { ClientError } from '../errors/client-error'
import { AdminReviewActionsService } from './admin-review-actions.service'

const ACTOR = { actorId: 'admin-1', ip: '10.0.0.1' }
const TARGET = {
  id: 'rv-1',
  igdbId: 7,
  hidden: false,
  handle: 'anon_9',
  gameName: 'Hades II',
  reports: 2
}

function build(
  repo: Record<string, unknown> = {},
  audit: Record<string, unknown> = {}
) {
  const repository = {
    findTarget: vi.fn().mockResolvedValue(TARGET),
    hide: vi.fn().mockResolvedValue(true),
    restore: vi.fn().mockResolvedValue(true),
    dismiss: vi.fn().mockResolvedValue(true),
    deleteReview: vi.fn().mockResolvedValue({ id: 'rv-1' }),
    ...repo
  }
  const strictAudit = {
    create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
    markFailed: vi.fn().mockResolvedValue({}),
    ...audit
  }
  const service = new AdminReviewActionsService(
    repository as never,
    strictAudit as never
  )
  return { service, repository, strictAudit }
}

const auditArg = (mock: unknown) =>
  (mock as ReturnType<typeof vi.fn>).mock.calls[0][2]

describe('hide, restore e dismiss', () => {
  it.each([
    ['hide', 'Ocultou uma review'],
    ['restore', 'Reexibiu uma review'],
    ['dismiss', 'Manteve uma review']
  ] as const)(
    '%s grava a auditoria de MODERATION com @handle · jogo, sem o texto',
    async (method, action) => {
      const { service, repository } = build()

      const result = await service[method]('rv-1', ACTOR)

      expect(result).toEqual({ changed: true })
      const mock = repository[method] as ReturnType<typeof vi.fn>
      const audit =
        method === 'restore' ? mock.mock.calls[0][1] : auditArg(mock)
      expect(audit).toMatchObject({
        actorId: 'admin-1',
        ip: '10.0.0.1',
        action,
        target: '@anon_9 · Hades II'
      })
      expect(audit.detailFor(2)).not.toMatch(/texto/i)
    }
  )

  it('o detalhe diz quantas denúncias foram fechadas, no singular e no plural', async () => {
    const { service, repository } = build()

    await service.hide('rv-1', ACTOR)

    const { detailFor } = auditArg(repository.hide)
    expect(detailFor(1)).toContain('1 denúncia fechada')
    expect(detailFor(3)).toContain('3 denúncias fechadas')
    expect(detailFor(0)).toContain('0 denúncias')
  })

  it.each(['hide', 'restore', 'dismiss'] as const)(
    '%s devolve changed:false quando o repositório não mudou nada',
    async method => {
      const { service } = build({ [method]: vi.fn().mockResolvedValue(false) })

      expect(await service[method]('rv-1', ACTOR)).toEqual({ changed: false })
    }
  )

  it.each(['hide', 'restore', 'dismiss'] as const)(
    '%s responde 404 quando a review não existe, sem escrever',
    async method => {
      const { service, repository } = build({
        findTarget: vi.fn().mockResolvedValue(null)
      })

      await expect(service[method]('x', ACTOR)).rejects.toMatchObject({
        statusCode: 404
      })
      expect(repository[method]).not.toHaveBeenCalled()
    }
  )

  it('um jogo fora do cache aparece como "Jogo #id" no alvo', async () => {
    const { service, repository } = build({
      findTarget: vi.fn().mockResolvedValue({ ...TARGET, gameName: null })
    })

    await service.hide('rv-1', ACTOR)

    expect(auditArg(repository.hide).target).toBe('@anon_9 · Jogo #7')
  })
})

describe('removeReview', () => {
  it('grava a auditoria estrita ANTES de apagar, com @handle · jogo e sem o texto', async () => {
    const order: string[] = []
    const { service, strictAudit, repository } = build(
      {
        deleteReview: vi.fn().mockImplementation(async () => {
          order.push('delete')
          return { id: 'rv-1' }
        })
      },
      {
        create: vi.fn().mockImplementation(async () => {
          order.push('audit')
          return { id: 'audit-1' }
        })
      }
    )

    const result = await service.removeReview('rv-1', 'anon_9', ACTOR)

    expect(result).toEqual({ deleted: true })
    expect(order).toEqual(['audit', 'delete'])
    expect(strictAudit.create).toHaveBeenCalledWith({
      actorId: 'admin-1',
      action: 'Removeu uma review',
      area: 'MODERATION',
      target: '@anon_9 · Hades II',
      detail: 'Review apagada com 2 denúncias. Sem volta.',
      ip: '10.0.0.1'
    })
    expect(repository.deleteReview).toHaveBeenCalledWith('rv-1')
  })

  it('o handle errado responde 409 e não grava nada', async () => {
    const { service, strictAudit, repository } = build()

    await expect(
      service.removeReview('rv-1', 'outro', ACTOR)
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(strictAudit.create).not.toHaveBeenCalled()
    expect(repository.deleteReview).not.toHaveBeenCalled()
  })

  it('se a auditoria falha, nada é apagado', async () => {
    const { service, repository } = build(
      {},
      { create: vi.fn().mockRejectedValue(new Error('db down')) }
    )

    await expect(service.removeReview('rv-1', 'anon_9', ACTOR)).rejects.toThrow(
      'db down'
    )
    expect(repository.deleteReview).not.toHaveBeenCalled()
  })

  it('se o delete falha, a linha da auditoria vira FAILED e o erro sobe', async () => {
    const { service, strictAudit } = build({
      deleteReview: vi.fn().mockRejectedValue(new Error('boom'))
    })

    await expect(service.removeReview('rv-1', 'anon_9', ACTOR)).rejects.toThrow(
      'boom'
    )
    expect(strictAudit.markFailed).toHaveBeenCalledWith(
      'audit-1',
      'A review não foi removida.'
    )
  })

  it('uma review que sumiu no meio vira 404 e a linha fica FAILED', async () => {
    const gone = new Prisma.PrismaClientKnownRequestError('gone', {
      code: 'P2025',
      clientVersion: 'x'
    })
    const { service, strictAudit } = build({
      deleteReview: vi.fn().mockRejectedValue(gone)
    })

    const error = await service
      .removeReview('rv-1', 'anon_9', ACTOR)
      .catch(e => e)

    expect(error).toBeInstanceOf(ClientError)
    expect(error.statusCode).toBe(404)
    expect(strictAudit.markFailed).toHaveBeenCalled()
  })

  it('se até o markFailed falha, o erro original ainda sobe', async () => {
    const { service } = build(
      { deleteReview: vi.fn().mockRejectedValue(new Error('boom')) },
      { markFailed: vi.fn().mockRejectedValue(new Error('audit down')) }
    )

    await expect(service.removeReview('rv-1', 'anon_9', ACTOR)).rejects.toThrow(
      'boom'
    )
  })

  it('responde 404 quando a review não existe, antes de qualquer auditoria', async () => {
    const { service, strictAudit } = build({
      findTarget: vi.fn().mockResolvedValue(null)
    })

    await expect(
      service.removeReview('x', 'anon_9', ACTOR)
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(strictAudit.create).not.toHaveBeenCalled()
  })
})
