import { prisma } from '../database/db'
import type { Prisma } from '../database/prisma-client'
import { buildAdminUsersWhere } from '../utils/admin-users-where'

export class AdminUsersRepository {
  findPage(where: Prisma.UserWhereInput, skip: number, take: number) {
    return prisma.$transaction([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
        select: {
          id: true,
          userName: true,
          email: true,
          emailVerifiedAt: true,
          role: true,
          suspendedAt: true,
          lastSeenAt: true,
          termsVersion: true,
          createdAt: true,
          _count: { select: { userGames: true } },
          accounts: { select: { platform: true } }
        }
      })
    ])
  }

  countWithoutCurrentTerms() {
    return prisma.user.count({
      where: buildAdminUsersWhere({ filter: 'noTerms' })
    })
  }

  summaryCounts(activeSince: Date) {
    return prisma.$transaction([
      prisma.user.count(),
      prisma.user.count({
        where: { refreshToken: { some: { createdAt: { gte: activeSince } } } }
      })
    ])
  }

  findDetail(userId: string, now: Date) {
    return Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          userName: true,
          email: true,
          emailVerifiedAt: true,
          role: true,
          suspendedAt: true,
          lastSeenAt: true,
          hasPassword: true,
          googleId: true,
          discordId: true,
          termsAcceptedAt: true,
          termsVersion: true,
          createdAt: true
        }
      }),
      prisma.userGame.groupBy({
        by: ['userGamesStatusId'],
        where: { userId },
        orderBy: { userGamesStatusId: 'asc' },
        _count: { id: true }
      }),
      prisma.userGamesStatus.findMany({ select: { id: true, status: true } }),
      prisma.platformAccountHours.aggregate({
        where: { platformAccount: { userId } },
        _sum: { hoursPlayed: true }
      }),
      prisma.refreshToken.count({
        where: { userId, isValid: true, expiresAt: { gt: now } }
      }),
      prisma.platformAccount.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          platform: true,
          displayName: true,
          createdAt: true,
          statsSyncedAt: true
        }
      })
    ])
  }
}
