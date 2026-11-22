import type { Job, Queue } from 'bullmq'
import { failedJobId } from '../utils/admin-job-ref'
import {
  IMPORT_JOB_STATES,
  IMPORT_STORES,
  type ImportJobRecord,
  type ImportJobState,
  type ImportStore
} from '../utils/import-jobs'

export type ImportQueues = Record<ImportStore, Queue>

export interface CountsRedis {
  zcount(
    key: string,
    min: number | string,
    max: number | string
  ): Promise<number>
}

export interface QueueCounts {
  waiting: number
  active: number
  delayed: number
  completed: number
  failed: number
}

function toRecord(
  job: Job,
  store: ImportStore,
  state: ImportJobState
): ImportJobRecord {
  const data = job.data as { userId?: unknown } | null
  return {
    id: String(job.id),
    store,
    userId: typeof data?.userId === 'string' ? data.userId : null,
    state,
    timestamp: job.timestamp,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 1,
    failedReason: job.failedReason || null,
    returnValue: job.returnvalue ?? null,
    progress: typeof job.progress === 'number' ? job.progress : null
  }
}

/** O job foi substituído ou mudou de estado entre a checagem e a ação. */
export class JobChangedError extends Error {
  constructor() {
    super('job changed')
  }
}

export class ImportQueueRepository {
  constructor(
    private queues: ImportQueues,
    private redis: CountsRedis
  ) {}

  async counts(store: ImportStore): Promise<QueueCounts> {
    const counts = await this.queues[store].getJobCounts(...IMPORT_JOB_STATES)
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0
    }
  }

  async newest(
    store: ImportStore,
    state: ImportJobState,
    limit: number
  ): Promise<ImportJobRecord[]> {
    if (limit <= 0) return []
    const jobs = await this.queues[store].getJobs([state], 0, limit - 1, false)
    return jobs
      .filter((job): job is Job => Boolean(job))
      .map(job => toRecord(job, store, state))
  }

  async finishedSince(
    store: ImportStore,
    state: 'completed' | 'failed',
    since: number
  ): Promise<number> {
    return this.redis.zcount(this.queues[store].toKey(state), since, '+inf')
  }

  failedCount(store: ImportStore): Promise<number> {
    return this.queues[store].getFailedCount()
  }

  isPaused(store: ImportStore): Promise<boolean> {
    return this.queues[store].isPaused()
  }

  /** Procura entre os `cap` falhos mais recentes o job cujo id opaco é `publicId`. */
  async locateFailed(
    store: ImportStore,
    publicId: string,
    cap: number
  ): Promise<{ record: ImportJobRecord | null; truncated: boolean }> {
    const queue = this.queues[store]
    const [jobs, total] = await Promise.all([
      queue.getJobs(['failed'], 0, cap - 1, false),
      queue.getFailedCount()
    ])
    const job = jobs.find(
      candidate =>
        Boolean(candidate) &&
        failedJobId(store, String(candidate.id), candidate.timestamp) ===
          publicId
    )
    return {
      record: job ? toRecord(job, store, 'failed') : null,
      truncated: total > cap
    }
  }

  /** 'missing' quando o job já não existe (foi descartado, ou substituído por uma nova importação). */
  async stateOf(store: ImportStore, jobId: string): Promise<string> {
    const job = await this.queues[store].getJob(jobId)
    return job ? await job.getState() : 'missing'
  }

  /**
   * Pega o job de novo logo antes de agir e só segue se ele ainda é a MESMA instância (timestamp) e ainda está
   * falho. O jobId é reaproveitado a cada importação do usuário: uma reimportação entre a checagem do serviço e
   * a ação faria `remove()` apagar a importação nova.
   */
  private async sameFailedJob(
    store: ImportStore,
    jobId: string,
    expectedTimestamp: number
  ) {
    const job = await this.queues[store].getJob(jobId)
    if (
      !job ||
      job.timestamp !== expectedTimestamp ||
      (await job.getState()) !== 'failed'
    ) {
      throw new JobChangedError()
    }
    return job
  }

  async retryFailed(
    store: ImportStore,
    jobId: string,
    expectedTimestamp: number
  ): Promise<void> {
    const job = await this.sameFailedJob(store, jobId, expectedTimestamp)
    await job.retry('failed')
  }

  async removeJob(
    store: ImportStore,
    jobId: string,
    expectedTimestamp: number
  ): Promise<void> {
    const job = await this.sameFailedJob(store, jobId, expectedTimestamp)
    await job.remove()
  }

  /** Remove os jobs de importação do usuário que não estão rodando. O id é fixo por usuário e loja. */
  async removeUserJobs(userId: string): Promise<number> {
    let removed = 0
    for (const store of IMPORT_STORES) {
      const job = await this.queues[store].getJob(`${store}-import-${userId}`)
      if (!job || (await job.getState()) === 'active') continue
      await job.remove()
      removed += 1
    }
    return removed
  }

  async setPaused(store: ImportStore, paused: boolean): Promise<void> {
    if (paused) await this.queues[store].pause()
    else await this.queues[store].resume()
  }

  async workers(store: ImportStore): Promise<number | null> {
    try {
      return (await this.queues[store].getWorkers()).length
    } catch {
      return null
    }
  }

  stores(): readonly ImportStore[] {
    return IMPORT_STORES
  }
}
