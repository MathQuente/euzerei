import type { LoginOutcome, LoginSource } from '../database/prisma-client'
import { AccountSuspendedError } from '../errors/account-suspended-error'
import { ClientError } from '../errors/client-error'
import {
  LoginAttemptsRepository,
  type LoginAttemptInput
} from '../repositories/login-attempts.repository'
import { hashToken } from '../utils/hash-token'
import { normalizeEmail } from '../utils/normalize-email'

/** Só o que o servidor decidiu sobre a senha vira linha; falha de infraestrutura (Redis, banco) não é tentativa. */
export function outcomeOfError(error: unknown): LoginOutcome | null {
  if (error instanceof AccountSuspendedError) return 'SUSPENDED'
  if (!(error instanceof ClientError)) return null
  if (error.statusCode === 429) return 'LOCKED'
  if (error.statusCode === 400 || error.statusCode === 401)
    return 'BAD_CREDENTIALS'
  return null
}

export class LoginAttemptRecorder {
  constructor(
    private repository: Pick<
      LoginAttemptsRepository,
      'create'
    > = new LoginAttemptsRepository()
  ) {}

  /** Nunca rejeita: o registro não pode derrubar nem atrasar o login. */
  async record(
    source: LoginSource,
    email: string,
    ip: string,
    outcome: LoginOutcome
  ): Promise<void> {
    try {
      const input: LoginAttemptInput = {
        emailHash: hashToken(normalizeEmail(email)),
        ipHash: hashToken(ip),
        source,
        outcome
      }
      await this.repository.create(input)
    } catch (error) {
      console.warn('[LoginAttempts] could not record an attempt', {
        message: error instanceof Error ? error.message : 'unknown'
      })
    }
  }

  /** Roda o login e grava o desfecho sem esperar o banco, em todos os caminhos. */
  async track<T>(
    source: LoginSource,
    email: string,
    ip: string,
    run: () => Promise<T>
  ): Promise<T> {
    let result: T
    try {
      result = await run()
    } catch (error) {
      const outcome = outcomeOfError(error)
      if (outcome) void this.record(source, email, ip, outcome)
      throw error
    }
    void this.record(source, email, ip, 'SUCCESS')
    return result
  }
}
