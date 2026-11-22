export const SUSPEND_ACCOUNT_ACTION = 'Suspendeu a conta'

export const RELEASE_BLOCK_ACTION = 'Liberou um bloqueio de login'
export const END_SESSION_ACTION = 'Encerrou uma sessão'
export const PAUSE_QUEUE_ACTION = 'Pausou a fila de importação'
export const RESUME_QUEUE_ACTION = 'Retomou a fila de importação'

export const BACKFILL_ACTIONS = [
  'Rodou o backfill de capas',
  'Rodou o backfill de tempo de jogo',
  'Rodou o backfill de modos de jogo',
  'Rodou o backfill da precisão da data de lançamento',
  'Rodou o backfill de slugs',
  'Rodou o backfill de hypes e notas'
] as const
