import { z } from 'zod'

export const ADMIN_REVIEWS_PAGE_SIZE = 20
export const ADMIN_REVIEWS_MAX_PAGE = 10_000
export const ADMIN_REVIEWS_MAX_QUERY_LENGTH = 100
export const ADMIN_REVIEWS_MAX_LIMIT = 50
export const ADMIN_REVIEWS_STATUSES = [
  'open',
  'resolved',
  'hidden',
  'all'
] as const

export type AdminReviewsStatus = (typeof ADMIN_REVIEWS_STATUSES)[number]

const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

export const AdminReviewsListQuerySchema = z.object({
  q: z.preprocess(
    blankToUndefined,
    z.string().trim().max(ADMIN_REVIEWS_MAX_QUERY_LENGTH).optional()
  ),
  status: z.preprocess(
    blankToUndefined,
    z.enum(ADMIN_REVIEWS_STATUSES).default('open')
  ),
  page: z.coerce.number().int().min(1).max(ADMIN_REVIEWS_MAX_PAGE).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ADMIN_REVIEWS_MAX_LIMIT)
    .default(ADMIN_REVIEWS_PAGE_SIZE)
})

export type AdminReviewsListQuery = z.infer<typeof AdminReviewsListQuerySchema>

export const AdminReviewParamsSchema = z.object({ id: z.uuid() })

export const AdminReviewDeleteQuerySchema = z.object({
  handle: z.string().trim().min(1).max(100)
})
