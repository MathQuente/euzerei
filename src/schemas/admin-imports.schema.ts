import { z } from 'zod'
import { IMPORT_STORES } from '../utils/import-jobs'

export const IMPORTS_PAGE_SIZE = 20
export const IMPORTS_MAX_PAGE = 25

const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

export const ImportListQuerySchema = z.object({
  status: z.preprocess(
    blankToUndefined,
    z.enum(['failed', 'running', 'queued', 'done']).optional()
  ),
  store: z.preprocess(blankToUndefined, z.enum(IMPORT_STORES).optional()),
  page: z.coerce.number().int().min(1).max(IMPORTS_MAX_PAGE).default(1)
})

export type ImportListQuery = z.infer<typeof ImportListQuerySchema>
