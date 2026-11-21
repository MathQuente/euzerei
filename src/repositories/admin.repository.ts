import { prisma } from '../database/db'

export class AdminRepository {
  findById(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        userName: true,
        email: true,
        role: true,
        password: true
      }
    })
  }

  async findHandles(userIds: string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map()
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, userName: true }
    })
    return new Map(users.map(user => [user.id, user.userName]))
  }
}
