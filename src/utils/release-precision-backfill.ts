import {
  ReleasePrecision,
  asReleasePrecision,
  releaseDatePrecision
} from './release-precision'

export interface PrecisionCacheRow {
  igdbId: number
  releaseDate: number | null
  releaseDatePrecision: string | null
}

export interface IgdbReleaseInfo {
  /** `first_release_date` já normalizado como no cache (`toCacheReleaseDate`). */
  releaseDate: number | null
  releaseDates?: { date?: number; date_format?: number }[]
}

export type PrecisionDecision =
  | { kind: 'change'; next: ReleasePrecision }
  | { kind: 'same' }
  /** A linha não tem data: nada a dizer sobre a precisão. */
  | { kind: 'no_date' }
  /** A IGDB não devolveu o jogo. */
  | { kind: 'not_found' }
  /** A data do cache já não é a da IGDB: a precisão seria de outra data. */
  | { kind: 'stale_date' }
  /** A IGDB não traz `date_format` para esse jogo. */
  | { kind: 'unknown' }

/**
 * Decide a precisão de uma linha do cache. Só vale para a data que o cache
 * tem: se a IGDB já mudou a data, a linha fica como está (o backfill de datas
 * a corrige e esta decisão se repete depois).
 */
export function decidePrecision(
  row: PrecisionCacheRow,
  igdb: IgdbReleaseInfo | undefined
): PrecisionDecision {
  if (row.releaseDate === null) return { kind: 'no_date' }
  if (!igdb) return { kind: 'not_found' }
  if (igdb.releaseDate !== row.releaseDate) return { kind: 'stale_date' }

  const next = releaseDatePrecision(row.releaseDate, igdb.releaseDates)
  if (next === undefined) return { kind: 'unknown' }
  return next === row.releaseDatePrecision
    ? { kind: 'same' }
    : { kind: 'change', next }
}

export interface PrecisionBackupRow {
  igdbId: number
  previous: string | null
  next: string | null
}

const HEADER = 'igdb_id,precisao_antiga,precisao_nova'

export function formatPrecisionBackup(rows: PrecisionBackupRow[]): string {
  return [
    HEADER,
    ...rows.map(r => `${r.igdbId},${r.previous ?? ''},${r.next ?? ''}`)
  ].join('\n')
}

export function parsePrecisionBackup(text: string): PrecisionBackupRow[] {
  const [header, ...lines] = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '')
  if (header !== HEADER) throw new Error('Not a release precision backup file')
  const field = (value: string | undefined, line: string) => {
    if (value === undefined || value === '') return null
    if (asReleasePrecision(value) === undefined) {
      throw new Error(`Invalid backup line: "${line}"`)
    }
    return value
  }
  return lines.map(line => {
    const [id, previous, next, ...rest] = line.split(',')
    const igdbId = Number(id)
    if (!Number.isInteger(igdbId) || next === undefined || rest.length > 0) {
      throw new Error(`Invalid backup line: "${line}"`)
    }
    return {
      igdbId,
      previous: field(previous, line),
      next: field(next, line)
    }
  })
}
