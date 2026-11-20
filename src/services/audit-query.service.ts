import { AuditRepository } from '../repositories/audit.repository'
import { AUDIT_PAGE_SIZE, type AuditListQuery } from '../schemas/audit.schema'
import {
  BACKFILL_ACTIONS,
  SUSPEND_ACCOUNT_ACTION
} from '../utils/audit-actions'
import { buildAuditWhere } from '../utils/audit-where'
import { daysAgo, startOfBrasiliaDay } from '../utils/brasilia-time'

type AuditRow = Awaited<ReturnType<AuditRepository['findPage']>>[1][number]

function toItem(row: AuditRow) {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    action: row.action,
    area: row.area.toLowerCase(),
    target: row.target,
    detail: row.detail,
    result: row.result.toLowerCase(),
    ip: row.ip
  }
}

export class AuditQueryService {
  constructor(
    private auditRepository: AuditRepository = new AuditRepository()
  ) {}

  async list(query: AuditListQuery, now: Date = new Date()) {
    const where = buildAuditWhere({
      area: query.area,
      q: query.q,
      since: daysAgo(now, query.period)
    })

    const [total, rows] = await this.auditRepository.findPage(
      where,
      (query.page - 1) * AUDIT_PAGE_SIZE,
      AUDIT_PAGE_SIZE
    )

    return {
      items: rows.map(toItem),
      page: query.page,
      pageSize: AUDIT_PAGE_SIZE,
      total,
      period: query.period
    }
  }

  summary(now: Date = new Date()) {
    return this.auditRepository.summaryCounts({
      todayStart: startOfBrasiliaDay(now),
      weekStart: daysAgo(now, 7),
      backfillActions: BACKFILL_ACTIONS,
      suspendAction: SUSPEND_ACCOUNT_ACTION
    })
  }
}
