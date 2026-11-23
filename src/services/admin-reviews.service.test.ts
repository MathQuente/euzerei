import { describe, expect, it, vi } from 'vitest'
import { AdminReviewsRepository } from '../repositories/admin-reviews.repository'
import { AdminReviewsService, statusOf } from './admin-reviews.service'

function build(repo: Partial<Record<keyof AdminReviewsRepository, unknown>>) {
  return new AdminReviewsService(repo as unknown as AdminReviewsRepository)
}

const T = (iso: string) => new Date(iso)

const row = (over: Record<string, unknown> = {}) => ({
  id: 'rv-1',
  excerpt: 'Esse jogo é…',
  igdbId: 7,
  gameName: 'Hades II',
  handle: 'anon_9',
  hiddenAt: null,
  totalReports: 2,
  openReports: 2,
  mainReason: 'OFFENSE',
  oldestOpenAt: T('2026-11-20T10:00:00Z'),
  lastResolvedAt: null,
  lastActivityAt: T('2026-11-21T10:00:00Z'),
  editedAfterReport: false,
  ...over
})

describe('statusOf', () => {
  it('oculta vale mais que aberta, e aberta mais que resolvida (nunca o último resolution)', () => {
    expect(statusOf(T('2026-11-20T00:00:00Z'), 3)).toBe('hidden')
    expect(statusOf(null, 1)).toBe('open')
    expect(statusOf(null, 0)).toBe('resolved')
  })
})

describe('AdminReviewsService.list', () => {
  it('maps a row to the contract and never carries ids of people', async () => {
    const findQueue = vi.fn().mockResolvedValue([
      1,
      [
        row({
          excerpt: 'Esse jogo   é\num lixo e quem joga é burro. '.padEnd(
            400,
            'x'
          ),
          editedAfterReport: true
        })
      ]
    ])

    const result = await build({ findQueue }).list({
      status: 'open',
      page: 2,
      limit: 20
    })

    expect(findQueue).toHaveBeenCalledWith('open', undefined, 20, 20)
    expect(result).toMatchObject({ page: 2, pageSize: 20, total: 1 })
    const [item] = result.items
    expect(item.excerpt.length).toBeLessThanOrEqual(121)
    expect(item.excerpt.endsWith('…')).toBe(true)
    expect(item.excerpt).not.toMatch(/\s{2}|\n/)
    expect(item).toMatchObject({
      id: 'rv-1',
      handle: 'anon_9',
      game: { igdbId: 7, name: 'Hades II' },
      status: 'open',
      openReports: 2,
      totalReports: 2,
      mainReason: 'offense',
      since: '2026-11-20T10:00:00.000Z',
      editedAfterReport: true
    })
    expect(Object.keys(item).sort()).toEqual(
      [
        'editedAfterReport',
        'excerpt',
        'game',
        'handle',
        'id',
        'mainReason',
        'openReports',
        'since',
        'status',
        'totalReports'
      ].sort()
    )
  })

  it('usa o limite pedido para o deslocamento e o tamanho da página', async () => {
    const findQueue = vi.fn().mockResolvedValue([0, []])

    const result = await build({ findQueue }).list({
      status: 'all',
      page: 3,
      limit: 50
    })

    expect(findQueue).toHaveBeenCalledWith('all', undefined, 100, 50)
    expect(result.pageSize).toBe(50)
  })

  it('a idade "since" segue o estado: denúncia aberta, decisão ou o momento em que foi ocultada', async () => {
    const hidden = row({
      hiddenAt: T('2026-11-22T00:00:00Z'),
      openReports: 0,
      oldestOpenAt: null,
      lastResolvedAt: T('2026-11-22T00:00:00Z')
    })
    const resolved = row({
      id: 'rv-2',
      openReports: 0,
      oldestOpenAt: null,
      lastResolvedAt: T('2026-11-21T12:00:00Z')
    })
    const bare = row({
      id: 'rv-3',
      hiddenAt: T('2026-11-19T00:00:00Z'),
      totalReports: 0,
      openReports: 0,
      oldestOpenAt: null,
      lastResolvedAt: null,
      mainReason: null,
      lastActivityAt: T('2026-11-19T00:00:00Z')
    })
    const findQueue = vi.fn().mockResolvedValue([3, [hidden, resolved, bare]])

    const { items } = await build({ findQueue }).list({
      status: 'all',
      page: 1,
      limit: 20
    })

    expect(items.map(i => [i.status, i.since])).toEqual([
      ['hidden', '2026-11-22T00:00:00.000Z'],
      ['resolved', '2026-11-21T12:00:00.000Z'],
      ['hidden', '2026-11-19T00:00:00.000Z']
    ])
    expect(items[2].mainReason).toBeNull()
  })

  it('jogo fora do cache vira nome nulo', async () => {
    const findQueue = vi
      .fn()
      .mockResolvedValue([1, [row({ gameName: null, excerpt: 'curto' })]])

    const { items } = await build({ findQueue }).list({
      status: 'open',
      page: 1,
      limit: 20
    })

    expect(items[0].excerpt).toBe('curto')
    expect(items[0].game.name).toBeNull()
  })
})

