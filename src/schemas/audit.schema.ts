import { z } from 'zod'
import type { AuditArea } from '../database/prisma-client'

export const AUDIT_PAGE_SIZE = 20
export const AUDIT_MAX_PAGE = 10_000
export const AUDIT_MAX_QUERY_LENGTH = 100

export const AUDIT_AREA_BY_QUERY = {
  users: 'USERS',
  imports: 'IMPORTS',
  catalog: 'CATALOG',
  moderation: 'MODERATION',
  system: 'SYSTEM'
} as const satisfies Record<string, AuditArea>

export type AuditAreaQuery = keyof typeof AUDIT_AREA_BY_QUERY

const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

export const AuditListQuerySchema = z.object({
  area: z.preprocess(
    blankToUndefined,
    z.enum(Object.keys(AUDIT_AREA_BY_QUERY) as [AuditAreaQuery]).optional()
  ),
  q: z.preprocess(
    blankToUndefined,
    z.string().trim().max(AUDIT_MAX_QUERY_LENGTH).optional()
  ),
  page: z.coerce.number().int().min(1).max(AUDIT_MAX_PAGE).default(1),
  period: z.enum(['7', '30', '90']).default('7').transform(Number)
})

export type AuditListQuery = z.infer<typeof AuditListQuerySchema>
