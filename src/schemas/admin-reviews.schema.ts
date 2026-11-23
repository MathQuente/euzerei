import { z } from 'zod'

export const ADMIN_REVIEWS_PAGE_SIZE = 20
export const ADMIN_REVIEWS_MAX_PAGE = 10_000
export const ADMIN_REVIEWS_MAX_QUERY_LENGTH = 100
export const ADMIN_REVIEWS_STATUSES = ['open', 'all'] as const

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
  page: z.coerce.number().int().min(1).max(ADMIN_REVIEWS_MAX_PAGE).default(1)
})

export type AdminReviewsListQuery = z.infer<typeof AdminReviewsListQuerySchema>

export const AdminReviewParamsSchema = z.object({ id: z.uuid() })
