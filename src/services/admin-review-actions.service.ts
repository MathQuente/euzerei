import { ClientError } from '../errors/client-error'
import { AuditRepository } from '../repositories/audit.repository'
import {
  AdminReviewActionsRepository,
  type ReviewActionAudit
} from '../repositories/admin-review-actions.repository'
import {
  DISMISS_REVIEW_ACTION,
  HIDE_REVIEW_ACTION,
  REMOVE_REVIEW_ACTION,
  RESTORE_REVIEW_ACTION
} from '../utils/audit-actions'
import { isRecordNotFound } from '../utils/prisma-errors'
import { logError } from '../utils/respond-unavailable'

export interface ReviewActionActor {
  actorId: string
  ip: string
}

const NOT_FOUND = 'Review não encontrada.'

function reportsText(count: number): string {
  return `${count} ${count === 1 ? 'denúncia' : 'denúncias'}`
}

export class AdminReviewActionsService {
  constructor(
    private repository: Pick<
      AdminReviewActionsRepository,
      'findTarget' | 'hide' | 'restore' | 'dismiss' | 'deleteReview'
    > = new AdminReviewActionsRepository(),
    private strictAudit: Pick<
      AuditRepository,
      'create' | 'markFailed'
    > = new AuditRepository()
  ) {}

  private async requireTarget(id: string) {
    const target = await this.repository.findTarget(id)
    if (!target) throw new ClientError(NOT_FOUND, 404)
    return target
  }

  /** `@handle · jogo`: nunca o texto da review. */
  private labelOf(target: {
    handle: string
    gameName: string | null
    igdbId: number
  }) {
    return `@${target.handle} · ${target.gameName ?? `Jogo #${target.igdbId}`}`
  }

  private auditFor(
    actor: ReviewActionActor,
    action: string,
    target: string,
    detailFor: (closedReports: number) => string
  ): ReviewActionAudit {
    return { actorId: actor.actorId, ip: actor.ip, action, target, detailFor }
  }

  async hide(id: string, actor: ReviewActionActor, now: Date = new Date()) {
    const target = await this.requireTarget(id)
    const changed = await this.repository.hide(
      id,
      now,
      this.auditFor(
        actor,
        HIDE_REVIEW_ACTION,
        this.labelOf(target),
        closed =>
          `Saiu da página do jogo; ${reportsText(closed)} ${closed === 1 ? 'fechada' : 'fechadas'}. O autor continua vendo a dele.`
      )
    )
    return { changed }
  }

  async restore(id: string, actor: ReviewActionActor) {
    const target = await this.requireTarget(id)
    const changed = await this.repository.restore(
      id,
      this.auditFor(
        actor,
        RESTORE_REVIEW_ACTION,
        this.labelOf(target),
        () => 'Voltou à página do jogo. As denúncias decididas não reabrem.'
      )
    )
    return { changed }
  }

  async dismiss(id: string, actor: ReviewActionActor, now: Date = new Date()) {
    const target = await this.requireTarget(id)
    const changed = await this.repository.dismiss(
      id,
      now,
      this.auditFor(
        actor,
        DISMISS_REVIEW_ACTION,
        this.labelOf(target),
        closed =>
          `${reportsText(closed)} ${closed === 1 ? 'dispensada' : 'dispensadas'}; a review continua publicada.`
      )
    )
    return { changed }
  }

  async removeReview(id: string, handle: string, actor: ReviewActionActor) {
    const target = await this.requireTarget(id)
    if (handle !== target.handle) {
      throw new ClientError('O handle digitado não confere com o autor.', 409)
    }

    // Auditoria ANTES, estrita: se ela falha, nada é apagado.
    const entry = await this.strictAudit.create({
      actorId: actor.actorId,
      action: REMOVE_REVIEW_ACTION,
      area: 'MODERATION',
      target: this.labelOf(target),
      detail: `Review apagada com ${reportsText(target.reports)}. Sem volta.`,
      ip: actor.ip
    })

    try {
      await this.repository.deleteReview(id)
    } catch (error) {
      await this.markFailed(entry.id)
      if (isRecordNotFound(error)) throw new ClientError(NOT_FOUND, 404)
      throw error
    }

    return { deleted: true }
  }

  private async markFailed(auditId: string) {
    try {
      await this.strictAudit.markFailed(auditId, 'A review não foi removida.')
    } catch (error) {
      logError('[Admin] could not mark audit row as failed', error)
    }
  }
}
