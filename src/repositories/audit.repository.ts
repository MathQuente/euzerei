import { prisma } from '../database/db'
import type { AuditArea, AuditResult, Prisma } from '../database/prisma-client'

export interface AuditEntryInput {
  actorId: string | null
  action: string
  area: AuditArea
  target?: string | null
  detail?: string | null
  result?: AuditResult
  ip?: string | null
}

export class AuditRepository {
  create(entry: AuditEntryInput) {
    return prisma.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        area: entry.area,
        target: entry.target ?? null,
        detail: entry.detail ?? null,
        result: entry.result ?? 'OK',
        ip: entry.ip ?? null
      }
    })
  }

  /** A ação que a linha registrava não aconteceu: a linha vira FAILED em vez de continuar dizendo OK. */
  markFailed(id: string, detail: string) {
    return prisma.auditLog.update({
      where: { id },
      data: { result: 'FAILED', detail }
    })
  }

  findPage(where: Prisma.AuditLogWhereInput, skip: number, take: number) {
    return prisma.$transaction([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
        select: {
          id: true,
          createdAt: true,
          action: true,
          area: true,
          target: true,
          detail: true,
          result: true,
          ip: true
        }
      })
    ])
  }

  async summaryCounts(windows: {
    todayStart: Date
    weekStart: Date
    backfillActions: readonly string[]
    suspendAction: string
  }) {
    const [
      actionsToday,
      actionsLast7Days,
      backfillsToday,
      suspensions,
      failures
    ] = await prisma.$transaction([
      prisma.auditLog.count({
        where: { createdAt: { gte: windows.todayStart } }
      }),
      prisma.auditLog.count({
        where: { createdAt: { gte: windows.weekStart } }
      }),
      prisma.auditLog.count({
        where: {
          createdAt: { gte: windows.todayStart },
          action: { in: [...windows.backfillActions] }
        }
      }),
      prisma.auditLog.count({
        where: {
          createdAt: { gte: windows.weekStart },
          action: windows.suspendAction
        }
      }),
      prisma.auditLog.count({
        where: { createdAt: { gte: windows.weekStart }, result: 'FAILED' }
      })
    ])

    return {
      actionsToday,
      actionsLast7Days,
      backfillsToday,
      suspensionsLast7Days: suspensions,
      failuresLast7Days: failures
    }
  }
}
