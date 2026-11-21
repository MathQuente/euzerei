import { Prisma } from '../database/prisma-client'
import { prisma } from '../database/db'
import { ClientError } from '../errors/client-error'
import { CreateUserDTO } from '../dtos/user.dto'
import { hashToken } from '../utils/hash-token'
import { termsAcceptance } from '../utils/terms'
import { isUniqueViolation } from '../utils/prisma-errors'
import { handlePrefix, uniqueHandle, toHandle } from '../utils/user-handle'
import type { OAuthProvider } from '../services/auth.service'

const MAX_SESSIONS_PER_USER = 10
const HANDLE_ATTEMPTS = 5

export class AuthRepository {
  /**
   * Cria a conta com um handle livre derivado do nome. Duas contas criadas ao
   * mesmo tempo podem escolher o mesmo handle: a restrição única do banco
   * recusa a segunda, que tenta de novo com a lista atualizada.
   */
  private async createWithHandle<T>(
    rawName: string | null | undefined,
    create: (handle: string) => Promise<T>
  ): Promise<T> {
    const base = toHandle(rawName)
    for (let attempt = 1; ; attempt++) {
      const rows = await prisma.user.findMany({
        where: { userName: { startsWith: handlePrefix(base) } },
        select: { userName: true }
      })
      const taken = new Set(rows.map(row => row.userName.toLowerCase()))
      const handle = uniqueHandle(rawName, h => taken.has(h))
      try {
        return await create(handle)
      } catch (error) {
        if (!isUniqueViolation(error) || attempt >= HANDLE_ATTEMPTS) throw error
      }
    }
  }

