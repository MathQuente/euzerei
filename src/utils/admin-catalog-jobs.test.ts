import { describe, it, expect } from 'vitest'
import { CATALOG_JOBS } from './admin-catalog-jobs'
import { BACKFILL_ACTIONS } from './audit-actions'

const counts = { modesUnchecked: 4, noSlug: 5, hypesNull: 6 }

describe('CATALOG_JOBS', () => {
  it('every audit action of a backfill belongs to exactly one task', () => {
    const actions = CATALOG_JOBS.flatMap(job =>
      job.action ? [job.action] : []
    )

    expect([...actions].sort()).toEqual([...BACKFILL_ACTIONS].sort())
  })

  it('only the three tasks whose rows can be counted without IGDB have a count', () => {
    const counted = CATALOG_JOBS.filter(job => job.pending(counts) !== null)

    expect(counted.map(job => [job.key, job.pending(counts)])).toEqual([
      ['modes', 4],
      ['slugs', 5],
      ['hypes', 6]
    ])
  })

  it('the sync has no audit action', () => {
    expect(CATALOG_JOBS.find(job => job.key === 'sync')?.action).toBeNull()
  })

  it('every script exists in package.json', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const scripts = JSON.parse(
      readFileSync(resolve(__dirname, '../../package.json'), 'utf8')
    ).scripts as Record<string, string>

    for (const job of CATALOG_JOBS) {
      expect(scripts[job.script], job.script).toBeDefined()
    }
  })
})
