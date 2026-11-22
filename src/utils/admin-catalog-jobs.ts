import { BACKFILL_ACTIONS, SYNC_POPULAR_ACTION } from './audit-actions'

export interface CatalogPendingCounts {
  modesUnchecked: number
  noSlug: number
  hypesNull: number
}

export interface CatalogJobDefinition {
  key: string
  title: string
  script: string
  /** Nome do arquivo em src/scripts (sem extensão). */
  file: string
  /** Argumentos da simulação (nada é gravado); null quando o job não tem simulação. */
  dryArgs: readonly string[] | null
  /** Argumentos para gravar de verdade. Cada script tem o seu padrão, então o painel manda sempre explícito. */
  applyArgs: readonly string[]
  /** O script grava um arquivo de backup no diretório atual ao rodar de verdade. */
  writesBackup: boolean
  action: (typeof BACKFILL_ACTIONS)[number] | typeof SYNC_POPULAR_ACTION
  pending: (counts: CatalogPendingCounts) => number | null
}

export const CATALOG_JOBS: readonly CatalogJobDefinition[] = [
  {
    key: 'covers',
    title: 'Capas',
    script: 'backfill:cover-urls',
    file: 'backfill-cover-urls',
    dryArgs: ['--dry-run'],
    applyArgs: [],
    writesBackup: true,
    action: BACKFILL_ACTIONS[0],
    pending: () => null
  },
  {
    key: 'endless',
    title: 'Jogos sem fim (endless)',
    script: 'backfill:endless',
    file: 'backfill-endless',
    dryArgs: [],
    applyArgs: ['--apply'],
    writesBackup: false,
    action: BACKFILL_ACTIONS[1],
    pending: () => null
  },
  {
    key: 'modes',
    title: 'Modos de jogo',
    script: 'backfill:game-modes',
    file: 'backfill-game-modes',
    dryArgs: ['--dry-run'],
    applyArgs: [],
    writesBackup: false,
    action: BACKFILL_ACTIONS[2],
    pending: counts => counts.modesUnchecked
  },
  {
    key: 'precision',
    title: 'Precisão da data de lançamento',
    script: 'backfill:release-precision',
    file: 'backfill-release-precision',
    dryArgs: [],
    applyArgs: ['--apply'],
    writesBackup: true,
    action: BACKFILL_ACTIONS[3],
    pending: () => null
  },
  {
    key: 'slugs',
    title: 'Slugs',
    script: 'backfill:slugs',
    file: 'backfill-slugs',
    dryArgs: [],
    applyArgs: ['--apply'],
    writesBackup: false,
    action: BACKFILL_ACTIONS[4],
    pending: counts => counts.noSlug
  },
  {
    key: 'hypes',
    title: 'Hypes e notas',
    script: 'backfill:hypes',
    file: 'backfill-hypes',
    dryArgs: ['--dry-run'],
    applyArgs: [],
    writesBackup: false,
    action: BACKFILL_ACTIONS[5],
    pending: counts => counts.hypesNull
  },
  {
    key: 'sync',
    title: 'Sync dos populares',
    script: 'sync:popular',
    file: 'sync-popular',
    dryArgs: ['--dry-run'],
    applyArgs: [],
    writesBackup: false,
    action: SYNC_POPULAR_ACTION,
    pending: () => null
  }
]
