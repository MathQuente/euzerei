import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ZodError } from 'zod'
import { AppSettingsService } from './app-settings.service'
import { APP_SETTING_DEFAULTS } from '../schemas/app-settings.schema'
import type { AppSettingsRepository } from '../repositories/app-settings.repository'

const tx = { id: 'tx' }
const repository = {
  findAll: vi.fn(),
  runExclusive: vi.fn(),
  saveWithAudit: vi.fn()
}

const service = new AppSettingsService(
  repository as unknown as AppSettingsRepository
)

beforeEach(() => {
  repository.findAll.mockReset().mockResolvedValue([])
  repository.runExclusive
    .mockReset()
    .mockImplementation(async (work: (t: unknown) => unknown) => work(tx))
  repository.saveWithAudit.mockReset().mockResolvedValue(undefined)
})

describe('AppSettingsService.getAll', () => {
  it('returns the defaults when nothing is stored', async () => {
    await expect(service.getAll()).resolves.toEqual(APP_SETTING_DEFAULTS)
  })

  it('overlays the stored values on the defaults', async () => {
    repository.findAll.mockResolvedValue([
      { key: 'signupsOpen', value: false },
      { key: 'popularSyncTime', value: '04:30' }
    ])

    const settings = await service.getAll()

    expect(settings.signupsOpen).toBe(false)
    expect(settings.popularSyncTime).toBe('04:30')
    expect(settings.importsPerUserPerHour).toBe(
      APP_SETTING_DEFAULTS.importsPerUserPerHour
    )
  })

  it('ignores a stored value that no longer passes its schema, and unknown keys', async () => {
    repository.findAll.mockResolvedValue([
      { key: 'importsPerUserPerHour', value: 9999 },
      { key: 'legacyFlag', value: true }
    ])

    const settings = await service.getAll()

    expect(settings.importsPerUserPerHour).toBe(
      APP_SETTING_DEFAULTS.importsPerUserPerHour
    )
    expect(settings).not.toHaveProperty('legacyFlag')
  })
})

describe('AppSettingsService.update', () => {
  it('stores only what changed, with the actor, and audits before and after in the same write', async () => {
    const result = await service.update(
      'admin-1',
      { signupsOpen: false, importAutoRetry: false, popularSyncTime: '03:00' },
      '1.2.3.4'
    )

    expect(repository.saveWithAudit).toHaveBeenCalledTimes(1)
    expect(repository.saveWithAudit).toHaveBeenCalledWith(
      tx,
      { signupsOpen: false, importAutoRetry: false },
      'admin-1',
      {
        action: 'Alterou configurações',
        area: 'SYSTEM',
        detail: 'signupsOpen: true → false, importAutoRetry: true → false',
        ip: '1.2.3.4'
      }
    )
    expect(result.changed).toEqual(['signupsOpen', 'importAutoRetry'])
  })

  it('reads, compares and writes inside one exclusive transaction', async () => {
    await service.update('admin-1', { signupsOpen: false }, 'ip')

    expect(repository.runExclusive).toHaveBeenCalledTimes(1)
    expect(repository.findAll).toHaveBeenCalledWith(tx)
    expect(repository.saveWithAudit.mock.calls[0][0]).toBe(tx)
  })

  it('compares against the stored value, not only the default', async () => {
    repository.findAll.mockResolvedValue([
      { key: 'importsPerUserPerHour', value: 9 }
    ])

    await service.update('admin-1', { importsPerUserPerHour: 5 }, 'ip')

    expect(repository.saveWithAudit).toHaveBeenCalledWith(
      tx,
      { importsPerUserPerHour: 5 },
      'admin-1',
      expect.objectContaining({ detail: 'importsPerUserPerHour: 9 → 5' })
    )
  })

  it('quotes strings in the audit detail', async () => {
    await service.update('admin-1', { popularSyncTime: '04:30' }, 'ip')

    expect(repository.saveWithAudit).toHaveBeenCalledWith(
      tx,
      { popularSyncTime: '04:30' },
      'admin-1',
      expect.objectContaining({
        detail: 'popularSyncTime: "03:00" → "04:30"'
      })
    )
  })

  it('writes nothing and audits nothing when every value is already the current one, and says nothing changed', async () => {
    const result = await service.update(
      'admin-1',
      { signupsOpen: true, importsPerUserPerHour: 5 },
      'ip'
    )

    expect(repository.saveWithAudit).not.toHaveBeenCalled()
    expect(result.settings).toEqual(APP_SETTING_DEFAULTS)
    expect(result.changed).toEqual([])
  })

  it('stores nothing, and does not even open the transaction, for an invalid value', async () => {
    await expect(
      service.update('admin-1', { importsPerUserPerHour: 0 }, 'ip')
    ).rejects.toBeInstanceOf(ZodError)

    expect(repository.runExclusive).not.toHaveBeenCalled()
    expect(repository.saveWithAudit).not.toHaveBeenCalled()
  })

  it('refuses an unknown key', async () => {
    await expect(
      service.update('admin-1', { bannerText: 'oi' }, 'ip')
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('a failed write propagates, so no change is reported as saved', async () => {
    repository.saveWithAudit.mockRejectedValue(new Error('db down'))

    await expect(
      service.update('admin-1', { signupsOpen: false }, 'ip')
    ).rejects.toThrow('db down')
  })
})
