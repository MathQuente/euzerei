import { prisma } from '../database/db'
import { Prisma } from '../database/prisma-client'
import { escapeLike } from '../utils/escape-like'
import type { AdminReviewsStatus } from '../schemas/admin-reviews.schema'

export interface ReviewQueueRow {
  id: string
  excerpt: string
  igdbId: number
  gameName: string | null
  handle: string
  openReports: number
  mainReason: string | null
  oldestOpenAt: Date | null
  lastReportAt: Date
  editedAfterReport: boolean
}

function queueFilters(status: AdminReviewsStatus, q: string | undefined) {
  const text = q?.replace(/^@+/, '').trim()
  const search = text
    ? Prisma.sql`AND (u.user_name ILIKE ${`%${escapeLike(text)}%`} OR g.name ILIKE ${`%${escapeLike(text)}%`})`
    : Prisma.empty
  const having =
    status === 'open'
      ? Prisma.sql`HAVING COUNT(*) FILTER (WHERE rp.resolved_at IS NULL) > 0`
      : Prisma.empty
  return { search, having }
}

const QUEUE_FROM = Prisma.sql`
  FROM review_reports rp
  JOIN reviews rv ON rv.id = rp.review_id
  JOIN users u ON u.id = rv.user_id
  LEFT JOIN games_cache g ON g.igdb_id = rv.igdb_id
`

export class AdminReviewsRepository {
  async findQueue(
    status: AdminReviewsStatus,
    q: string | undefined,
    skip: number,
    take: number
  ): Promise<[number, ReviewQueueRow[]]> {
    const { search, having } = queueFilters(status, q)
    const order =
      status === 'open'
        ? Prisma.sql`ORDER BY MIN(rp.created_at) FILTER (WHERE rp.resolved_at IS NULL) ASC, rv.id ASC`
        : Prisma.sql`ORDER BY MAX(rp.created_at) DESC, rv.id DESC`

    const [counted, rows] = await Promise.all([
      prisma.$queryRaw<[{ count: bigint }]>(Prisma.sql`
        SELECT COUNT(*) AS count FROM (
          SELECT rv.id ${QUEUE_FROM} WHERE TRUE ${search}
          GROUP BY rv.id, u.user_name, g.name ${having}
        ) q
      `),
      prisma.$queryRaw<
        Array<Omit<ReviewQueueRow, 'openReports'> & { openReports: bigint }>
      >(Prisma.sql`
        SELECT
          rv.id,
          LEFT(rv.text, 400) AS "excerpt",
          rv.igdb_id AS "igdbId",
          g.name AS "gameName",
          u.user_name AS "handle",
          COUNT(*) FILTER (WHERE rp.resolved_at IS NULL) AS "openReports",
          (
            SELECT x.reason::text FROM review_reports x
            WHERE x.review_id = rv.id AND x.resolved_at IS NULL
            GROUP BY x.reason ORDER BY COUNT(*) DESC, x.reason LIMIT 1
          ) AS "mainReason",
          MIN(rp.created_at) FILTER (WHERE rp.resolved_at IS NULL) AS "oldestOpenAt",
          MAX(rp.created_at) AS "lastReportAt",
          COALESCE(BOOL_OR(rp.resolved_at IS NULL AND rv.updated_at > rp.review_updated_at), false) AS "editedAfterReport"
        ${QUEUE_FROM} WHERE TRUE ${search}
        GROUP BY rv.id, u.user_name, g.name ${having}
        ${order}
        LIMIT ${take} OFFSET ${skip}
      `)
    ])

    return [
      Number(counted[0].count),
      rows.map(row => ({ ...row, openReports: Number(row.openReports) }))
    ]
  }

  summaryCounts(weekStart: Date) {
    return prisma.$transaction([
      prisma.reviewReport.count({ where: { resolvedAt: null } }),
      prisma.review.count({
        where: { reports: { some: { resolvedAt: null } } }
      }),
      prisma.reviewReport.aggregate({
        where: { resolvedAt: null },
        _min: { createdAt: true }
      }),
      prisma.review.count(),
      prisma.review.count({ where: { createdAt: { gte: weekStart } } })
    ])
  }

  async findDetail(id: string) {
    const review = await prisma.review.findUnique({
      where: { id },
      select: {
        id: true,
        text: true,
        igdbId: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            id: true,
            userName: true,
            createdAt: true,
            suspendedAt: true
          }
        },
        reports: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            reason: true,
            createdAt: true,
            reviewUpdatedAt: true,
            resolvedAt: true,
            resolution: true,
            reporter: { select: { userName: true } }
          }
        }
      }
    })
    if (!review) return null

    const [game, rating, reviewsTotal, reviewsReported] =
      await prisma.$transaction([
        prisma.gameCache.findUnique({
          where: { igdbId: review.igdbId },
          select: { name: true }
        }),
        prisma.rating.findUnique({
          where: {
            userId_igdbId: { userId: review.user.id, igdbId: review.igdbId }
          },
          select: { value: true }
        }),
        prisma.review.count({ where: { userId: review.user.id } }),
        prisma.review.count({
          where: { userId: review.user.id, reports: { some: {} } }
        })
      ])

    return { review, game, rating, reviewsTotal, reviewsReported }
  }
}
