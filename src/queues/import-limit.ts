import { ImportRunsRepository } from '../repositories/import-runs.repository'
import {
  appSettingsReader,
  type AppSettingsReader
} from '../services/app-settings-reader'
import type { ImportStore } from '../utils/import-jobs'

export const IMPORT_LIMIT_WINDOW_MS = 60 * 60 * 1000

export type ImportLimitCheck =
  { blocked: false } | { blocked: true; until: number }

export interface ImportLimitScope {
  userId: string
  store: ImportStore
  limiter?: ImportLimiter
}

/**
 * Limite de importações por usuário e loja na última hora (`importsPerUserPerHour`). Conta as execuções
 * CONCLUÍDAS em `import_runs`; falhas não gastam o limite. Bloqueia quando já há N na janela e libera quando a
 * N-ésima mais recente sai dela (não a mais antiga: se o admin baixar o limite, a conta muda).
 * Um erro do banco sobe para quem chamou.
 */
export class ImportLimiter {
  constructor(
    private settings: Pick<AppSettingsReader, 'get'> = appSettingsReader(),
    private runs: Pick<
      ImportRunsRepository,
      'completedFinishesSince'
    > = new ImportRunsRepository()
  ) {}

  async check(
    userId: string,
    store: ImportStore,
    now: number = Date.now()
  ): Promise<ImportLimitCheck> {
    const limit = await this.settings.get('importsPerUserPerHour')
    const finishes = await this.runs.completedFinishesSince(
      userId,
      store,
      new Date(now - IMPORT_LIMIT_WINDOW_MS),
      limit
    )
    if (finishes.length < limit) return { blocked: false }
    return {
      blocked: true,
      until: finishes[limit - 1].getTime() + IMPORT_LIMIT_WINDOW_MS
    }
  }
}

let shared: ImportLimiter | undefined

export function defaultImportLimiter(): ImportLimiter {
  shared ??= new ImportLimiter()
  return shared
}
