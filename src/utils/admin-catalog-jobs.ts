import { BACKFILL_ACTIONS } from './audit-actions'

export interface CatalogPendingCounts {
  modesUnchecked: number
  noSlug: number
  hypesNull: number
}

export interface CatalogJobDefinition {
  key: string
  title: string
  script: string
  action: (typeof BACKFILL_ACTIONS)[number] | null
  pending: (counts: CatalogPendingCounts) => number | null
}

export const CATALOG_JOBS: readonly CatalogJobDefinition[] = [
  {
    key: 'covers',
    title: 'Capas',
    script: 'backfill:cover-urls',
    action: BACKFILL_ACTIONS[0],
    pending: () => null
  },
  {
    key: 'endless',
    title: 'Jogos sem fim (endless)',
    script: 'backfill:endless',
    action: BACKFILL_ACTIONS[1],
    pending: () => null
  },
  {
    key: 'modes',
    title: 'Modos de jogo',
    script: 'backfill:game-modes',
    action: BACKFILL_ACTIONS[2],
    pending: counts => counts.modesUnchecked
  },
  {
    key: 'precision',
    title: 'Precisão da data de lançamento',
    script: 'backfill:release-precision',
    action: BACKFILL_ACTIONS[3],
    pending: () => null
  },
  {
    key: 'slugs',
    title: 'Slugs',
    script: 'backfill:slugs',
    action: BACKFILL_ACTIONS[4],
    pending: counts => counts.noSlug
  },
  {
    key: 'hypes',
    title: 'Hypes e notas',
    script: 'backfill:hypes',
    action: BACKFILL_ACTIONS[5],
    pending: counts => counts.hypesNull
  },
  {
    key: 'sync',
    title: 'Sync dos populares',
    script: 'sync:popular',
    action: null,
    pending: () => null
  }
]
