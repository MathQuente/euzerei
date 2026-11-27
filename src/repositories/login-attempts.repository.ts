import { prisma } from '../database/db'
import type { LoginOutcome, LoginSource } from '../database/prisma-client'

export interface LoginAttemptInput {
  emailHash: string
  ipHash: string
  source: LoginSource
  outcome: LoginOutcome
}

export interface LoginHourRow {
  hour: Date
  total: number
  failed: number
}

export class LoginAttemptsRepository {
  async create(input: LoginAttemptInput) {
    await prisma.loginAttempt.create({ data: input })
  }

  /** As 24 horas cheias que terminam na hora de `now`, uma linha por hora (zero quando não houve tentativa). */
  async hours(now: Date): Promise<LoginHourRow[]> {
    const rows = await prisma.$queryRaw<
      { hour: Date; total: bigint; failed: bigint }[]
    >`
      SELECT h.hour AS hour,
             COUNT(a.id) AS total,
             COUNT(a.id) FILTER (WHERE a.outcome <> 'SUCCESS') AS failed
      FROM generate_series(
             date_trunc('hour', ${now}::timestamp) - interval '23 hours',
             date_trunc('hour', ${now}::timestamp),
             interval '1 hour'
           ) AS h(hour)
      LEFT JOIN login_attempts a
        ON a.created_at >= h.hour AND a.created_at < h.hour + interval '1 hour'
      GROUP BY h.hour
      ORDER BY h.hour`
    return rows.map(row => ({
      hour: new Date(`${row.hour.toISOString().slice(0, 13)}:00:00.000Z`),
      total: Number(row.total),
      failed: Number(row.failed)
    }))
  }

  async earliest(): Promise<Date | null> {
    const row = await prisma.loginAttempt.aggregate({
      _min: { createdAt: true }
    })
    return row._min.createdAt
  }

  /** Apaga no máximo `limit` linhas antigas por chamada: a tabela encolhe aos poucos, sem travar o banco. */
  async purgeBefore(before: Date, limit: number): Promise<number> {
    return prisma.$executeRaw`
      DELETE FROM login_attempts
      WHERE id IN (
        SELECT id FROM login_attempts WHERE created_at < ${before} LIMIT ${limit}
      )`
  }
}
