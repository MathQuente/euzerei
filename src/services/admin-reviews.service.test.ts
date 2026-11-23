import { describe, expect, it, vi } from 'vitest'
import { AdminReviewsRepository } from '../repositories/admin-reviews.repository'
import { AdminReviewsService } from './admin-reviews.service'

function build(repo: Partial<Record<keyof AdminReviewsRepository, unknown>>) {
  return new AdminReviewsService(repo as unknown as AdminReviewsRepository)
}

const T = (iso: string) => new Date(iso)

describe('AdminReviewsService.list', () => {
  it('maps a row to the contract and never carries ids of people', async () => {
    const findQueue = vi.fn().mockResolvedValue([
      1,
      [
        {
          id: 'rv-1',
          excerpt: 'Esse jogo   é\num lixo e quem joga é burro. '.padEnd(
            400,
            'x'
          ),
          igdbId: 7,
          gameName: 'Hades II',
          handle: 'anon_9',
          openReports: 2,
          mainReason: 'OFFENSE',
          oldestOpenAt: T('2026-11-20T10:00:00Z'),
          lastReportAt: T('2026-11-21T10:00:00Z'),
          editedAfterReport: true
        }
      ]
    ])

    const result = await build({ findQueue }).list({ status: 'open', page: 2 })

    expect(findQueue).toHaveBeenCalledWith('open', undefined, 20, 20)
    expect(result.total).toBe(1)
    const [item] = result.items
    expect(item.excerpt.length).toBeLessThanOrEqual(121)
    expect(item.excerpt.endsWith('…')).toBe(true)
    expect(item.excerpt).not.toMatch(/\s{2}|\n/)
    expect(item).toMatchObject({
      id: 'rv-1',
      handle: 'anon_9',
      game: { igdbId: 7, name: 'Hades II' },
      openReports: 2,
      mainReason: 'offense',
      oldestOpenAt: '2026-11-20T10:00:00.000Z',
      editedAfterReport: true
    })
    expect(Object.keys(item).sort()).toEqual(
      [
        'editedAfterReport',
        'excerpt',
        'game',
        'handle',
        'id',
        'lastReportAt',
        'mainReason',
        'oldestOpenAt',
        'openReports'
      ].sort()
    )
  })

  it('keeps a short text whole and a game that left the cache as null', async () => {
    const findQueue = vi.fn().mockResolvedValue([
      1,
      [
        {
          id: 'rv-2',
          excerpt: 'curto',
          igdbId: 9,
          gameName: null,
          handle: 'x',
          openReports: 1,
          mainReason: null,
          oldestOpenAt: null,
          lastReportAt: T('2026-11-21T10:00:00Z'),
          editedAfterReport: false
        }
      ]
    ])

    const { items } = await build({ findQueue }).list({
      status: 'all',
      page: 1
    })

    expect(items[0].excerpt).toBe('curto')
    expect(items[0].game.name).toBeNull()
    expect(items[0].oldestOpenAt).toBeNull()
  })
})

describe('AdminReviewsService.summary', () => {
  it('counts a week back and leaves the moderation figures empty', async () => {
    const summaryCounts = vi
      .fn()
      .mockResolvedValue([
        6,
        4,
        { _min: { createdAt: T('2026-11-20T00:00:00Z') } },
        3870,
        64
      ])

    const result = await build({ summaryCounts }).summary(
      T('2026-11-23T12:00:00Z')
    )

    expect(summaryCounts.mock.calls[0][0]).toEqual(T('2026-11-16T12:00:00Z'))
    expect(result).toEqual({
      openReports: 6,
      openReviews: 4,
      oldestOpenAt: '2026-11-20T00:00:00.000Z',
      published: 3870,
      published7d: 64,
      hidden: null,
      decisionDays: null
    })
  })

  it('has no oldest date when nothing is open', async () => {
    const summaryCounts = vi
      .fn()
      .mockResolvedValue([0, 0, { _min: { createdAt: null } }, 10, 0])

    const result = await build({ summaryCounts }).summary()

    expect(result.oldestOpenAt).toBeNull()
  })
})

describe('AdminReviewsService.detail', () => {
  const found = {
    review: {
      id: 'rv-1',
      text: '<b>texto</b> cru',
      igdbId: 7,
      createdAt: T('2026-11-10T00:00:00Z'),
      updatedAt: T('2026-11-21T00:00:00Z'),
      user: {
        id: 'u-1',
        userName: 'anon_9',
        createdAt: T('2026-11-01T00:00:00Z'),
        suspendedAt: null
      },
      reports: [
        {
          reason: 'OFFENSE',
          createdAt: T('2026-11-20T00:00:00Z'),
          reviewUpdatedAt: T('2026-11-10T00:00:00Z'),
          resolvedAt: null,
          resolution: null,
          reporter: { userName: 'lari_g' }
        },
        {
          reason: 'SPAM',
          createdAt: T('2026-11-22T00:00:00Z'),
          reviewUpdatedAt: T('2026-11-21T00:00:00Z'),
          resolvedAt: null,
          resolution: null,
          reporter: null
        }
      ]
    },
    game: { name: 'Hades II' },
    rating: { value: 1.5 },
    reviewsTotal: 5,
    reviewsReported: 2
  }

  it('answers the detail, flags an edit made after a report and a reporter who left', async () => {
    const result = await build({
      findDetail: vi.fn().mockResolvedValue(found)
    }).detail('rv-1')

    expect(result.text).toBe('<b>texto</b> cru')
    expect(result.rating).toBe(1.5)
    expect(result.reports.map(r => r.reporter)).toEqual(['lari_g', null])
    expect(result.reports.map(r => r.editedAfter)).toEqual([true, false])
    expect(result.author).toEqual({
      id: 'u-1',
      handle: 'anon_9',
      createdAt: '2026-11-01T00:00:00.000Z',
      suspended: false,
      reviews: 5,
      reviewsReported: 2
    })
    expect(JSON.stringify(result)).not.toMatch(/email|password|token/i)
  })

  it('has a null rating and game name when there is none', async () => {
    const result = await build({
      findDetail: vi
        .fn()
        .mockResolvedValue({ ...found, game: null, rating: null })
    }).detail('rv-1')

    expect(result.rating).toBeNull()
    expect(result.game.name).toBeNull()
  })

  it('answers 404 when the review does not exist', async () => {
    await expect(
      build({ findDetail: vi.fn().mockResolvedValue(null) }).detail('x')
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})
