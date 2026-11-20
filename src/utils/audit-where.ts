import type { Prisma } from '../database/prisma-client'
import { escapeLike } from './escape-like'
import {
  AUDIT_AREA_BY_QUERY,
  type AuditAreaQuery
} from '../schemas/audit.schema'

export interface AuditFilters {
  area?: AuditAreaQuery
  q?: string
  since: Date
}

export function buildAuditWhere(
  filters: AuditFilters
): Prisma.AuditLogWhereInput {
  const text = (field: 'action' | 'target' | 'detail', q: string) => ({
    [field]: { contains: escapeLike(q), mode: 'insensitive' as const }
  })

  return {
    createdAt: { gte: filters.since },
    ...(filters.area ? { area: AUDIT_AREA_BY_QUERY[filters.area] } : {}),
    ...(filters.q
      ? {
          OR: [
            text('action', filters.q),
            text('target', filters.q),
            text('detail', filters.q)
          ]
        }
      : {})
  }
}
