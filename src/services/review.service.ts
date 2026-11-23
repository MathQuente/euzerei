import { ClientError } from '../errors/client-error'
import { ReviewRepository } from '../repositories/review.repository'
import { isUniqueViolation } from '../utils/prisma-errors'
import type { ReviewReportReason } from '../database/prisma-client'
import { UserRepository } from '../repositories/users.repository'
import { GameCacheService } from './game-cache.service'
import {
  PLAYED_STATUS_ID,
  PAUSED_STATUS_ID,
  PLAYING_STATUS_ID,
  BACKLOG_STATUS_ID,
  DROPPED_STATUS_ID
} from '../utils/library-status'

const REVIEWABLE_STATUS_IDS = [
  PLAYED_STATUS_ID,
  PAUSED_STATUS_ID,
  PLAYING_STATUS_ID,
  DROPPED_STATUS_ID
]

export class ReviewService {
  constructor(
    private reviewRepository: ReviewRepository,
    private userRepository: UserRepository,
    private gameCacheService: GameCacheService
  ) {}

  private async requireUser(userId: string) {
    const user = await this.userRepository.findUserById(userId)
    if (!user) throw new ClientError('Usuário não encontrado.', 404)
    return user
  }

  async upsertReview(igdbId: number, userId: string, text: string) {
    await this.requireUser(userId)

    const existing = await this.reviewRepository.findByUserGame(igdbId, userId)

    if (!existing) {
      const userGame = await this.userRepository.findUserGameStatus(
        igdbId,
        userId
      )
      if (!userGame) {
        throw new ClientError(
          'Adicione o jogo à sua biblioteca para escrever uma análise.',
          404
        )
      }

      await this.gameCacheService.assertReleased(igdbId)

      const statusId = userGame.UserGamesStatus?.id as number
      const stats = userGame.UserGameStats
      const hasExperience =
        Number(stats?.hoursPlayed ?? 0) > 0 || (stats?.completions ?? 0) > 0
      const canReview =
        REVIEWABLE_STATUS_IDS.includes(statusId) ||
        (statusId === BACKLOG_STATUS_ID && hasExperience)
      if (!canReview) {
        throw new ClientError(
          'Você só pode escrever uma análise de um jogo que já começou (Jogado, Jogando, Pausado ou Larguei) ou de um jogo na sua fila com horas ou finalizações registradas.',
          400
        )
      }
    }

    const review = await this.reviewRepository.upsert(userId, igdbId, text)

    return { review: { text: review.text, updatedAt: review.updatedAt } }
  }

  async findOwnReview(igdbId: number, userId: string) {
    await this.requireUser(userId)

    const review = await this.reviewRepository.findByUserGame(igdbId, userId)

    return {
      review: review ? { text: review.text, updatedAt: review.updatedAt } : null
    }
  }

  async deleteReview(igdbId: number, userId: string) {
    await this.requireUser(userId)

    const existing = await this.reviewRepository.findByUserGame(igdbId, userId)
    if (!existing) throw new ClientError('Análise não encontrada.', 404)

    await this.reviewRepository.delete(userId, igdbId)
  }

  async reportReview(
    igdbId: number,
    authorId: string,
    reporterId: string,
    reason: ReviewReportReason
  ) {
    if (authorId === reporterId) {
      throw new ClientError(
        'Você não pode denunciar a sua própria análise.',
        403
      )
    }

    const review = await this.reviewRepository.findByUserGame(igdbId, authorId)
    // Uma review oculta já saiu da página do jogo: quem denuncia não a enxerga mais.
    if (!review || review.hiddenAt) {
      throw new ClientError('Análise não encontrada.', 404)
    }

    try {
      await this.reviewRepository.createReport({
        reviewId: review.id,
        reporterId,
        reason,
        reviewUpdatedAt: review.updatedAt
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ClientError('Você já denunciou esta análise.', 409)
      }
      throw error
    }

    return { reported: true as const }
  }

  private readonly COMMUNITY_REVIEWS_PER_PAGE = 10

  async findCommunityReviews(
    igdbId: number,
    pageIndex: number,
    limit = this.COMMUNITY_REVIEWS_PER_PAGE,
    viewerId: string | null = null
  ) {
    const [reviews, total] = await Promise.all([
      this.reviewRepository.findCommunityReviews({
        igdbId,
        skip: pageIndex * limit,
        take: limit,
        viewerId
      }),
      this.reviewRepository.countCommunityReviews(igdbId)
    ])

    return {
      reviews: reviews.map(r => ({
        userId: r.userId,
        userName: r.userName,
        profilePicture: r.profilePicture,
        rating: r.rating,
        hoursPlayed: r.hoursPlayed,
        completions: r.completions,
        status: r.status,
        endless: r.endless,
        text: r.text,
        createdAt: r.createdAt,
        reportedByMe: r.reportedByMe
      })),
      total
    }
  }
}
