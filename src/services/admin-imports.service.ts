import {
  ImportQueueRepository,
  type QueueCounts
} from '../repositories/import-queue.repository'
import {
  IMPORTS_PAGE_SIZE,
  type ImportListQuery
} from '../schemas/admin-imports.schema'
import { startOfBrasiliaDay } from '../utils/brasilia-time'
import {
  IMPORT_JOB_STATES,
  IMPORT_STORES,
  STATES_BY_STATUS_FILTER,
  accountNames,
  durationOf,
  gamesRead,
  notFoundCount,
  reasonOf,
  sortKeyOf,
  statusOf,
  type ImportJobRecord,
  type ImportJobState,
  type ImportStore
} from '../utils/import-jobs'
import { createTtlCache } from '../utils/ttl-cache'
import { TimeoutError, withTimeout } from '../utils/with-timeout'
import { ClientError } from '../errors/client-error'

export const SUMMARY_TTL_MS = 10_000
export const QUEUE_READ_TIMEOUT_MS = 5_000
const QUEUE_UNAVAILABLE = 'Não foi possível ler as filas agora.'
export const DURATION_SAMPLE = 50
export const FAILURE_SAMPLE_PER_STORE = 100
const NO_REASON = 'Motivo não registrado'

export interface HandleLookup {
  findHandles(userIds: string[]): Promise<Map<string, string>>
}

type Durations = Record<ImportStore, number | null>

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return Math.round(
    values.reduce((sum, value) => sum + value, 0) / values.length
  )
}

function sumStates(counts: QueueCounts, states: readonly ImportJobState[]) {
  return states.reduce((sum, state) => sum + counts[state], 0)
}

async function readQueues<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await withTimeout(read(), QUEUE_READ_TIMEOUT_MS, QUEUE_UNAVAILABLE)
  } catch (error) {
    if (error instanceof TimeoutError) {
      throw new ClientError(QUEUE_UNAVAILABLE, 503)
    }
    throw error
  }
}

export class AdminImportsService {
  private cached = createTtlCache(SUMMARY_TTL_MS)

  constructor(
    private queueRepository: ImportQueueRepository,
    private handles: HandleLookup
  ) {}

  private async allCounts() {
    const entries = await Promise.all(
      IMPORT_STORES.map(
        async store =>
          [store, await this.queueRepository.counts(store)] as const
      )
    )
    return Object.fromEntries(entries) as Record<ImportStore, QueueCounts>
  }

  private toItem(record: ImportJobRecord, handle: string | null) {
    return {
      id: record.id,
      store: record.store,
      handle,
      status: statusOf(record),
      games: gamesRead(record.returnValue),
      notFound: notFoundCount(record.returnValue),
      account: accountNames(record.returnValue),
      reason: reasonOf(record),
      progress: record.state === 'active' ? record.progress : null,
      attempts: { made: record.attemptsMade, max: record.maxAttempts },
      createdAt: new Date(record.timestamp).toISOString(),
      startedAt:
        record.processedOn === null
          ? null
          : new Date(record.processedOn).toISOString(),
      finishedAt:
        record.finishedOn === null
          ? null
          : new Date(record.finishedOn).toISOString(),
      durationMs: durationOf(record)
    }
  }

  list(query: ImportListQuery) {
    return readQueues(() => this.buildList(query))
  }

