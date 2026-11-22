import { ClientError } from '../errors/client-error'
import type {
  CatalogCounts,
  CatalogStore
} from '../repositories/admin-catalog.repository'
import {
  CATALOG_SEARCH_LIMIT,
  CATALOG_TOP_LIMIT
} from '../schemas/admin-catalog.schema'
import { withReadLimit } from '../utils/admin-read-limit'
import { CATALOG_JOBS } from '../utils/admin-catalog-jobs'
import { daysAgo } from '../utils/brasilia-time'
import { createTtlCache } from '../utils/ttl-cache'

export const CATALOG_TTL_MS = 60_000
const UNAVAILABLE = 'Não foi possível ler o catálogo agora.'

export type JobState = 'upToDate' | 'pending' | 'unknown'

export class AdminCatalogService {
  private cached = createTtlCache(CATALOG_TTL_MS)

  constructor(private store: CatalogStore) {}

  counts(now: Date = new Date()): Promise<CatalogCounts> {
    return this.cached('counts', () =>
      withReadLimit(() => this.store.counts(daysAgo(now, 7)), UNAVAILABLE)
    )
  }

  async overviewCatalog(now: Date = new Date()) {
    const counts = await this.counts(now)
    return {
      generatedAt: now.toISOString(),
      total: counts.total,
      noCover: counts.noCover,
      modesUnchecked: counts.modesUnchecked,
      noSlug: counts.noSlug
    }
  }

  summary(now: Date = new Date()) {
    return this.cached('summary', () =>
      withReadLimit(() => this.buildSummary(now), UNAVAILABLE)
    )
  }

  private async buildSummary(now: Date) {
    const [counts, added] = await Promise.all([
      this.counts(now),
      this.store.added(daysAgo(now, 7)).catch(() => null)
    ])
    return {
      generatedAt: now.toISOString(),
      total: counts.total,
      updated7d: counts.updated7d,
      noCover: counts.noCover,
      noPrecision: counts.noPrecision,
      lastSyncedAt: counts.lastSyncedAt?.toISOString() ?? null,
      added7d: added
    }
  }

  jobs(now: Date = new Date()) {
    return this.cached('jobs', () =>
      withReadLimit(() => this.buildJobs(now), UNAVAILABLE)
    )
  }

  private async buildJobs(now: Date) {
    const counts = await this.counts(now)
    const actions = CATALOG_JOBS.flatMap(job =>
      job.action ? [job.action] : []
    )
    const runs = await this.store
      .lastRuns(actions)
      .catch(() => new Map<string, Date>())

    return {
      generatedAt: now.toISOString(),
      jobs: CATALOG_JOBS.map(job => {
        const pending = job.pending(counts)
        const audited = job.action ? runs.get(job.action) : undefined
        const lastRunAt =
          audited ?? (job.key === 'sync' ? counts.lastSyncedAt : null)
        const state: JobState =
          pending === null ? 'unknown' : pending === 0 ? 'upToDate' : 'pending'
        return {
          key: job.key,
          title: job.title,
          script: job.script,
          pending,
          state,
          lastRunAt: lastRunAt?.toISOString() ?? null,
          lastRunSource: audited ? 'audit' : lastRunAt ? 'cache' : null
        }
      })
    }
  }

  async search(query: string) {
    const items = await withReadLimit(
      () => this.store.search(query, CATALOG_SEARCH_LIMIT),
      UNAVAILABLE
    )
    return { items }
  }

  async game(igdbId: number) {
    const game = await withReadLimit(() => this.store.game(igdbId), UNAVAILABLE)
    if (!game) throw new ClientError('Jogo não encontrado.', 404)
    return {
      ...game,
      syncedAt: game.syncedAt.toISOString()
    }
  }

  topAdded(days: number, now: Date = new Date()) {
    return this.cached(`top:${days}`, () =>
      withReadLimit(async () => {
        const items = await this.store.topAdded(
          daysAgo(now, days),
          CATALOG_TOP_LIMIT
        )
        return { generatedAt: now.toISOString(), days, items }
      }, UNAVAILABLE)
    )
  }
}
