import { z } from 'zod'

export const ADMIN_USERS_PAGE_SIZE = 20
export const ADMIN_USERS_MAX_PAGE = 10_000
export const ADMIN_USERS_MAX_QUERY_LENGTH = 100
export const ADMIN_USERS_FILTERS = [
  'all',
  'emailPending',
  'suspended',
  'noStore',
  'noTerms'
] as const

export type AdminUsersFilter = (typeof ADMIN_USERS_FILTERS)[number]

const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

export const AdminUsersListQuerySchema = z.object({
  q: z.preprocess(
    blankToUndefined,
    z.string().trim().max(ADMIN_USERS_MAX_QUERY_LENGTH).optional()
  ),
  filter: z.preprocess(
    blankToUndefined,
    z.enum(ADMIN_USERS_FILTERS).default('all')
  ),
  page: z.coerce.number().int().min(1).max(ADMIN_USERS_MAX_PAGE).default(1)
})

export type AdminUsersListQuery = z.infer<typeof AdminUsersListQuerySchema>

export const AdminUserParamsSchema = z.object({
  id: z.uuid()
})

export const AdminUserDeleteQuerySchema = z.object({
  handle: z.string().trim().min(1).max(100)
})
