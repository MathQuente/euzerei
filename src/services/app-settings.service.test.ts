import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ZodError } from 'zod'
import { AppSettingsService } from './app-settings.service'
import { APP_SETTING_DEFAULTS } from '../schemas/app-settings.schema'
import type { AppSettingsRepository } from '../repositories/app-settings.repository'
import type { AuditService } from './audit.service'

const repository = { findAll: vi.fn(), upsertMany: vi.fn() }
const audit = { record: vi.fn() }

const service = new AppSettingsService(
  repository as unknown as AppSettingsRepository,
  audit as unknown as AuditService
)

beforeEach(() => {
  repository.findAll.mockReset().mockResolvedValue([])
  repository.upsertMany.mockReset().mockResolvedValue([])
  audit.record.mockReset().mockResolvedValue(undefined)
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
  it('validates, stores the changes with the actor and audits the keys', async () => {
    await service.update(
      'admin-1',
      { signupsOpen: false, importAutoRetry: false },
      '1.2.3.4'
    )

    expect(repository.upsertMany).toHaveBeenCalledWith(
      { signupsOpen: false, importAutoRetry: false },
      'admin-1'
    )
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'admin-1',
      action: 'Alterou configurações',
      area: 'SYSTEM',
      detail: 'signupsOpen, importAutoRetry',
      ip: '1.2.3.4'
    })
  })

  it('stores nothing and audits nothing for an invalid value', async () => {
    await expect(
      service.update('admin-1', { importsPerUserPerHour: 0 }, '1.2.3.4')
    ).rejects.toBeInstanceOf(ZodError)

    expect(repository.upsertMany).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
  })

  it('refuses an unknown key', async () => {
    await expect(
      service.update('admin-1', { bannerText: 'oi' }, '1.2.3.4')
    ).rejects.toBeInstanceOf(ZodError)
  })
})