  private async buildList(query: ImportListQuery) {
    const stores = query.store ? [query.store] : [...IMPORT_STORES]
    const states = query.status
      ? STATES_BY_STATUS_FILTER[query.status]
      : IMPORT_JOB_STATES
    const need = query.page * IMPORTS_PAGE_SIZE

    const counts = await this.allCounts()
    const total = stores.reduce(
      (sum, store) => sum + sumStates(counts[store], states),
      0
    )

    const reads = stores.flatMap(store =>
      states
        .filter(state => counts[store][state] > 0)
        .map(state =>
          this.queueRepository.newest(
            store,
            state,
            Math.min(need, counts[store][state])
          )
        )
    )
    const records = (await Promise.all(reads)).flat()
    const pageRecords = records
      .sort((a, b) => sortKeyOf(b) - sortKeyOf(a))
      .slice((query.page - 1) * IMPORTS_PAGE_SIZE, need)

    const ids = [
      ...new Set(
        pageRecords
          .map(record => record.userId)
          .filter((id): id is string => id !== null)
      )
    ]
    const handles = await this.handles.findHandles(ids)

    return {
      items: pageRecords.map(record =>
        this.toItem(
          record,
          record.userId === null ? null : (handles.get(record.userId) ?? null)
        )
      ),
      page: query.page,
      pageSize: IMPORTS_PAGE_SIZE,
      total
    }
  }

  summary(now: Date = new Date()) {
    return this.cached('summary', () =>
      readQueues(() => this.buildSummary(now))
    )
  }

  private async buildSummary(now: Date) {
    const todayStart = startOfBrasiliaDay(now).getTime()
    const counts = await this.allCounts()

    const perStore = await Promise.all(
      IMPORT_STORES.map(async store => {
        const [done, failed, completed] = await Promise.all([
          this.queueRepository.finishedSince(store, 'completed', todayStart),
          this.queueRepository.finishedSince(store, 'failed', todayStart),
          this.queueRepository.newest(store, 'completed', DURATION_SAMPLE)
        ])
        const durations = completed
          .map(durationOf)
          .filter((value): value is number => value !== null)
        return { store, done, failed, durations }
      })
    )

    const avgByStore = Object.fromEntries(
      perStore.map(entry => [entry.store, average(entry.durations)])
    ) as Durations
    const allDurations = perStore.flatMap(entry => entry.durations)

    return {
      queued: IMPORT_STORES.reduce(
        (sum, store) => sum + sumStates(counts[store], ['waiting', 'delayed']),
        0
      ),
      running: IMPORT_STORES.reduce(
        (sum, store) => sum + counts[store].active,
        0
      ),
      finishedToday: perStore.reduce(
        (sum, entry) => sum + entry.done + entry.failed,
        0
      ),
      failedToday: perStore.reduce((sum, entry) => sum + entry.failed, 0),
      failedNow: IMPORT_STORES.reduce(
        (sum, store) => sum + counts[store].failed,
        0
      ),
      completedKept: IMPORT_STORES.reduce(
        (sum, store) => sum + counts[store].completed,
        0
      ),
      avgDurationMs: { ...avgByStore, overall: average(allDurations) },
      durationSample: allDurations.length
    }
  }

  failures() {
    return this.cached('failures', () => readQueues(() => this.buildFailures()))
  }

  private async buildFailures() {
    const counts = await this.allCounts()
    const records = (
      await Promise.all(
        IMPORT_STORES.map(store =>
          this.queueRepository.newest(store, 'failed', FAILURE_SAMPLE_PER_STORE)
        )
      )
    ).flat()

    const groups = new Map<
      string,
      { count: number; stores: Set<ImportStore> }
    >()
    for (const record of records) {
      const reason = record.failedReason ?? NO_REASON
      const group = groups.get(reason) ?? { count: 0, stores: new Set() }
      group.count += 1
      group.stores.add(record.store)
      groups.set(reason, group)
    }

    const failedTotal = IMPORT_STORES.reduce(
      (sum, store) => sum + counts[store].failed,
      0
    )
    return {
      total: failedTotal,
      sampled: records.length,
      reasons: [...groups.entries()]
        .map(([reason, group]) => ({
          reason,
          count: group.count,
          stores: [...group.stores]
        }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    }
  }

  queues() {
    return this.cached('queues', () => readQueues(() => this.buildQueues()))
  }

  private async buildQueues() {
    const counts = await this.allCounts()
    const workers = await Promise.all(
      IMPORT_STORES.map(store => this.queueRepository.workers(store))
    )
    return {
      queues: IMPORT_STORES.map((store, index) => ({
        store,
        ...counts[store],
        workers: workers[index]
      }))
    }
  }
}
