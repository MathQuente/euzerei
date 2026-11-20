import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditQueryService } from './audit-query.service'
import { AUDIT_PAGE_SIZE, AuditListQuerySchema } from '../schemas/audit.schema'
import {
  BACKFILL_ACTIONS,
  SUSPEND_ACCOUNT_ACTION
} from '../utils/audit-actions'
import type { AuditRepository } from '../repositories/audit.repository'

const repository = { findPage: vi.fn(), summaryCounts: vi.fn() }
const service = new AuditQueryService(repository as unknown as AuditRepository)

const NOW = new Date('2026-11-20T14:00:00Z')

const query = (raw: Record<string, string> = {}) =>
  AuditListQuerySchema.parse(raw)

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    createdAt: new Date('2026-11-20T11:48:00Z'),
    action: 'Entrou no painel',
    area: 'SYSTEM',
    target: '@dono',
    detail: null,
    result: 'OK',
    ip: '187.20.14.9',
    ...overrides
  }
}

beforeEach(() => {
  repository.findPage.mockReset().mockResolvedValue([0, []])
  repository.summaryCounts.mockReset().mockResolvedValue({
    actionsToday: 1,
    actionsLast7Days: 2,
    backfillsToday: 0,
    suspensionsLast7Days: 0,
    failuresLast7Days: 0
  })
})

describe('AuditQueryService.list', () => {
  it('reads the page with the fixed size and the offset of the requested page', async () => {
    await service.list(query({ page: '3' }), NOW)

    expect(repository.findPage).toHaveBeenCalledWith(
      expect.any(Object),
      2 * AUDIT_PAGE_SIZE,
      AUDIT_PAGE_SIZE
    )
  })

  it('limits the period counting back from now: 7 days by default', async () => {
    await service.list(query(), NOW)

    const where = repository.findPage.mock.calls[0][0]
    expect(where.createdAt.gte.toISOString()).toBe('2026-11-13T14:00:00.000Z')
  })

  it.each([
    ['30', '2026-10-21T14:00:00.000Z'],
    ['90', '2026-08-22T14:00:00.000Z']
  ])('period %s days', async (period, since) => {
    await service.list(query({ period }), NOW)

    expect(
      repository.findPage.mock.calls[0][0].createdAt.gte.toISOString()
    ).toBe(since)
  })

  it('passes the area and the search to the where clause', async () => {
    await service.list(query({ area: 'catalog', q: 'capas' }), NOW)

    const where = repository.findPage.mock.calls[0][0]
    expect(where.area).toBe('CATALOG')
    expect(where.OR).toHaveLength(3)
  })

  it('answers the total, the page, the size and the period next to the items', async () => {
    repository.findPage.mockResolvedValue([41, [row()]])

    const result = await service.list(query({ page: '2', period: '30' }), NOW)

    expect(result).toMatchObject({
      total: 41,
      page: 2,
      pageSize: AUDIT_PAGE_SIZE,
      period: 30
    })
    expect(result.items).toHaveLength(1)
  })

  it('shapes an item: ISO date, lower case area and result, nulls kept as null', async () => {
    repository.findPage.mockResolvedValue([
      1,
      [
        row({
          area: 'CATALOG',
          result: 'FAILED',
          target: null,
          detail: null,
          ip: null
        })
      ]
    ])

    const { items } = await service.list(query(), NOW)

    expect(items[0]).toEqual({
      id: 'a1',
      createdAt: '2026-11-20T11:48:00.000Z',
      action: 'Entrou no painel',
      area: 'catalog',
      target: null,
      detail: null,
      result: 'failed',
      ip: null
    })
  })

  it('does not expose the actor or anything beyond the listed fields', async () => {
    repository.findPage.mockResolvedValue([1, [row({ actorId: 'secret-id' })]])

    const { items } = await service.list(query(), NOW)

    expect(Object.keys(items[0]).sort()).toEqual([
      'action',
      'area',
      'createdAt',
      'detail',
      'id',
      'ip',
      'result',
      'target'
    ])
  })

  it('an empty period answers an empty list with total 0', async () => {
    await expect(service.list(query(), NOW)).resolves.toMatchObject({
      items: [],
      total: 0
    })
  })
})

describe('AuditQueryService.summary', () => {
  it('counts "today" from midnight in Brasília and the week as a rolling 7 days', async () => {
    await service.summary(NOW)

    const args = repository.summaryCounts.mock.calls[0][0]
    expect(args.todayStart.toISOString()).toBe('2026-11-20T03:00:00.000Z')
    expect(args.weekStart.toISOString()).toBe('2026-11-13T14:00:00.000Z')
  })

  it('late in the evening in Brasília, today still started at 03:00 UTC of the same date', async () => {
    await service.summary(new Date('2026-11-21T01:30:00Z'))

    expect(
      repository.summaryCounts.mock.calls[0][0].todayStart.toISOString()
    ).toBe('2026-11-20T03:00:00.000Z')
  })

  it('counts backfills and suspensions by the exact action names, never by text search', async () => {
    await service.summary(NOW)

    const args = repository.summaryCounts.mock.calls[0][0]
    expect(args.backfillActions).toBe(BACKFILL_ACTIONS)
    expect(args.suspendAction).toBe(SUSPEND_ACCOUNT_ACTION)
  })

  it('answers what the repository counted', async () => {
    repository.summaryCounts.mockResolvedValue({
      actionsToday: 12,
      actionsLast7Days: 41,
      backfillsToday: 3,
      suspensionsLast7Days: 1,
      failuresLast7Days: 0
    })

    await expect(service.summary(NOW)).resolves.toEqual({
      actionsToday: 12,
      actionsLast7Days: 41,
      backfillsToday: 3,
      suspensionsLast7Days: 1,
      failuresLast7Days: 0
    })
  })
})
