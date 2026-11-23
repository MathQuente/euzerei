import { ClientError } from '../errors/client-error'
import { AdminReviewsRepository } from '../repositories/admin-reviews.repository'
import type { AdminReviewsListQuery } from '../schemas/admin-reviews.schema'
import { daysAgo } from '../utils/brasilia-time'
import { withReadLimit } from '../utils/admin-read-limit'

const EXCERPT_LENGTH = 120
const READ_ERROR = 'A leitura das reviews demorou demais.'

export type ReviewStatus = 'open' | 'resolved' | 'hidden'

/** Oculta > aberta > resolvida. A mesma regra vale no filtro da lista e no selo do painel. */
export function statusOf(
  hiddenAt: Date | null,
  openReports: number
): ReviewStatus {
  if (hiddenAt !== null) return 'hidden'
  return openReports > 0 ? 'open' : 'resolved'
}

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
          (query.page - 1) * query.limit,
          query.limit
        ),
      READ_ERROR
    )

    return {
      items: rows.map(row => {
        const status = statusOf(row.hiddenAt, row.openReports)
        return {
          id: row.id,
          excerpt: excerptOf(row.excerpt),
          handle: row.handle,
          game: { igdbId: row.igdbId, name: row.gameName },
          status,
          openReports: row.openReports,
          totalReports: row.totalReports,
          mainReason: row.mainReason ? row.mainReason.toLowerCase() : null,
          // A idade que a coluna "Há" mostra: da denúncia aberta, da decisão ou do momento em que foi ocultada.
          since: (
            (status === 'open'
              ? row.oldestOpenAt
              : status === 'hidden'
                ? row.hiddenAt
                : row.lastResolvedAt) ?? row.lastActivityAt
          ).toISOString(),
          editedAfterReport: row.editedAfterReport
        }
      }),
      page: query.page,
      pageSize: query.limit,
      total
    }
  }

  async summary(now: Date = new Date()) {
    const { counts, decisionDays } = await withReadLimit(
      () => this.repository.summaryCounts(daysAgo(now, 7), daysAgo(now, 30)),
      READ_ERROR
    )
    const [openReports, openReviews, oldest, published, published7d, hidden] =
      counts

    return {
      openReports,
      openReviews,
      oldestOpenAt: oldest._min.createdAt?.toISOString() ?? null,
      published,
      published7d,
      hidden,
      decisionDays:
        decisionDays === null ? null : Math.round(decisionDays * 10) / 10
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
      status: statusOf(
        review.hiddenAt,
        review.reports.filter(report => report.resolvedAt === null).length
      ),
      hiddenAt: review.hiddenAt?.toISOString() ?? null,
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
        admin: review.user.role === 'ADMIN',
        createdAt: review.user.createdAt.toISOString(),
        suspended: review.user.suspendedAt !== null,
        reviews: reviewsTotal,
        reviewsReported
      }
    }
  }
}
