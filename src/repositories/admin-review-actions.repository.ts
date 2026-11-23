import { prisma } from '../database/db'

export interface ReviewActionAudit {
  actorId: string
  ip: string
  action: string
  target: string
  /** Recebe quantas denúncias a ação fechou e devolve o texto da auditoria (nunca o texto da review). */
  detailFor: (closedReports: number) => string
}

export class AdminReviewActionsRepository {
  async findTarget(id: string) {
    const review = await prisma.review.findUnique({
      where: { id },
      select: {
        id: true,
        igdbId: true,
        hiddenAt: true,
        user: { select: { userName: true } }
      }
    })
    if (!review) return null

    const [game, reports] = await prisma.$transaction([
      prisma.gameCache.findUnique({
        where: { igdbId: review.igdbId },
        select: { name: true }
      }),
      prisma.reviewReport.count({ where: { reviewId: id } })
    ])

    return {
      id: review.id,
      igdbId: review.igdbId,
      hidden: review.hiddenAt !== null,
      handle: review.user.userName,
      gameName: game?.name ?? null,
      reports
    }
  }

  /**
   * Oculta, fecha as denúncias abertas e grava a auditoria na mesma transação. SQL cru de propósito: `updateMany`
   * do Prisma mexeria em `updated_at`, que é a data da última edição do autor (usada para "editada depois da
   * denúncia"). Devolve false quando outra requisição já ocultou: nesse caso NENHUMA linha de auditoria é gravada.
   */
  hide(id: string, now: Date, audit: ReviewActionAudit): Promise<boolean> {
    return prisma.$transaction(async tx => {
      const changed = await tx.$executeRaw`
        UPDATE reviews SET hidden_at = ${now} WHERE id = ${id} AND hidden_at IS NULL
      `
      if (changed !== 1) return false
      const { count } = await tx.reviewReport.updateMany({
        where: { reviewId: id, resolvedAt: null },
        data: {
          resolvedAt: now,
          resolvedById: audit.actorId,
          resolution: 'HIDDEN'
        }
      })
      await this.writeAudit(tx, audit, count)
      return true
    })
  }

  restore(id: string, audit: ReviewActionAudit): Promise<boolean> {
    return prisma.$transaction(async tx => {
      const changed = await tx.$executeRaw`
        UPDATE reviews SET hidden_at = NULL WHERE id = ${id} AND hidden_at IS NOT NULL
      `
      if (changed !== 1) return false
      await this.writeAudit(tx, audit, 0)
      return true
    })
  }

  /** "Manter": fecha as denúncias abertas como dispensadas. Sem denúncia aberta não há o que decidir (false). */
  dismiss(id: string, now: Date, audit: ReviewActionAudit): Promise<boolean> {
    return prisma.$transaction(async tx => {
      const { count } = await tx.reviewReport.updateMany({
        where: { reviewId: id, resolvedAt: null },
        data: {
          resolvedAt: now,
          resolvedById: audit.actorId,
          resolution: 'DISMISSED'
        }
      })
      if (count === 0) return false
      await this.writeAudit(tx, audit, count)
      return true
    })
  }

  /** Apaga a review; as denúncias dela vão em cascata. */
  deleteReview(id: string) {
    return prisma.review.delete({ where: { id }, select: { id: true } })
  }

  private writeAudit(
    tx: Pick<typeof prisma, 'auditLog'>,
    audit: ReviewActionAudit,
    closedReports: number
  ) {
    return tx.auditLog.create({
      data: {
        actorId: audit.actorId,
        action: audit.action,
        area: 'MODERATION',
        target: audit.target,
        detail: audit.detailFor(closedReports),
        ip: audit.ip
      }
    })
  }
}
