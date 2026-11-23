import { ClientError } from '../errors/client-error'
import { AdminReviewsRepository } from '../repositories/admin-reviews.repository'
import {
  ADMIN_REVIEWS_PAGE_SIZE,
  type AdminReviewsListQuery
} from '../schemas/admin-reviews.schema'
import { daysAgo } from '../utils/brasilia-time'
import { withReadLimit } from '../utils/admin-read-limit'

const EXCERPT_LENGTH = 120
const READ_ERROR = 'A leitura das reviews demorou demais.'

function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT_LENGTH
    ? `${flat.slice(0, EXCERPT_LENGTH).trimEnd()}…`
    : flat
}

export class AdminReviewsService {
  constructor(
    private repository: AdminReviewsRepository = new AdminReviewsRepository()
  ) {}

  async list(query: AdminReviewsListQuery) {
    const [total, rows] = await withReadLimit(
      () =>
        this.repository.findQueue(
          query.status,
          query.q,
          (query.page - 1) * ADMIN_REVIEWS_PAGE_SIZE,
          ADMIN_REVIEWS_PAGE_SIZE
        ),
      READ_ERROR
    )

    return {
      items: rows.map(row => ({
        id: row.id,
        excerpt: excerptOf(row.excerpt),
        handle: row.handle,
        game: { igdbId: row.igdbId, name: row.gameName },
        openReports: row.openReports,
        mainReason: row.mainReason ? row.mainReason.toLowerCase() : null,
        oldestOpenAt: row.oldestOpenAt?.toISOString() ?? null,
        lastReportAt: row.lastReportAt.toISOString(),
        editedAfterReport: row.editedAfterReport
      })),
      page: query.page,
      pageSize: ADMIN_REVIEWS_PAGE_SIZE,
      total
    }
  }

  async summary(now: Date = new Date()) {
    const [openReports, openReviews, oldest, published, published7d] =
      await withReadLimit(
        () => this.repository.summaryCounts(daysAgo(now, 7)),
        READ_ERROR
      )

    return {
      openReports,
      openReviews,
      oldestOpenAt: oldest._min.createdAt?.toISOString() ?? null,
      published,
      published7d,
      // Chegam com a moderação (onda b): ainda não existe ocultar nem decidir.
      hidden: null,
      decisionDays: null
    }
  }

  async detail(id: string) {
    const found = await withReadLimit(
      () => this.repository.findDetail(id),
      READ_ERROR
    )
    if (!found) throw new ClientError('Review não encontrada.', 404)
    const { review, game, rating, reviewsTotal, reviewsReported } = found

    return {
      id: review.id,
      text: review.text,
      game: { igdbId: review.igdbId, name: game?.name ?? null },
      rating: rating?.value ?? null,
      createdAt: review.createdAt.toISOString(),
      updatedAt: review.updatedAt.toISOString(),
      reports: review.reports.map(report => ({
        reason: report.reason.toLowerCase(),
        reporter: report.reporter?.userName ?? null,
        createdAt: report.createdAt.toISOString(),
        editedAfter: review.updatedAt > report.reviewUpdatedAt,
        resolvedAt: report.resolvedAt?.toISOString() ?? null,
        resolution: report.resolution?.toLowerCase() ?? null
      })),
      author: {
        id: review.user.id,
        handle: review.user.userName,
        createdAt: review.user.createdAt.toISOString(),
        suspended: review.user.suspendedAt !== null,
        reviews: reviewsTotal,
        reviewsReported
      }
    }
  }
}
