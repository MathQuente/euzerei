export const PLAYED_STATUS_ID = 1
export const PAUSED_STATUS_ID = 2
export const PLAYING_STATUS_ID = 3
export const BACKLOG_STATUS_ID = 4
export const WISHLIST_STATUS_ID = 5
export const DROPPED_STATUS_ID = 6

/**
 * `droppedAt` guarda a última vez que o jogo entrou em Larguei. Só é gravada na
 * entrada (de outro status, ou ao criar já largado); nunca é apagada, e quem
 * lê só deve usá-la enquanto o status for Larguei. `undefined` = não mexer.
 */
export function droppedAtFor(
  nextStatusId: number,
  currentStatusId: number | null,
  now: Date = new Date()
): Date | undefined {
  if (nextStatusId !== DROPPED_STATUS_ID) return undefined
  if (currentStatusId === DROPPED_STATUS_ID) return undefined
  return now
}

export const ENDLESS_COMPLETIONS_MESSAGE =
  'Jogo infinito não conta vezes zerado.'

export const STATUS_NAME_BY_ID: Record<number, string> = {
  [PLAYED_STATUS_ID]: 'PLAYED',
  [PAUSED_STATUS_ID]: 'PAUSED',
  [PLAYING_STATUS_ID]: 'PLAYING',
  [BACKLOG_STATUS_ID]: 'BACKLOG',
  [WISHLIST_STATUS_ID]: 'WISHLIST',
  [DROPPED_STATUS_ID]: 'DROPPED'
}

export const CLEAR_HUNDRED_PERCENT = {
  hundredPercent: false,
  hundredPercentLocked: false
} as const

export const MAX_FAVORITE_GAMES = 4
export const ROULETTE_MAX_GAMES = 24
