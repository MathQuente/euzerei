import { createHash } from 'node:crypto'
import type { ImportStore } from './import-jobs'

export const REASON_MAX_LENGTH = 160

export function jobRef(store: ImportStore, jobId: string): string {
  const digest = createHash('sha256').update(jobId).digest('hex').slice(0, 4)
  return `${store}-import:${digest}`
}

export function truncateReason(reason: string | null): string | null {
  if (reason === null) return null
  const text = reason.trim()
  if (text === '') return null
  return text.length > REASON_MAX_LENGTH
    ? `${text.slice(0, REASON_MAX_LENGTH - 1)}…`
    : text
}
