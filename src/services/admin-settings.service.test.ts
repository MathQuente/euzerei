import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ZodError } from 'zod'
import { AdminSettingsService } from './admin-settings.service'
import { APP_SETTING_DEFAULTS } from '../schemas/app-settings.schema'
import { TERMS_VERSION } from '../utils/terms'
import type { AppSettingsService } from './app-settings.service'
import type { AdminUsersRepository } from '../repositories/admin-users.repository'

const appSettings = { getAll: vi.fn(), update: vi.fn() }
const users = { countWithoutCurrentTerms: vi.fn() }
const service = new AdminSettingsService(
  appSettings as unknown as AppSettingsService,
  users as unknown as AdminUsersRepository
)

beforeEach(() => {
  appSettings.getAll.mockReset().mockResolvedValue({ ...APP_SETTING_DEFAULTS })
  appSettings.update
    .mockReset()
    .mockResolvedValue({ settings: APP_SETTING_DEFAULTS, changed: [] })
  users.countWithoutCurrentTerms.mockReset().mockResolvedValue(88)
})

describe('AdminSettingsService.get', () => {
  it('answers the settings and how many users have not accepted the current terms', async () => {
    const result = await service.get()

    expect(result.termsPending).toBe(88)
    expect(result.settings).toMatchObject({
      signupsOpen: true,
      importsPerUserPerHour: 5
    })
  })

  it('shows the terms version of the code, never a stored one', async () => {
    appSettings.getAll.mockResolvedValue({
      ...APP_SETTING_DEFAULTS,
      termsVersion: 'v4'
    })

    const result = await service.get()

    expect(result.settings.termsVersion).toBe(TERMS_VERSION)
  })
})

describe('AdminSettingsService.update', () => {
  it('passes the actor, the validated changes and the ip, then answers the fresh state', async () => {
    appSettings.getAll.mockResolvedValue({
      ...APP_SETTING_DEFAULTS,
      signupsOpen: false
    })

    appSettings.update.mockResolvedValue({
      settings: { ...APP_SETTING_DEFAULTS, signupsOpen: false },
      changed: ['signupsOpen']
    })

    const result = await service.update(
      'admin-1',
      { signupsOpen: false },
      '1.2.3.4'
    )

    expect(appSettings.update).toHaveBeenCalledWith(
      'admin-1',
      { signupsOpen: false },
      '1.2.3.4'
    )
    expect(result.settings.signupsOpen).toBe(false)
    expect(result.termsPending).toBe(88)
    expect(result.changed).toEqual(['signupsOpen'])
  })

  it('says nothing changed when the values were already saved', async () => {
    const result = await service.update('admin-1', { signupsOpen: true }, 'ip')

    expect(result.changed).toEqual([])
  })

  it.each([
    { body: { termsVersion: 'v4' }, label: 'the terms version is read-only' },
    { body: {}, label: 'an empty body' },
    { body: { bannerText: 'oi' }, label: 'an unknown key' },
    { body: { importsPerUserPerHour: 0 }, label: 'a value below the range' },
    {
      body: { importJobTimeoutSeconds: 901 },
      label: 'a value above the range'
    },
    { body: { popularSyncTime: '25:00' }, label: 'an invalid time' },
    { body: { signupsOpen: 'yes' }, label: 'a wrong type' }
  ])('refuses $label without touching the settings', async ({ body }) => {
    await expect(service.update('admin-1', body, 'ip')).rejects.toBeInstanceOf(
      ZodError
    )

    expect(appSettings.update).not.toHaveBeenCalled()
  })
})
