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

export const FAILED_JOB_ID_PATTERN = /^[0-9a-f]{16}$/

/**
 * Id opaco de UMA instância de job falho. O jobId do BullMQ é reaproveitado a cada importação do mesmo
 * usuário, então o timestamp entra no hash: um job reimportado e que falhou de novo tem outro id, e um
 * id velho dá 404 em vez de agir sobre uma falha que o admin não viu.
 */
export function failedJobId(
  store: ImportStore,
  jobId: string,
  timestamp: number
): string {
  return createHash('sha256')
    .update(`${store}:${jobId}:${timestamp}`)
    .digest('hex')
    .slice(0, 16)
}
