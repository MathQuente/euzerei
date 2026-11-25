import {
  ImportRunsRepository,
  type ImportRunsTotals
} from '../repositories/import-runs.repository'
import { daysAgo } from '../utils/brasilia-time'
import { IMPORT_STORES, type ImportStore } from '../utils/import-jobs'
import { createTtlCache } from '../utils/ttl-cache'

export const IMPORT_RUNS_TTL_MS = 60_000

function weightedAverage(rows: ImportRunsTotals[]): number | null {
  // A média de duração só conta as que terminaram (a falha não tem duração útil).
  const finished = rows.filter(row => row.avgDurationMs !== null)
  const weight = finished.reduce((sum, row) => sum + row.done + row.warning, 0)
  if (weight === 0) return null
  return Math.round(
    finished.reduce(
      (sum, row) => sum + (row.avgDurationMs ?? 0) * (row.done + row.warning),
      0
    ) / weight
  )
}

export class AdminImportRunsService {
  private cached = createTtlCache(IMPORT_RUNS_TTL_MS)

  constructor(
    private repository: ImportRunsRepository = new ImportRunsRepository()
  ) {}

  summary(days: 7 | 30, now: Date = new Date()) {
    return this.cached(`summary:${days}`, () => this.build(days, now))
  }

  private async build(days: 7 | 30, now: Date) {
    const windowStart = daysAgo(now, days)
    const [rows, earliest] = await Promise.all([
      this.repository.totalsSince(windowStart),
      this.repository.earliest()
    ])
    const byStore = new Map(rows.map(row => [row.store, row]))
    const perStore = IMPORT_STORES.map((store: ImportStore) => {
      const row = byStore.get(store)
      return {
        store,
        total: row?.total ?? 0,
        done: row?.done ?? 0,
        warning: row?.warning ?? 0,
        failed: row?.failed ?? 0,
        avgDurationMs: row?.avgDurationMs ?? null
      }
    })
    const total = perStore.reduce((sum, row) => sum + row.total, 0)
    const failed = perStore.reduce((sum, row) => sum + row.failed, 0)

    return {
      generatedAt: now.toISOString(),
      days,
      // O histórico nasce no deploy: sem estes dois campos, zero pareceria "ninguém importou".
      historySince: earliest?.toISOString() ?? null,
      partial: earliest === null || earliest.getTime() > windowStart.getTime(),
      total,
      done: perStore.reduce((sum, row) => sum + row.done, 0),
      warning: perStore.reduce((sum, row) => sum + row.warning, 0),
      failed,
      failureRate: total === 0 ? null : failed / total,
      avgDurationMs: weightedAverage(rows),
      perStore
    }
  }
}
