import { AppSettingsRepository } from '../repositories/app-settings.repository'
import {
  APP_SETTING_DEFAULTS,
  APP_SETTING_SCHEMAS,
  type AppSettingKey,
  type AppSettings
} from '../schemas/app-settings.schema'

export const APP_SETTINGS_CACHE_MS = 30_000

type Entry = { value: unknown; expiresAt: number }

/**
 * Lê UMA chave de `app_settings` para o app obedecer a ela. Cache curto em memória (30 s), uma só leitura
 * para requisições simultâneas, valor inválido vira o padrão da constante (como `AppSettingsService.read`) e
 * uma falha de leitura devolve o padrão SEM guardar em cache, então a próxima requisição tenta de novo.
 */
export class AppSettingsReader {
  private cache = new Map<AppSettingKey, Entry>()
  private inflight = new Map<AppSettingKey, Promise<unknown>>()
  private generation = 0

  constructor(
    private repository: AppSettingsRepository = new AppSettingsRepository(),
    private now: () => number = Date.now
  ) {}

  async get<K extends AppSettingKey>(key: K): Promise<AppSettings[K]> {
    const hit = this.cache.get(key)
    if (hit && hit.expiresAt > this.now()) return hit.value as AppSettings[K]

    let pending = this.inflight.get(key)
    if (!pending) {
      const started: Promise<unknown> = this.load(key).finally(() => {
        if (this.inflight.get(key) === started) this.inflight.delete(key)
      })
      pending = started
      this.inflight.set(key, started)
    }
    return pending as Promise<AppSettings[K]>
  }

  invalidate() {
    this.generation++
    this.cache.clear()
    this.inflight.clear()
  }

  private async load<K extends AppSettingKey>(key: K): Promise<AppSettings[K]> {
    const generation = this.generation
    try {
      const row = await this.repository.findByKey(key)
      let value: unknown = APP_SETTING_DEFAULTS[key]
      if (row) {
        const parsed = APP_SETTING_SCHEMAS[key].safeParse(row.value)
        if (parsed.success) value = parsed.data
      }
      // Uma mudança durante a leitura invalida o resultado: não guarda o valor antigo.
      if (generation === this.generation) {
        this.cache.set(key, {
          value,
          expiresAt: this.now() + APP_SETTINGS_CACHE_MS
        })
      }
      return value as AppSettings[K]
    } catch (error) {
      console.warn(
        `[AppSettings] leitura de "${key}" falhou, usando o padrão`,
        error
      )
      return APP_SETTING_DEFAULTS[key]
    }
  }
}

let shared: AppSettingsReader | undefined

export function appSettingsReader(): AppSettingsReader {
  shared ??= new AppSettingsReader()
  return shared
}

export function invalidateAppSettingsCache() {
  shared?.invalidate()
}
