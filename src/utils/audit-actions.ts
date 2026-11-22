export const SUSPEND_ACCOUNT_ACTION = 'Suspendeu a conta'
export const REACTIVATE_ACCOUNT_ACTION = 'Reativou a conta'
export const DELETE_ACCOUNT_ACTION = 'Excluiu a conta'

export const RELEASE_BLOCK_ACTION = 'Liberou um bloqueio de login'
export const END_SESSION_ACTION = 'Encerrou uma sessão'
export const RETRY_JOB_ACTION = 'Repetiu um job de importação'
export const DISCARD_JOB_ACTION = 'Descartou um job de importação'
export const PAUSE_QUEUE_ACTION = 'Pausou a fila de importação'
export const RESUME_QUEUE_ACTION = 'Retomou a fila de importação'

export const SYNC_POPULAR_ACTION = 'Rodou o sync dos populares'
export const RESEND_VERIFICATION_ACTION = 'Reenviou a verificação de e-mail'
export const PASSWORD_RESET_ACTION = 'Enviou a redefinição de senha'

export const BACKFILL_ACTIONS = [
  'Rodou o backfill de capas',
  'Rodou o backfill de tempo de jogo',
  'Rodou o backfill de modos de jogo',
  'Rodou o backfill da precisão da data de lançamento',
  'Rodou o backfill de slugs',
  'Rodou o backfill de hypes e notas'
] as const
