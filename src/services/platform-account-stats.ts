import { UserRepository } from '../repositories/users.repository'

export interface AccountStats {
  achievementsEarned?: number | null
  gamerscore?: number | null
  platinumTrophies?: number | null
}

// Os totais são um extra do perfil: se não der para gravar, a importação
// (que já fez o trabalho principal) não pode falhar por causa deles.
export async function saveAccountStats(
  userRepository: UserRepository,
  accountId: string,
  stats: AccountStats,
  label: string
) {
  try {
    await userRepository.updateAccountStats(accountId, stats)
  } catch (error) {
    console.error(`[${label}] could not save account stats`, {
      accountId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
