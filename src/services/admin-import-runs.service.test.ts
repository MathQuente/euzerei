import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminImportRunsService } from './admin-import-runs.service'
import type {
  ImportRunsRepository,
  ImportRunsTotals
} from '../repositories/import-runs.repository'

const repository = { totalsSince: vi.fn(), earliest: vi.fn() }
const NOW = new Date('2026-11-24T15:00:00Z')

function totals(overrides: Partial<ImportRunsTotals>): ImportRunsTotals {
  return {
    store: 'steam',
    total: 0,
    done: 0,
    warning: 0,
    failed: 0,
    avgDurationMs: null,
    ...overrides
  }
}

function service() {
  return new AdminImportRunsService(
    repository as unknown as ImportRunsRepository
  )
}

beforeEach(() => {
  repository.totalsSince.mockReset().mockResolvedValue([])
  repository.earliest.mockReset().mockResolvedValue(null)
})

describe('AdminImportRunsService.summary', () => {
  it('asks for the rolling window of the period', async () => {
    await service().summary(30, NOW)

    expect(repository.totalsSince).toHaveBeenCalledWith(
      new Date('2026-10-25T15:00:00Z')
    )
  })

  it('totals the stores, always lists the three, and weights the average by finished runs', async () => {
    repository.totalsSince.mockResolvedValue([
      totals({
        store: 'steam',
        total: 6,
        done: 4,
        warning: 0,
        failed: 2,
        avgDurationMs: 60_000
      }),
      totals({
        store: 'xbox',
        total: 2,
        done: 0,
        warning: 2,
        failed: 0,
        avgDurationMs: 120_000
      })
    ])
    repository.earliest.mockResolvedValue(new Date('2026-11-01T00:00:00Z'))

    const result = await service().summary(7, NOW)

    expect(result).toMatchObject({
      days: 7,
      total: 8,
      done: 4,
      warning: 2,
      failed: 2,
      failureRate: 0.25,
      // (60 s x 4 + 120 s x 2) / 6
      avgDurationMs: 80_000
    })
    expect(result.perStore.map(row => row.store)).toEqual([
      'steam',
      'xbox',
      'psn'
    ])
    expect(result.perStore[2]).toMatchObject({ total: 0, avgDurationMs: null })
  })

  it('has no failure rate and no average when nothing ran', async () => {
    const result = await service().summary(7, NOW)

    expect(result).toMatchObject({
      total: 0,
      failureRate: null,
      avgDurationMs: null
    })
  })

  it('says the history is partial and when it starts, so zero is not read as "nobody imported"', async () => {
    repository.earliest.mockResolvedValue(new Date('2026-11-22T10:00:00Z'))

    const result = await service().summary(7, NOW)

    expect(result.partial).toBe(true)
    expect(result.historySince).toBe('2026-11-22T10:00:00.000Z')
  })

  it('is not partial once the history covers the whole window', async () => {
    repository.earliest.mockResolvedValue(new Date('2026-10-01T00:00:00Z'))

    const result = await service().summary(30, NOW)

    expect(result.partial).toBe(false)
  })

  it('is partial with no history at all', async () => {
    const result = await service().summary(7, NOW)

    expect(result).toMatchObject({ partial: true, historySince: null })
  })

  it('answers from the cache inside the minute, and per period', async () => {
    const svc = service()
    await svc.summary(7, NOW)
    await svc.summary(7, NOW)
    await svc.summary(30, NOW)

    expect(repository.totalsSince).toHaveBeenCalledTimes(2)
  })
})
