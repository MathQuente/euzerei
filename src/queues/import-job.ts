import { Queue, UnrecoverableError } from 'bullmq'
import { ClientError } from '../errors/client-error'
import { TimeoutError } from '../utils/with-timeout'

import { defaultImportLimiter, type ImportLimitScope } from './import-limit'

export const IMPORT_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'fixed', delay: 30_000 }
} as const

export function toImportJobError(err: unknown, genericMessage: string): Error {
  if (err instanceof ClientError) return new UnrecoverableError(err.message)
  if (err instanceof TimeoutError) return new UnrecoverableError(genericMessage)
  return new Error(genericMessage)
}

export interface ImportSectionResult {
  imported: number
  updated: number
  skipped: number
  notFound: string[]
  suggestions?: number
}

export async function enqueueUniqueImport(
  queue: Queue,
  jobId: string,
  data: { userId: string },
  platformLabel: string,
  scope: ImportLimitScope,
  now: number = Date.now()
) {
  const existing = await queue.getJob(jobId)

  if (existing) {
    const state = await existing.getState()
    if (state === 'waiting' || state === 'active' || state === 'delayed') {
      throw new ClientError(
        `Já existe uma importação da ${platformLabel} em andamento.`,
        409
      )
    }
  }

  const limit = await (scope.limiter ?? defaultImportLimiter()).check(
    scope.userId,
    scope.store,
    now
  )
  if (limit.blocked) {
    const remainingMinutes = Math.max(1, Math.ceil((limit.until - now) / 60000))
    throw new ClientError(
      `Você pode importar novamente em ${remainingMinutes} minuto(s).`,
      429
    )
  }

  if (existing) {
    await existing.remove()
  }

  await queue.add('import', data, { jobId, ...IMPORT_JOB_OPTIONS })
  return { status: 'queued' as const }
}

export async function getImportJobStatus<TResult>(
  queue: Queue,
  jobId: string,
  scope: ImportLimitScope,
  now: number = Date.now()
) {
  const job = await queue.getJob(jobId)
  if (!job) return { status: 'idle' as const }

  const state = await job.getState()

  if (state === 'completed') {
    return {
      status: 'completed' as const,
      result: job.returnvalue as TResult,
      finishedAt: job.finishedOn,
      cooldownUntil: await cooldownUntil(scope, now)
    }
  }
  if (state === 'failed') {
    return { status: 'failed' as const, error: job.failedReason }
  }

  const progress = typeof job.progress === 'number' ? job.progress : undefined

  return { status: state as 'waiting' | 'active' | 'delayed', progress }
}

// Só um aviso para a tela: se o banco falhar aqui, a consulta de status não cai (o enfileirar decide de verdade).
async function cooldownUntil(scope: ImportLimitScope, now: number) {
  try {
    const limit = await (scope.limiter ?? defaultImportLimiter()).check(
      scope.userId,
      scope.store,
      now
    )
    return limit.blocked ? limit.until : undefined
  } catch (error) {
    console.warn('[ImportLimit] não foi possível calcular o cooldown', error)
    return undefined
  }
}
