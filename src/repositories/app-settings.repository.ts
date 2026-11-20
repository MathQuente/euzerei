import { prisma } from '../database/db'
import { Prisma } from '../database/prisma-client'

export class AppSettingsRepository {
  findAll() {
    return prisma.appSetting.findMany()
  }

  upsertMany(values: Record<string, unknown>, updatedById: string) {
    return prisma.$transaction(
      Object.entries(values).map(([key, value]) =>
        prisma.appSetting.upsert({
          where: { key },
          create: { key, value: value as Prisma.InputJsonValue, updatedById },
          update: { value: value as Prisma.InputJsonValue, updatedById }
        })
      )
    )
  }
}
