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
  hiddenAt: Date | null
  totalReports: number
  openReports: number
  mainReason: string | null
  oldestOpenAt: Date | null
  lastResolvedAt: Date | null
  lastActivityAt: Date
  editedAfterReport: boolean
}

function queueFilters(status: AdminReviewsStatus, q: string | undefined) {
  const text = q?.replace(/^@+/, '').trim()
  const search = text
    ? Prisma.sql`AND (u.user_name ILIKE ${`%${escapeLike(text)}%`} OR g.name ILIKE ${`%${escapeLike(text)}%`})`
    : Prisma.empty

  // Uma só derivação de estado (a mesma do painel): oculta > aberta > resolvida. Nunca do "último resolution".
  const where =
    status === 'open'
      ? Prisma.sql`AND rv.hidden_at IS NULL`
      : status === 'resolved'
        ? Prisma.sql`AND rv.hidden_at IS NULL`
        : status === 'hidden'
          ? Prisma.sql`AND rv.hidden_at IS NOT NULL`
          : Prisma.empty
  const having =
    status === 'open'
      ? Prisma.sql`HAVING COUNT(rp.id) FILTER (WHERE rp.resolved_at IS NULL) > 0`
      : status === 'resolved'
        ? Prisma.sql`HAVING COUNT(rp.id) > 0 AND COUNT(rp.id) FILTER (WHERE rp.resolved_at IS NULL) = 0`
        : Prisma.empty
  return { search, where, having }
}

const QUEUE_FROM = Prisma.sql`
  FROM reviews rv
  JOIN users u ON u.id = rv.user_id
  LEFT JOIN games_cache g ON g.igdb_id = rv.igdb_id
  LEFT JOIN review_reports rp ON rp.review_id = rv.id
`
// Entra na fila quem já foi denunciado ou foi ocultado.
const IN_QUEUE = Prisma.sql`WHERE (rp.id IS NOT NULL OR rv.hidden_at IS NOT NULL)`

function queueOrder(status: AdminReviewsStatus) {
  switch (status) {
    case 'open':
      return Prisma.sql`ORDER BY MIN(rp.created_at) FILTER (WHERE rp.resolved_at IS NULL) ASC, rv.id ASC`
    case 'resolved':
      return Prisma.sql`ORDER BY MAX(rp.resolved_at) DESC, rv.id DESC`
    case 'hidden':
      return Prisma.sql`ORDER BY rv.hidden_at DESC, rv.id DESC`
    default:
      return Prisma.sql`ORDER BY GREATEST(MAX(rp.created_at), MAX(rp.resolved_at), rv.hidden_at) DESC, rv.id DESC`
  }
}

export class AdminReviewsRepository {
  async findQueue(
    status: AdminReviewsStatus,
    q: string | undefined,
    skip: number,
    take: number
  ): Promise<[number, ReviewQueueRow[]]> {
    const { search, where, having } = queueFilters(status, q)

    const [counted, rows] = await Promise.all([
      prisma.$queryRaw<[{ count: bigint }]>(Prisma.sql`
        SELECT COUNT(*) AS count FROM (
          SELECT rv.id ${QUEUE_FROM} ${IN_QUEUE} ${where} ${search}
          GROUP BY rv.id, u.user_name, g.name ${having}
        ) q
      `),
      prisma.$queryRaw<
        Array<
          Omit<ReviewQueueRow, 'openReports' | 'totalReports'> & {
            openReports: bigint
            totalReports: bigint
          }
        >
      >(Prisma.sql`
        SELECT
          rv.id,
          LEFT(rv.text, 400) AS "excerpt",
          rv.igdb_id AS "igdbId",
          g.name AS "gameName",
          u.user_name AS "handle",
          rv.hidden_at AS "hiddenAt",
          COUNT(rp.id) AS "totalReports",
          COUNT(rp.id) FILTER (WHERE rp.resolved_at IS NULL) AS "openReports",
          (
            SELECT x.reason::text FROM review_reports x
            WHERE x.review_id = rv.id
              AND (x.resolved_at IS NULL OR NOT EXISTS (
                SELECT 1 FROM review_reports o WHERE o.review_id = rv.id AND o.resolved_at IS NULL
              ))
            GROUP BY x.reason ORDER BY COUNT(*) DESC, x.reason LIMIT 1
          ) AS "mainReason",
          MIN(rp.created_at) FILTER (WHERE rp.resolved_at IS NULL) AS "oldestOpenAt",
          MAX(rp.resolved_at) AS "lastResolvedAt",
          GREATEST(MAX(rp.created_at), MAX(rp.resolved_at), rv.hidden_at, rv.created_at) AS "lastActivityAt",
          COALESCE(BOOL_OR(rp.resolved_at IS NULL AND rv.updated_at > rp.review_updated_at), false) AS "editedAfterReport"
        ${QUEUE_FROM} ${IN_QUEUE} ${where} ${search}
        GROUP BY rv.id, u.user_name, g.name ${having}
        ${queueOrder(status)}
        LIMIT ${take} OFFSET ${skip}
      `)
    ])

    return [
      Number(counted[0].count),
      rows.map(row => ({
        ...row,
        openReports: Number(row.openReports),
        totalReports: Number(row.totalReports)
      }))
    ]
  }

  async summaryCounts(weekStart: Date, decisionsSince: Date) {
    const [counts, decision] = await Promise.all([
      prisma.$transaction([
        prisma.reviewReport.count({ where: { resolvedAt: null } }),
        prisma.review.count({
          where: { reports: { some: { resolvedAt: null } } }
        }),
        prisma.reviewReport.aggregate({
          where: { resolvedAt: null },
          _min: { createdAt: true }
        }),
        prisma.review.count({ where: { hiddenAt: null } }),
        prisma.review.count({
          where: { hiddenAt: null, createdAt: { gte: weekStart } }
        }),
        prisma.review.count({ where: { hiddenAt: { not: null } } })
      ]),
      // Por lote de decisão: todas as denúncias fechadas no mesmo instante de uma review contam como uma decisão,
      // medida da denúncia mais antiga do lote até o fechamento.
      prisma.$queryRaw<[{ days: number | null }]>(Prisma.sql`
        SELECT AVG(EXTRACT(EPOCH FROM (g.resolved_at - g.first_report)) / 86400)::float AS days
        FROM (
          SELECT review_id, resolved_at, MIN(created_at) AS first_report
          FROM review_reports
          WHERE resolved_at >= ${decisionsSince}
          GROUP BY review_id, resolved_at
        ) g
      `)
    ])

    return { counts, decisionDays: decision[0]?.days ?? null }
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
        hiddenAt: true,
        user: {
          select: {
            id: true,
            userName: true,
            role: true,
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
