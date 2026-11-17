import { describe, expect, it, vi } from 'vitest'
import { UserRepository } from '../repositories/users.repository'
import { saveAccountStats } from './platform-account-stats'

describe('saveAccountStats', () => {
  it('passes the totals to the repository', async () => {
    const updateAccountStats = vi.fn().mockResolvedValue({ id: 'a-1' })
    const repo = { updateAccountStats } as unknown as UserRepository

    await saveAccountStats(repo, 'a-1', { gamerscore: 100 }, 'Xbox')

    expect(updateAccountStats).toHaveBeenCalledWith('a-1', { gamerscore: 100 })
  })

  it('swallows a failure so the import is not lost', async () => {
    const repo = {
      updateAccountStats: vi.fn().mockRejectedValue(new Error('db down'))
    } as unknown as UserRepository
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(
      saveAccountStats(repo, 'a-1', { achievementsEarned: 3 }, 'Steam')
    ).resolves.toBeUndefined()
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })
})
