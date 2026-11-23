import { prisma } from '../database/db'

export interface UserActionAudit {
  actorId: string
  ip: string
  action: string
  target: string
  detail: string
}

export class AdminUserActionsRepository {
  findTarget(id: string) {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        userName: true,
        role: true,
        suspendedAt: true,
        emailVerifiedAt: true,
        profilePicture: true,
        userBanner: true
      }
    })
  }

  /**
   * Suspende, apaga as sessões e grava a auditoria na mesma transação: apagar
   * sessões não tem volta, então não pode existir sem a linha. Devolve false
   * quando outra requisição já suspendeu.
   */
  suspend(id: string, now: Date, audit: UserActionAudit): Promise<boolean> {
    return prisma.$transaction(async tx => {
      const { count } = await tx.user.updateMany({
        where: { id, suspendedAt: null },
        data: { suspendedAt: now }
      })
      if (count !== 1) return false
      await tx.refreshToken.deleteMany({ where: { userId: id } })
      await tx.auditLog.create({
        data: {
          actorId: audit.actorId,
          action: audit.action,
          area: 'USERS',
          target: audit.target,
          detail: audit.detail,
          ip: audit.ip
        }
      })
      return true
    })
  }

  reactivate(id: string, audit: UserActionAudit): Promise<boolean> {
    return prisma.$transaction(async tx => {
      const { count } = await tx.user.updateMany({
        where: { id, suspendedAt: { not: null } },
        data: { suspendedAt: null }
      })
      if (count !== 1) return false
      await tx.auditLog.create({
        data: {
          actorId: audit.actorId,
          action: audit.action,
          area: 'USERS',
          target: audit.target,
          detail: audit.detail,
          ip: audit.ip
        }
      })
      return true
    })
  }

  /** Apaga o usuário; o banco apaga em cascata o que é dele. */
  deleteUser(id: string) {
    return prisma.user.delete({ where: { id }, select: { id: true } })
  }
}
