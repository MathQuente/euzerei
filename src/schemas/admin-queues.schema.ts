import { z } from 'zod'
import { IMPORT_STORES } from '../utils/import-jobs'

const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

export const FAILED_JOBS_LIMIT = 10

export const FailedJobsQuerySchema = z.object({
  store: z.preprocess(blankToUndefined, z.enum(IMPORT_STORES).optional())
})

export type FailedJobsQuery = z.infer<typeof FailedJobsQuerySchema>
