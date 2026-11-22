import { z } from 'zod'
import { IMPORT_STORES } from '../utils/import-jobs'

const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

export const FAILED_JOBS_LIMIT = 10

export const FailedJobsQuerySchema = z.object({
  store: z.preprocess(blankToUndefined, z.enum(IMPORT_STORES).optional())
})

export type FailedJobsQuery = z.infer<typeof FailedJobsQuerySchema>

export const QueueStoreParamsSchema = z.object({
  store: z.enum(IMPORT_STORES)
})

export const FailedJobParamsSchema = z.object({
  store: z.enum(IMPORT_STORES),
  id: z.string().regex(/^[0-9a-f]{16}$/)
})
