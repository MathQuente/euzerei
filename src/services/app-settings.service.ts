import { AppSettingsRepository } from '../repositories/app-settings.repository'
import {
  APP_SETTING_DEFAULTS,
  APP_SETTING_KEYS,
  APP_SETTING_SCHEMAS,
  UpdateAppSettingsBodySchema,
  type AppSettingKey,
  type AppSettings
} from '../schemas/app-settings.schema'
import { AuditService } from './audit.service'

export class AppSettingsService {
  constructor(
    private appSettingsRepository: AppSettingsRepository = new AppSettingsRepository(),
    private auditService: AuditService = new AuditService()
  ) {}

  async getAll(): Promise<AppSettings> {
    const rows = await this.appSettingsRepository.findAll()
    const stored = new Map(rows.map(row => [row.key, row.value]))
    const settings = { ...APP_SETTING_DEFAULTS } as Record<string, unknown>

    for (const key of APP_SETTING_KEYS) {
      if (!stored.has(key)) continue
      const parsed = APP_SETTING_SCHEMAS[key].safeParse(stored.get(key))
      if (parsed.success) settings[key] = parsed.data
    }

    return settings as AppSettings
  }

  async update(actorId: string, input: unknown, ip: string) {
    const changes = UpdateAppSettingsBodySchema.parse(input)
    const keys = Object.keys(changes) as AppSettingKey[]

    await this.appSettingsRepository.upsertMany(changes, actorId)
    await this.auditService.record({
      actorId,
      action: 'Alterou configurações',
      area: 'SYSTEM',
      detail: keys.join(', '),
      ip
    })

    return this.getAll()
  }
}
