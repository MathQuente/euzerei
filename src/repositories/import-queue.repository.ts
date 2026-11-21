import type { Job, Queue } from 'bullmq'
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
