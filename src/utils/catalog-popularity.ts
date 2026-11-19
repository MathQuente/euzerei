export const MIN_TOTAL_RATING_COUNT = 10
export const MIN_HYPES = 5

export function isPopular(
  totalRatingCount: number | null | undefined,
  hypes: number | null | undefined
): boolean {
  return (
    (totalRatingCount ?? 0) >= MIN_TOTAL_RATING_COUNT ||
    (hypes ?? 0) >= MIN_HYPES
  )
}
