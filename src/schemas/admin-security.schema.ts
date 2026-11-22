import { z } from 'zod'

export const BlockParamsSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{16}$/)
})

export const SessionParamsSchema = z.object({
  id: z.uuid()
})
