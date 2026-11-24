import { ClientError } from '../errors/client-error'
import { AdminUsersRepository } from '../repositories/admin-users.repository'
import {
  ADMIN_USERS_PAGE_SIZE,
  type AdminUsersListQuery
} from '../schemas/admin-users.schema'
import { buildAdminUsersWhere } from '../utils/admin-users-where'
import { daysAgo } from '../utils/brasilia-time'
import { TERMS_VERSION } from '../utils/terms'

type PageUser = Awaited<ReturnType<AdminUsersRepository['findPage']>>[1][number]

const LIBRARY_KEYS = [
  'PLAYED',
  'PLAYING',
  'PAUSED',
  'BACKLOG',
  'WISHLIST',
  'DROPPED'
] as const

function toItem(user: PageUser) {
  return {
    id: user.id,
    handle: user.userName,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    role: user.role.toLowerCase(),
    suspended: Boolean(user.suspendedAt),
    stores: [
      ...new Set(user.accounts.map(account => account.platform.toLowerCase()))
    ].sort(),
    games: user._count.userGames,
    lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
    termsAccepted: user.termsVersion === TERMS_VERSION
  }
}

export class AdminUsersService {
  constructor(
    private repository: AdminUsersRepository = new AdminUsersRepository()
  ) {}

  async list(query: AdminUsersListQuery) {
    const where = buildAdminUsersWhere({ q: query.q, filter: query.filter })

    const [total, users] = await this.repository.findPage(
      where,
      (query.page - 1) * ADMIN_USERS_PAGE_SIZE,
      ADMIN_USERS_PAGE_SIZE
    )

    return {
      items: users.map(user => toItem(user)),
      page: query.page,
      pageSize: ADMIN_USERS_PAGE_SIZE,
      total
    }
  }

  async summary(now: Date = new Date()) {
    const [total, active7d] = await this.repository.summaryCounts(
      daysAgo(now, 7)
    )
    return { total, active7d }
  }

  async detail(userId: string, now: Date = new Date()) {
    const [user, byStatus, statuses, hours, activeSessions, accounts] =
      await this.repository.findDetail(userId, now)

    if (!user) throw new ClientError('Usuário não encontrado.', 404)

    const statusById = new Map(statuses.map(s => [s.id, s.status]))
    const library = Object.fromEntries(
      LIBRARY_KEYS.map(key => [key.toLowerCase(), 0])
    ) as Record<Lowercase<(typeof LIBRARY_KEYS)[number]>, number>
    let total = 0
    for (const row of byStatus) {
      const status = statusById.get(row.userGamesStatusId)
      const count = row._count.id
      total += count
      if (status) library[status.toLowerCase() as keyof typeof library] += count
    }

    return {
      id: user.id,
      handle: user.userName,
      email: user.email,
      role: user.role.toLowerCase(),
      suspended: Boolean(user.suspendedAt),
      suspendedAt: user.suspendedAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
      emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
      lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
      login: {
        hasPassword: user.hasPassword,
        hasGoogle: user.googleId !== null,
        hasDiscord: user.discordId !== null
      },
      terms: {
        acceptedAt: user.termsAcceptedAt?.toISOString() ?? null,
        version: user.termsVersion,
        current: user.termsVersion === TERMS_VERSION
      },
      library: { total, ...library },
      hours: Math.round(Number(hours._sum.hoursPlayed ?? 0) * 10) / 10,
      sessions: { active: activeSessions },
      accounts: accounts.map(account => ({
        platform: account.platform.toLowerCase(),
        displayName: account.displayName,
        createdAt: account.createdAt.toISOString(),
        syncedAt: account.statsSyncedAt?.toISOString() ?? null
      }))
    }
  }
}