describe('AdminReviewsService.summary', () => {
  it('conta uma semana e 30 dias para trás e arredonda os dias de decisão', async () => {
    const summaryCounts = vi.fn().mockResolvedValue({
      counts: [
        6,
        4,
        { _min: { createdAt: T('2026-11-20T00:00:00Z') } },
        3870,
        64,
        41
      ],
      decisionDays: 1.2345
    })

    const result = await build({ summaryCounts }).summary(
      T('2026-11-23T12:00:00Z')
    )

    expect(summaryCounts).toHaveBeenCalledWith(
      T('2026-11-16T12:00:00Z'),
      T('2026-10-24T12:00:00Z')
    )
    expect(result).toEqual({
      openReports: 6,
      openReviews: 4,
      oldestOpenAt: '2026-11-20T00:00:00.000Z',
      published: 3870,
      published7d: 64,
      hidden: 41,
      decisionDays: 1.2
    })
  })

  it('sem denúncia aberta nem decisão: datas e dias nulos', async () => {
    const summaryCounts = vi.fn().mockResolvedValue({
      counts: [0, 0, { _min: { createdAt: null } }, 10, 0, 0],
      decisionDays: null
    })

    const result = await build({ summaryCounts }).summary()

    expect(result.oldestOpenAt).toBeNull()
    expect(result.decisionDays).toBeNull()
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
      hiddenAt: null,
      user: {
        id: 'u-1',
        userName: 'anon_9',
        role: 'USER',
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

    expect(result.status).toBe('open')
    expect(result.hiddenAt).toBeNull()
    expect(result.text).toBe('<b>texto</b> cru')
    expect(result.rating).toBe(1.5)
    expect(result.reports.map(r => r.reporter)).toEqual(['lari_g', null])
    expect(result.reports.map(r => r.editedAfter)).toEqual([true, false])
    expect(result.author).toEqual({
      id: 'u-1',
      handle: 'anon_9',
      admin: false,
      createdAt: '2026-11-01T00:00:00.000Z',
      suspended: false,
      reviews: 5,
      reviewsReported: 2
    })
    expect(JSON.stringify(result)).not.toMatch(/email|password|token/i)
  })

  it('uma review oculta é "hidden" mesmo com as denúncias já fechadas, e o autor admin é marcado', async () => {
    const hidden = {
      ...found,
      review: {
        ...found.review,
        hiddenAt: T('2026-11-22T10:00:00Z'),
        user: { ...found.review.user, role: 'ADMIN' },
        reports: found.review.reports.map(r => ({
          ...r,
          resolvedAt: T('2026-11-22T10:00:00Z'),
          resolution: 'HIDDEN'
        }))
      }
    }

    const result = await build({
      findDetail: vi.fn().mockResolvedValue(hidden)
    }).detail('rv-1')

    expect(result.status).toBe('hidden')
    expect(result.hiddenAt).toBe('2026-11-22T10:00:00.000Z')
    expect(result.author.admin).toBe(true)
    expect(result.reports[0]).toMatchObject({
      resolution: 'hidden',
      resolvedAt: '2026-11-22T10:00:00.000Z'
    })
  })

  it('uma review sem denúncia aberta e visível é "resolved"', async () => {
    const result = await build({
      findDetail: vi.fn().mockResolvedValue({
        ...found,
        review: {
          ...found.review,
          reports: found.review.reports.map(r => ({
            ...r,
            resolvedAt: T('2026-11-22T10:00:00Z'),
            resolution: 'DISMISSED'
          }))
        }
      })
    }).detail('rv-1')

    expect(result.status).toBe('resolved')
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