  private async persistToken(
    tx: Prisma.TransactionClient,
    token: string,
    userId: string,
    expiresAt: Date
  ) {
    await tx.refreshToken.deleteMany({
      where: {
        userId,
        OR: [{ isValid: false }, { expiresAt: { lt: new Date() } }]
      }
    })

    await tx.refreshToken.create({
      data: {
        tokenHash: hashToken(token),
        userId: userId,
        expiresAt: expiresAt,
        isValid: true
      }
    })

    const oldestBeyondLimit = await tx.refreshToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: MAX_SESSIONS_PER_USER,
      select: { id: true }
    })

    if (oldestBeyondLimit.length > 0) {
      await tx.refreshToken.deleteMany({
        where: { id: { in: oldestBeyondLimit.map(token => token.id) } }
      })
    }
  }

  async saveToken(token: string, userId: string, expiresAt: Date) {
    await prisma.$transaction(tx =>
      this.persistToken(tx, token, userId, expiresAt)
    )
  }

  async rotateToken(
    oldToken: string,
    newToken: string,
    userId: string,
    expiresAt: Date
  ) {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR SHARE`
      const { count } = await tx.refreshToken.updateMany({
        where: { tokenHash: hashToken(oldToken), isValid: true },
        data: { isValid: false }
      })

      if (count !== 1) {
        throw new ClientError('Sessão inválida ou expirada.', 401)
      }

      await this.persistToken(tx, newToken, userId, expiresAt)
    })
  }

  async findUserByGoogleId(googleId: string) {
    return prisma.user.findUnique({
      where: { googleId },
      select: { id: true, email: true, userName: true, profilePicture: true }
    })
  }

  async createUser(data: CreateUserDTO) {
    return this.createWithHandle(data.userName, userName =>
      prisma.user.create({
        data: {
          email: data.email,
          password: data.password,
          userName,
          ...(data.emailVerifiedAt && {
            emailVerifiedAt: data.emailVerifiedAt
          }),
          ...termsAcceptance()
        },
        select: {
          id: true
        }
      })
    )
  }

  async createUserWithGoogle(data: {
    email: string
    name: string
    picture: string
    googleId: string
    password: string
  }) {
    return this.createWithHandle(data.name, userName =>
      prisma.user.create({
        data: {
          email: data.email,
          userName,
          profilePicture: data.picture,
          googleId: data.googleId,
          password: data.password,
          hasPassword: false,
          emailVerifiedAt: new Date(),
          ...termsAcceptance()
        },
        select: { id: true, userName: true }
      })
    )
  }

  async findByEmail(email: string, includePassword = false) {
    return prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        userName: true,
        profilePicture: true,
        googleId: true,
        discordId: true,
        emailVerifiedAt: true,
        ...(includePassword ? { password: true } : {})
      }
    })
  }

  async findByDiscordId(discordId: string) {
    return prisma.user.findUnique({
      where: { discordId },
      select: {
        id: true,
        email: true,
        userName: true,
        profilePicture: true,
        googleId: true,
        discordId: true
      }
    })
  }

  async findById(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailVerifiedAt: true }
    })
  }

  async findProviderState(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        hasPassword: true,
        googleId: true,
        discordId: true
      }
    })
  }

  async attachProvider(
    userId: string,
    provider: OAuthProvider,
    providerId: string
  ) {
    const { count } = await prisma.user.updateMany({
      where:
        provider === 'google'
          ? { id: userId, googleId: null }
          : { id: userId, discordId: null },
      data:
        provider === 'google'
          ? { googleId: providerId }
          : { discordId: providerId }
    })
    return count === 1
  }

  async detachProviderKeepingAMethod(userId: string, provider: OAuthProvider) {
    const { count } = await prisma.user.updateMany({
      where:
        provider === 'google'
          ? {
              id: userId,
              googleId: { not: null },
              OR: [{ hasPassword: true }, { discordId: { not: null } }]
            }
          : {
              id: userId,
              discordId: { not: null },
              OR: [{ hasPassword: true }, { googleId: { not: null } }]
            },
      data: provider === 'google' ? { googleId: null } : { discordId: null }
    })
    return count === 1
  }

  async updateEmail(userId: string, email: string) {
    return prisma.user.update({
      where: { id: userId },
      data: { email, emailVerifiedAt: new Date() },
      select: { id: true }
    })
  }

  async markEmailVerified(userId: string) {
    await prisma.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() }
    })
  }

  async createWithDiscord(data: {
    email: string
    userName: string
    discordId: string
    password: string
    profilePicture: string | null
  }) {
    return this.createWithHandle(data.userName, userName =>
      prisma.user.create({
        data: {
          ...data,
          userName,
          hasPassword: false,
          emailVerifiedAt: new Date(),
          ...termsAcceptance()
        }
      })
    )
  }

  private async linkProvider(
    userId: string,
    data: Prisma.UserUpdateInput,
    discardedPasswordHash: string | null
  ) {
    return prisma.$transaction(async tx => {
      if (discardedPasswordHash) {
        await tx.user.update({
          where: { id: userId },
          data: { password: discardedPasswordHash, hasPassword: false }
        })
        await tx.refreshToken.deleteMany({ where: { userId } })
      }

      const user = await tx.user.update({ where: { id: userId }, data })

      await tx.user.updateMany({
        where: { id: userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: new Date() }
      })

      return user
    })
  }

  async linkGoogle(
    userId: string,
    googleId: string,
    picture: string | undefined,
    discardedPasswordHash: string | null
  ) {
    return this.linkProvider(
      userId,
      { googleId, ...(picture && { profilePicture: picture }) },
      discardedPasswordHash
    )
  }

  async linkDiscord(
    userId: string,
    discordId: string,
    profilePicture: string | null,
    discardedPasswordHash: string | null
  ) {
    return this.linkProvider(
      userId,
      { discordId, ...(profilePicture && { profilePicture }) },
      discardedPasswordHash
    )
  }

  async invalidateToken(token: string) {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(token) },
      data: { isValid: false }
    })
  }

  async deleteTokensByUserId(userId: string) {
    await prisma.refreshToken.deleteMany({ where: { userId } })
  }

  async findToken(token: string) {
    return prisma.refreshToken.findUnique({
      where: {
        tokenHash: hashToken(token)
      }
    })
  }

  async updatePassword(userId: string, hashedPassword: string) {
    return prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword, hasPassword: true },
      select: { email: true }
    })
  }

  async findPasswordState(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, password: true, hasPassword: true }
    })
  }
}
