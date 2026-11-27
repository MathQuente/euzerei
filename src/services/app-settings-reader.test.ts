import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppSettingsReader, APP_SETTINGS_CACHE_MS } from './app-settings-reader'
import { APP_SETTING_DEFAULTS } from '../schemas/app-settings.schema'
import type { AppSettingsRepository } from '../repositories/app-settings.repository'

const repository = { findByKey: vi.fn() }
let clock = 0
let reader: AppSettingsReader

beforeEach(() => {
  clock = 1_000_000
  repository.findByKey.mockReset().mockResolvedValue(null)
  reader = new AppSettingsReader(
    repository as unknown as AppSettingsRepository,
    () => clock
  )
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('AppSettingsReader', () => {
  it('uses the constant default when nothing is stored', async () => {
    await expect(reader.get('importsPerUserPerHour')).resolves.toBe(
      APP_SETTING_DEFAULTS.importsPerUserPerHour
    )
  })

  it('returns the stored value', async () => {
    repository.findByKey.mockResolvedValue({
      key: 'importsPerUserPerHour',
      value: 2
    })
    await expect(reader.get('importsPerUserPerHour')).resolves.toBe(2)
    expect(repository.findByKey).toHaveBeenCalledWith('importsPerUserPerHour')
  })

  it.each([0, 61, 'x', null, 2.5])(
    'falls back to the default for the invalid value %s',
    async value => {
      repository.findByKey.mockResolvedValue({
        key: 'importsPerUserPerHour',
        value
      })
      await expect(reader.get('importsPerUserPerHour')).resolves.toBe(5)
    }
  )

  it('caches for 30 s and reads again after that', async () => {
    repository.findByKey.mockResolvedValue({
      key: 'importsPerUserPerHour',
      value: 2
    })
    await reader.get('importsPerUserPerHour')
    clock += APP_SETTINGS_CACHE_MS - 1
    await reader.get('importsPerUserPerHour')
    expect(repository.findByKey).toHaveBeenCalledTimes(1)

    repository.findByKey.mockResolvedValue({
      key: 'importsPerUserPerHour',
      value: 3
    })
    clock += 2
    await expect(reader.get('importsPerUserPerHour')).resolves.toBe(3)
    expect(repository.findByKey).toHaveBeenCalledTimes(2)
  })

  it('shares one read between simultaneous requests', async () => {
    await Promise.all([
      reader.get('importsPerUserPerHour'),
      reader.get('importsPerUserPerHour'),
      reader.get('importsPerUserPerHour')
    ])
    expect(repository.findByKey).toHaveBeenCalledTimes(1)
  })

  it('uses the default on a read failure and does not cache it', async () => {
    repository.findByKey.mockRejectedValueOnce(new Error('db down'))
    await expect(reader.get('importsPerUserPerHour')).resolves.toBe(5)

    repository.findByKey.mockResolvedValue({
      key: 'importsPerUserPerHour',
      value: 2
    })
    await expect(reader.get('importsPerUserPerHour')).resolves.toBe(2)
  })

  it('invalidate makes the next read see the new value at once', async () => {
    repository.findByKey.mockResolvedValue({
      key: 'importsPerUserPerHour',
      value: 2
    })
    await reader.get('importsPerUserPerHour')
    repository.findByKey.mockResolvedValue({
      key: 'importsPerUserPerHour',
      value: 4
    })
    reader.invalidate()
    await expect(reader.get('importsPerUserPerHour')).resolves.toBe(4)
  })

  it('does not cache a read that was started before an invalidation', async () => {
    let release: (v: unknown) => void = () => {}
    repository.findByKey.mockReturnValueOnce(
      new Promise(resolve => (release = resolve))
    )
    const stale = reader.get('importsPerUserPerHour')
    reader.invalidate()
    release({ key: 'importsPerUserPerHour', value: 2 })
    await stale

    repository.findByKey.mockResolvedValue({
      key: 'importsPerUserPerHour',
      value: 4
    })
    await expect(reader.get('importsPerUserPerHour')).resolves.toBe(4)
  })
})
