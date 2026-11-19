import { isPopular } from './catalog-popularity'

export type PopularityChangeKind =
  'inserir' | 'igual' | 'entra_no_filtro' | 'sai_do_filtro' | 'so_valor'

export interface Popularity {
  hypes: number | null
  totalRatingCount: number | null
}

export interface PopularityClassification {
  kind: PopularityChangeKind
  writes: boolean
  next: { hypes: number; totalRatingCount: number }
}

export function classifyPopularityChange(input: {
  cache: Popularity | null
  igdb: { hypes: number; totalRatingCount: number }
}): PopularityClassification {
  const { cache, igdb } = input
  const next = { hypes: igdb.hypes, totalRatingCount: igdb.totalRatingCount }

  if (cache === null) return { kind: 'inserir', writes: true, next }

  const previous = {
    hypes: cache.hypes ?? 0,
    totalRatingCount: cache.totalRatingCount ?? 0
  }

  if (
    previous.hypes === next.hypes &&
    previous.totalRatingCount === next.totalRatingCount
  ) {
    return { kind: 'igual', writes: false, next }
  }

  const wasPopular = isPopular(previous.totalRatingCount, previous.hypes)
  const isNowPopular = isPopular(next.totalRatingCount, next.hypes)
  const kind: PopularityChangeKind =
    wasPopular === isNowPopular
      ? 'so_valor'
      : isNowPopular
        ? 'entra_no_filtro'
        : 'sai_do_filtro'

  return { kind, writes: true, next }
}
