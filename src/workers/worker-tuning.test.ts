import { describe, expect, it } from 'vitest'
import { IMPORT_WORKER_TUNING } from './worker-tuning'

describe('IMPORT_WORKER_TUNING', () => {
  it('waits at least a minute on an empty queue', () => {
    expect(IMPORT_WORKER_TUNING.drainDelay).toBeGreaterThanOrEqual(60)
  })

  it('checks stalled jobs no more often than every five minutes', () => {
    expect(IMPORT_WORKER_TUNING.stalledInterval).toBeGreaterThanOrEqual(
      5 * 60 * 1000
    )
  })
})
