import { prisma } from '../database/db'
import type { AuditArea, AuditResult } from '../database/prisma-client'

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
}
