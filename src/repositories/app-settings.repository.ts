import { prisma } from '../database/db'
import { Prisma } from '../database/prisma-client'
import type { AuditEntryInput } from './audit.repository'

const SETTINGS_LOCK_ID = 7_204_001

type Client = Prisma.TransactionClient | typeof prisma

export class AppSettingsRepository {
  findAll(client: Client = prisma) {
    return client.appSetting.findMany()
  }

  findByKey(key: string, client: Client = prisma) {
    return client.appSetting.findUnique({ where: { key } })
  }

  runExclusive<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SETTINGS_LOCK_ID}::bigint)`
      return work(tx)
    })
  }

  async saveWithAudit(
    tx: Prisma.TransactionClient,
    values: Record<string, unknown>,
    updatedById: string,
    audit: Omit<AuditEntryInput, 'actorId'>
  ) {
    for (const [key, value] of Object.entries(values)) {
      await tx.appSetting.upsert({
        where: { key },
        create: { key, value: value as Prisma.InputJsonValue, updatedById },
        update: { value: value as Prisma.InputJsonValue, updatedById }
      })
    }

    await tx.auditLog.create({
      data: {
        actorId: updatedById,
        action: audit.action,
        area: audit.area,
        target: audit.target ?? null,
        detail: audit.detail ?? null,
        result: audit.result ?? 'OK',
        ip: audit.ip ?? null
      }
    })
  }
}
