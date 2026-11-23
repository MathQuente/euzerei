import { ClientError } from '../errors/client-error'
import { AdminUserActionsRepository } from '../repositories/admin-user-actions.repository'
import { AuditRepository } from '../repositories/audit.repository'
import { CacheRepository } from '../repositories/cache.repository'
import type { AuthService } from './auth.service'
import {
  PASSWORD_RESET_ACTION,
  RESEND_VERIFICATION_ACTION
} from '../utils/audit-actions'
import { logError } from '../utils/respond-unavailable'

export const EMAIL_COOLDOWN_SECONDS = 60

export interface EmailActor {
  actorId: string
  ip: string
}

type Kind = 'verification' | 'reset'

const ACTION: Record<Kind, string> = {
  verification: RESEND_VERIFICATION_ACTION,
  reset: PASSWORD_RESET_ACTION
}

export const cooldownKey = (kind: Kind, userId: string) =>
  `admin-email-cooldown:${kind}:${userId}`

/**
 * Reenviar verificação e redefinir senha pelo admin. O e-mail vai para o endereço da conta: nem o endereço nem o link
 * aparecem na resposta ou na auditoria. A auditoria é gravada ANTES do envio, de forma estrita; se o envio falha, a
 * mesma linha vira FAILED.
 */
export class AdminUserEmailsService {
  constructor(
    private auth: Pick<
      AuthService,
      'resendEmailVerificationAsAdmin' | 'requestPasswordResetAsAdmin'
    >,
    private repository: Pick<
      AdminUserActionsRepository,
      'findTarget'
    > = new AdminUserActionsRepository(),
    private cache: Pick<
      CacheRepository,
      'setIfAbsent' | 'del'
    > = new CacheRepository(),
    private strictAudit: Pick<
      AuditRepository,
      'create' | 'markFailed'
    > = new AuditRepository()
  ) {}

  resendVerification(id: string, actor: EmailActor) {
    return this.send('verification', id, actor)
  }

  resetPassword(id: string, actor: EmailActor) {
    return this.send('reset', id, actor)
  }

  private async send(kind: Kind, id: string, actor: EmailActor) {
    const target = await this.repository.findTarget(id)
    if (!target) throw new ClientError('Usuário não encontrado.', 404)
    if (target.suspendedAt) {
      throw new ClientError(
        'A conta está suspensa: não há para quem enviar.',
        409
      )
    }
    if (kind === 'verification' && target.emailVerifiedAt) {
      throw new ClientError('O e-mail desta conta já está verificado.', 409)
    }

    const first = await this.cache.setIfAbsent(
      cooldownKey(kind, id),
      true,
      EMAIL_COOLDOWN_SECONDS
    )
    if (!first) {
      throw new ClientError(
        'Já foi enviado agora há pouco. Espere um minuto para repetir.',
        429
      )
    }

    let entryId: string
    try {
      const entry = await this.strictAudit.create({
        actorId: actor.actorId,
        action: ACTION[kind],
        area: 'USERS',
        target: `@${target.userName}`,
        detail: 'E-mail enviado ao endereço da conta.',
        ip: actor.ip
      })
      entryId = entry.id
    } catch (error) {
      await this.cache.del(cooldownKey(kind, id)).catch(() => undefined)
      throw error
    }

    try {
      if (kind === 'verification') {
        await this.auth.resendEmailVerificationAsAdmin(id)
      } else {
        await this.auth.requestPasswordResetAsAdmin(id)
      }
    } catch (error) {
      await this.cache.del(cooldownKey(kind, id)).catch(() => undefined)
      const why =
        error instanceof ClientError
          ? error.message
          : 'Falha ao enviar o e-mail.'
      await this.strictAudit
        .markFailed(entryId, why)
        .catch(auditError =>
          logError('[Admin] could not mark audit row as failed', auditError)
        )
      throw error
    }

    return { sent: true }
  }
}
