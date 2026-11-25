import { prisma } from '../database/db'
import type { ImportRunStatus } from '../database/prisma-client'
import { isForeignKeyViolation } from '../utils/prisma-errors'

export interface ImportRunInput {
  store: string
  userId: string | null
  ref: string
  status: ImportRunStatus
  attempts: number
  games: number | null
  error: string | null
  startedAt: Date
  finishedAt: Date
}

export interface ImportRunsTotals {
  store: string
  total: number
  done: number
  warning: number
  failed: number
  avgDurationMs: number | null
}

export class ImportRunsRepository {
  async create(input: ImportRunInput) {
    try {
      await prisma.importRun.create({ data: input })
    } catch (error) {
      // A conta pode ter sido excluída com a importação em andamento: a execução ainda conta.
      if (input.userId !== null && isForeignKeyViolation(error)) {
        await prisma.importRun.create({ data: { ...input, userId: null } })
        return
      }
      throw error
    }
  }

  async totalsSince(since: Date): Promise<ImportRunsTotals[]> {
    const rows = await prisma.$queryRaw<
      {
        store: string
        total: bigint
        done: bigint
        warning: bigint
        failed: bigint
        avg_ms: number | null
      }[]
    >`
      SELECT store,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status = 'DONE') AS done,
             COUNT(*) FILTER (WHERE status = 'WARNING') AS warning,
             COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
             AVG(EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)
               FILTER (WHERE status <> 'FAILED') AS avg_ms
      FROM import_runs
      WHERE finished_at >= ${since}
      GROUP BY store`
    return rows.map(row => ({
      store: row.store,
      total: Number(row.total),
      done: Number(row.done),
      warning: Number(row.warning),
      failed: Number(row.failed),
      avgDurationMs: row.avg_ms === null ? null : Math.round(Number(row.avg_ms))
    }))
  }

  /** Quando o histórico começa: sem isso, um período maior que o histórico parece "poucas importações". */
  async earliest(): Promise<Date | null> {
    const row = await prisma.importRun.aggregate({
      _min: { finishedAt: true }
    })
    return row._min.finishedAt
  }
}
