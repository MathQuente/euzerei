import type { Job, Worker } from 'bullmq'
import { UnrecoverableError } from 'bullmq'
import {
  ImportRunsRepository,
  type ImportRunInput
} from '../repositories/import-runs.repository'
import {
  accountErrors,
  gamesRead,
  type ImportStore
} from '../utils/import-jobs'
import { jobRef, truncateReason } from '../utils/admin-job-ref'

function userIdOf(job: Job): string | null {
  const userId = (job.data as { userId?: unknown } | null)?.userId
  return typeof userId === 'string' ? userId : null
}

function build(
  store: ImportStore,
  job: Job,
  outcome: {
    status: ImportRunInput['status']
    error: string | null
    games: number | null
  }
): ImportRunInput {
  const finishedAt = job.finishedOn ?? Date.now()
  return {
    store,
    userId: userIdOf(job),
    ref: jobRef(store, String(job.id)),
    status: outcome.status,
    attempts: job.attemptsMade,
    games: outcome.games,
    error: outcome.error,
    startedAt: new Date(job.processedOn ?? job.timestamp ?? finishedAt),
    finishedAt: new Date(finishedAt)
  }
}

/**
 * Grava uma linha em `import_runs` quando o job termina DE VEZ. Uma falha que ainda vai ser tentada de novo
 * não grava; a que não tem nova tentativa (ou é `UnrecoverableError`) grava. Nada aqui pode atrapalhar a
 * importação: os ouvintes não são esperados pelo BullMQ, então qualquer erro vira só um aviso no log.
 */
export function attachRunRecorder(
  worker: Worker,
  store: ImportStore,
  repository: ImportRunsRepository = new ImportRunsRepository()
) {
  const save = async (input: ImportRunInput) => {
    try {
      await repository.create(input)
    } catch (error) {
      console.warn('[ImportRuns] could not record the run', {
        store,
        ref: input.ref,
        error: error instanceof Error ? error.message : 'unknown error'
      })
    }
  }

  worker.on('completed', job => {
    const result = job.returnvalue
    void save(
      build(store, job, {
        status: accountErrors(result).length > 0 ? 'WARNING' : 'DONE',
        error: truncateReason(accountErrors(result)[0] ?? null),
        games: gamesRead(result)
      })
    )
  })

  worker.on('failed', (job, err) => {
    if (!job) return
    void (async () => {
      try {
        const final =
          err instanceof UnrecoverableError ||
          (await job.getState()) === 'failed'
        if (!final) return
        await save(
          build(store, job, {
            status: 'FAILED',
            error: truncateReason(err.message),
            games: null
          })
        )
      } catch (error) {
        console.warn('[ImportRuns] could not read the job state', {
          store,
          error: error instanceof Error ? error.message : 'unknown error'
        })
      }
    })()
  })
}
