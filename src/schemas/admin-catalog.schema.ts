import { z } from 'zod'

export const CATALOG_SEARCH_LIMIT = 8
export const CATALOG_TOP_LIMIT = 5
export const CATALOG_MAX_DAYS = 30
export const CATALOG_DEFAULT_DAYS = 7
const MAX_IGDB_ID = 2_147_483_647

export const CatalogSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100)
})

export const CatalogGameParamsSchema = z.object({
  igdbId: z.coerce.number().int().min(1).max(MAX_IGDB_ID)
})

const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

export const CatalogTopAddedQuerySchema = z.object({
  days: z.preprocess(
    blankToUndefined,
    z.coerce
      .number()
      .int()
      .min(1)
      .max(CATALOG_MAX_DAYS)
      .default(CATALOG_DEFAULT_DAYS)
  )
})

export const CatalogJobParamsSchema = z.object({
  key: z.string().regex(/^[a-z]{1,20}$/)
})

export const CatalogRunBodySchema = z.object({
  mode: z.enum(['dry', 'apply'])
})

export type CatalogSearchQuery = z.infer<typeof CatalogSearchQuerySchema>
export type CatalogTopAddedQuery = z.infer<typeof CatalogTopAddedQuerySchema>
