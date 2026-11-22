import { ClientError } from '../errors/client-error'
import { AuditRepository } from '../repositories/audit.repository'
import { CacheRepository } from '../repositories/cache.repository'
import {
  AdminUserActionsRepository,
  type UserActionAudit
} from '../repositories/admin-user-actions.repository'
import type { ImportQueueRepository } from '../repositories/import-queue.repository'
import { UserRepository } from '../repositories/users.repository'
import {
  DELETE_ACCOUNT_ACTION,
  REACTIVATE_ACCOUNT_ACTION,
  SUSPEND_ACCOUNT_ACTION
} from '../utils/audit-actions'
import {
  emailChangeCurrentKey,
  emailChangeKey,
  parsePendingEmailChange
} from '../utils/email-change'
import { destroyOwnedImages } from '../utils/owned-images'
import { isRecordNotFound } from '../utils/prisma-errors'
import { logError } from '../utils/respond-unavailable'
import { markSessionsRevoked } from '../utils/session-revocation'

export interface UserActionActor {
  actorId: string
  ip: string
}

const NOT_FOUND = 'Usuário não encontrado.'
const REVOKE_UNAVAILABLE = 'Não foi possível encerrar as sessões agora.'

export class AdminUserActionsService {
  constructor(
    private repository: Pick<
      AdminUserActionsRepository,
      'findTarget' | 'suspend' | 'reactivate' | 'deleteUser'
    > = new AdminUserActionsRepository(),
    private cache: Pick<
      CacheRepository,
      'set' | 'get' | 'del'
    > = new CacheRepository(),
    private strictAudit: Pick<
      AuditRepository,
      'create' | 'markFailed'
    > = new AuditRepository(),
    private queues: Pick<ImportQueueRepository, 'removeUserJobs'>,
    private images: Pick<
      UserRepository,
      'findImageUrlsInUse'
    > = new UserRepository()
  ) {}

  private async requireTarget(id: string, actor: UserActionActor) {
    const target = await this.repository.findTarget(id)
    if (!target) throw new ClientError(NOT_FOUND, 404)
    if (target.id === actor.actorId) {
      throw new ClientError(
        'Você não pode fazer isso com a sua própria conta.',
        403
      )
    }
    if (target.role === 'ADMIN') {
      throw new ClientError(
        'Contas de administrador não podem ser alteradas por aqui.',
        403
      )
    }
    return target
  }

  private auditFor(
    actor: UserActionActor,
    action: string,
    handle: string,
    detail: string
  ): UserActionAudit {
    return {
      actorId: actor.actorId,
      ip: actor.ip,
      action,
      target: `@${handle}`,
      detail
    }
  }

  private async revokeSessions(id: string) {
    try {
      await markSessionsRevoked(this.cache as CacheRepository, id, 1)
    } catch (error) {
      logError('[Admin] session revocation failed', error)
      throw new ClientError(REVOKE_UNAVAILABLE, 503)
    }
  }

  async suspend(id: string, actor: UserActionActor, now: Date = new Date()) {
    const target = await this.requireTarget(id, actor)
    if (target.suspendedAt) return { changed: false }

    await this.revokeSessions(id)
    const changed = await this.repository.suspend(
      id,
      now,
      this.auditFor(
        actor,
        SUSPEND_ACCOUNT_ACTION,
        target.userName,
        'Sessões encerradas; a conta não consegue entrar.'
      )
    )
    if (changed) await this.dropPendingEmailChange(id)
    return { changed }
  }

  async reactivate(id: string, actor: UserActionActor) {
    const target = await this.requireTarget(id, actor)
    if (!target.suspendedAt) return { changed: false }

    const changed = await this.repository.reactivate(
      id,
      this.auditFor(
        actor,
        REACTIVATE_ACCOUNT_ACTION,
        target.userName,
        'A conta volta a poder entrar; as sessões não voltam.'
      )
    )
    return { changed }
  }

  async deleteAccount(id: string, handle: string, actor: UserActionActor) {
    const target = await this.requireTarget(id, actor)
    if (handle !== target.userName) {
      throw new ClientError('O handle digitado não confere com a conta.', 409)
    }

    // Auditoria ANTES, estrita: se ela falha, nada é apagado.
    const entry = await this.strictAudit.create({
      actorId: actor.actorId,
      action: DELETE_ACCOUNT_ACTION,
      area: 'USERS',
      target: `@${target.userName}`,
      detail: 'Conta e todos os dados apagados.',
      ip: actor.ip
    })

    try {
      await this.revokeSessions(id)
      await this.repository.deleteUser(id)
    } catch (error) {
      await this.markFailed(entry.id)
      if (isRecordNotFound(error)) throw new ClientError(NOT_FOUND, 404)
      throw error
    }

    await this.cleanupAfterDelete(id, target)
    return { deleted: true }
  }

  private async markFailed(auditId: string) {
    try {
      await this.strictAudit.markFailed(auditId, 'A conta não foi excluída.')
    } catch (error) {
      logError('[Admin] could not mark audit row as failed', error)
    }
  }

  /** Melhor esforço: a conta já foi apagada, então nada daqui desfaz o resultado. */
  private async cleanupAfterDelete(
    id: string,
    target: { profilePicture: string | null; userBanner: string | null }
  ) {
    try {
      await this.queues.removeUserJobs(id)
    } catch (error) {
      logError('[Admin] import jobs of deleted user not removed', error)
    }
    await destroyOwnedImages(
      [target.profilePicture, target.userBanner],
      urls => this.images.findImageUrlsInUse(urls),
      error => logError('[Admin] image of deleted user not removed', error)
    )
  }

  private async dropPendingEmailChange(id: string) {
    try {
      const pending = parsePendingEmailChange(
        await this.cache.get(emailChangeCurrentKey(id))
      )
      if (pending) await this.cache.del(emailChangeKey(pending.tokenHash))
      await this.cache.del(emailChangeCurrentKey(id))
    } catch (error) {
      logError('[Admin] pending e-mail change not cancelled', error)
    }
  }
}
