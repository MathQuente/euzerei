import { describe, it, expect } from 'vitest'
import {
  accountErrors,
  accountNames,
  durationOf,
  gamesRead,
  notFoundCount,
  reasonOf,
  sortKeyOf,
  statusOf,
  type ImportJobRecord
} from './import-jobs'

function record(overrides: Partial<ImportJobRecord> = {}): ImportJobRecord {
  return {
    id: 'steam-import-u1',
    store: 'steam',
    userId: 'u1',
    state: 'completed',
    timestamp: 1_000,
    processedOn: 2_000,
    finishedOn: 5_000,
    attemptsMade: 1,
    maxAttempts: 2,
    failedReason: null,
    returnValue: null,
    progress: null,
    ...overrides
  }
}

describe('statusOf', () => {
  it.each([
    ['failed', 'failed'],
    ['active', 'running'],
    ['waiting', 'queued'],
    ['delayed', 'queued'],
    ['completed', 'done']
  ] as const)('state %s is status %s', (state, status) => {
    expect(statusOf(record({ state }))).toBe(status)
  })

  it('a completed job where one account failed is a warning, not done', () => {
    const returnValue = {
      accounts: [
        { displayName: 'a' },
        { displayName: 'b', error: 'Perfil privado' }
      ]
    }
    expect(statusOf(record({ returnValue }))).toBe('warning')
  })

  it('games that were not found do NOT make a warning (it happens on almost every Steam import)', () => {
    const returnValue = {
      library: { imported: 10, notFound: Array(15).fill('x') }
    }
    expect(statusOf(record({ returnValue }))).toBe('done')
  })
})

describe('gamesRead and notFoundCount', () => {
  it('sums imported, updated, skipped and not found games of the library section', () => {
    const returnValue = {
      library: {
        imported: 100,
        updated: 20,
        skipped: 5,
        notFound: ['a', 'b', 'c']
      },
      wishlist: { imported: 999 }
    }
    expect(gamesRead(returnValue)).toBe(128)
    expect(notFoundCount(returnValue)).toBe(3)
  })

  it('missing fields count as zero and a missing library is null, not 0', () => {
    expect(gamesRead({ library: { imported: 4 } })).toBe(4)
    expect(gamesRead(null)).toBeNull()
    expect(gamesRead({})).toBeNull()
    expect(gamesRead('texto')).toBeNull()
    expect(notFoundCount({ library: { imported: 1 } })).toBeNull()
  })

  it('ignores values that are not numbers', () => {
    expect(
      gamesRead({ library: { imported: '10', updated: NaN, skipped: 2 } })
    ).toBe(2)
  })
})

describe('accounts', () => {
  it('lists the display names and the errors', () => {
    const returnValue = {
      accounts: [
        { displayName: 'Ada' },
        { displayName: 'Bob', error: 'Limite' },
        { error: '' }
      ]
    }
    expect(accountNames(returnValue)).toBe('Ada, Bob')
    expect(accountErrors(returnValue)).toEqual(['Limite'])
  })

  it('no accounts is null and no errors', () => {
    expect(accountNames({})).toBeNull()
    expect(accountNames(null)).toBeNull()
    expect(accountErrors(undefined)).toEqual([])
    expect(accountErrors({ accounts: 'x' })).toEqual([])
  })
})

describe('time helpers', () => {
  it('orders by finish, then start, then creation', () => {
    expect(sortKeyOf(record())).toBe(5_000)
    expect(sortKeyOf(record({ finishedOn: null }))).toBe(2_000)
    expect(sortKeyOf(record({ finishedOn: null, processedOn: null }))).toBe(
      1_000
    )
  })

  it('duration needs both ends and is never negative', () => {
    expect(durationOf(record())).toBe(3_000)
    expect(durationOf(record({ finishedOn: null }))).toBeNull()
    expect(durationOf(record({ processedOn: null }))).toBeNull()
    expect(durationOf(record({ processedOn: 9_000, finishedOn: 5_000 }))).toBe(
      0
    )
  })
})

describe('reasonOf', () => {
  it('a failed job explains itself with the failure reason', () => {
    expect(
      reasonOf(record({ state: 'failed', failedReason: 'Perfil privado' }))
    ).toBe('Perfil privado')
    expect(reasonOf(record({ state: 'failed', failedReason: null }))).toBeNull()
  })

  it('a partial completion explains itself with the first account error', () => {
    expect(
      reasonOf(
        record({
          returnValue: { accounts: [{ error: 'Limite' }, { error: 'Outro' }] }
        })
      )
    ).toBe('Limite')
  })

  it('a running or queued job has no reason', () => {
    expect(reasonOf(record({ state: 'active' }))).toBeNull()
    expect(reasonOf(record({ state: 'waiting' }))).toBeNull()
  })
})
