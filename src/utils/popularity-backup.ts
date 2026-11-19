export interface PopularityValues {
  hypes: number
  totalRatingCount: number
}

export interface PreviousPopularity {
  hypes: number | null
  totalRatingCount: number | null
}

export type PopularityBackupRow =
  | { igdbId: number; inserted: true }
  | {
      igdbId: number
      previous: PreviousPopularity
      next: PopularityValues
    }

export function isInsertedRow(
  row: PopularityBackupRow
): row is { igdbId: number; inserted: true } {
  return 'inserted' in row
}

export function formatPopularityBackup(rows: PopularityBackupRow[]): string {
  return rows.map(r => JSON.stringify(r)).join('\n')
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isValues(value: unknown): value is PopularityValues {
  const v = value as Partial<PopularityValues> | null
  return (
    typeof v === 'object' &&
    v !== null &&
    isCount(v.hypes) &&
    isCount(v.totalRatingCount)
  )
}

function isPrevious(value: unknown): value is PreviousPopularity {
  const v = value as Partial<PreviousPopularity> | null
  return (
    typeof v === 'object' &&
    v !== null &&
    (v.hypes === null || isCount(v.hypes)) &&
    (v.totalRatingCount === null || isCount(v.totalRatingCount))
  )
}

export function parsePopularityBackup(text: string): PopularityBackupRow[] {
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      let value: Record<string, unknown>
      try {
        value = JSON.parse(line)
      } catch {
        throw new Error(`Invalid backup line: "${line}"`)
      }
      if (typeof value !== 'object' || value === null) {
        throw new Error(`Invalid backup line: "${line}"`)
      }
      const igdbId = value.igdbId
      if (
        typeof igdbId !== 'number' ||
        !Number.isInteger(igdbId) ||
        igdbId <= 0
      ) {
        throw new Error(`Invalid backup line: "${line}"`)
      }
      if (value.inserted === true && Object.keys(value).length === 2) {
        return { igdbId, inserted: true as const }
      }
      if (isPrevious(value.previous) && isValues(value.next)) {
        return { igdbId, previous: value.previous, next: value.next }
      }
      throw new Error(`Invalid backup line: "${line}"`)
    })
}
