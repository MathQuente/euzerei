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
}
