import type { Prisma } from '../database/prisma-client'
import { AppSettingsRepository } from '../repositories/app-settings.repository'
import { invalidateAppSettingsCache } from './app-settings-reader'
import {
  APP_SETTING_DEFAULTS,
  APP_SETTING_KEYS,
  APP_SETTING_SCHEMAS,
  UpdateAppSettingsBodySchema,
  type AppSettingKey,
  type AppSettings
} from '../schemas/app-settings.schema'

export const UPDATE_SETTINGS_ACTION = 'Alterou configurações'

export class AppSettingsService {
  constructor(
    private appSettingsRepository: AppSettingsRepository = new AppSettingsRepository()
  ) {}

  getAll(): Promise<AppSettings> {
    return this.read()
  }

  async update(
    actorId: string,
    input: unknown,
    ip: string
  ): Promise<{ settings: AppSettings; changed: AppSettingKey[] }> {
    const requested = UpdateAppSettingsBodySchema.parse(input)

    const result = await this.appSettingsRepository.runExclusive(async tx => {
      const current = await this.read(tx)
      const changed = (Object.keys(requested) as AppSettingKey[]).filter(
        key => requested[key] !== current[key]
      )

      if (changed.length === 0) return { settings: current, changed }

      const values = Object.fromEntries(
        changed.map(key => [key, requested[key]])
      )
      const detail = changed
        .map(
          key =>
            `${key}: ${JSON.stringify(current[key])} → ${JSON.stringify(requested[key])}`
        )
        .join(', ')

      await this.appSettingsRepository.saveWithAudit(tx, values, actorId, {
        action: UPDATE_SETTINGS_ACTION,
        area: 'SYSTEM',
        detail,
        ip
      })

      return { settings: await this.read(tx), changed }
    })

    // Depois do commit: a mudança vale na hora neste processo, sem esperar o cache de 30 s.
    if (result.changed.length > 0) invalidateAppSettingsCache()
    return result
  }

  private async read(client?: Prisma.TransactionClient): Promise<AppSettings> {
    const rows = await this.appSettingsRepository.findAll(client)
    const stored = new Map(rows.map(row => [row.key, row.value]))
    const settings = { ...APP_SETTING_DEFAULTS } as Record<string, unknown>

    for (const key of APP_SETTING_KEYS) {
      if (!stored.has(key)) continue
      const parsed = APP_SETTING_SCHEMAS[key].safeParse(stored.get(key))
      if (parsed.success) settings[key] = parsed.data
    }

    return settings as AppSettings
  }
}
