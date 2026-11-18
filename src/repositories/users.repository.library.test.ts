import { describe, it, expect, vi, beforeEach } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  userGame: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    create: vi.fn()
  }
}))

vi.mock('../database/db', () => ({ prisma: prismaMock }))

import { UserRepository } from './users.repository'

type SqlCall = { sql: string; values: unknown[] }

function lastQuery(): SqlCall {
  const calls = prismaMock.$queryRaw.mock.calls
  return calls[calls.length - 1][0] as SqlCall
}

describe('UserRepository.findManyGamesOfUser preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.$queryRaw.mockResolvedValue([])
  })

  it('ranks the games inside each status and keeps the first N of each', async () => {
    await new UserRepository().findManyGamesOfUser({
      userId: 'user-1',
      previewPerStatus: 24
    })

    const { sql, values } = lastQuery()
    expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY ugs.status ORDER BY')
    expect(sql).toContain('ug.id) AS rn')
    expect(sql).toContain('WHERE ranked.rn <= ')
    expect(values).toContain(24)
  })

  it('keeps every game of the statuses that must not be cut', async () => {
    await new UserRepository().findManyGamesOfUser({
      userId: 'user-1',
      previewPerStatus: 24,
      uncappedStatuses: ['PLAYING']
    })

    const { sql, values } = lastQuery()
    expect(sql).toContain('OR ranked."status"::text IN (')
    expect(values).toContain('PLAYING')
  })

  it('adds no exception when every status is capped', async () => {
    await new UserRepository().findManyGamesOfUser({
      userId: 'user-1',
      previewPerStatus: 24
    })

    expect(lastQuery().sql).not.toContain('OR ranked')
  })

  it('selects named columns from the ranked rows, so rn never reaches the result', async () => {
    await new UserRepository().findManyGamesOfUser({
      userId: 'user-1',
      previewPerStatus: 6
    })

    const { sql } = lastQuery()
    expect(sql).toContain('ranked."igdbId"')
    expect(sql).not.toMatch(/SELECT\s+ranked\.\*/)
    expect(sql).not.toMatch(/SELECT\s+\*/)
  })

  it('ignores the preview when the caller also paginates', async () => {
    await new UserRepository().findManyGamesOfUser({
      userId: 'user-1',
      previewPerStatus: 24,
      take: 48,
      skip: 0
    })

    expect(lastQuery().sql).not.toContain('ROW_NUMBER')
  })

  it('does not rank anything without a preview', async () => {
    await new UserRepository().findManyGamesOfUser({ userId: 'user-1' })

    expect(lastQuery().sql).not.toContain('ROW_NUMBER')
  })

  it('breaks ties by id in the plain query too, so pages stay stable', async () => {
    await new UserRepository().findManyGamesOfUser({
      userId: 'user-1',
      filter: 'PLAYED',
      take: 48,
      skip: 0
    })

    expect(lastQuery().sql).toMatch(/ORDER BY [\s\S]*, ug\.id\s+LIMIT/)
  })
})

describe('UserRepository.findLibraryIgdbIds', () => {
  it('returns the igdb id of every game of the user, whatever the status', async () => {
    prismaMock.userGame.findMany.mockResolvedValue([
      { igdbId: 1 },
      { igdbId: 5 }
    ])

    const ids = await new UserRepository().findLibraryIgdbIds('user-1')

    expect(prismaMock.userGame.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      select: { igdbId: true }
    })
    expect(ids).toEqual([1, 5])
  })
})

describe('UserRepository.setAccountConsole', () => {
  it('only updates an account of that user and platform, and reports whether one was found', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    ;(prismaMock as unknown as { platformAccount: unknown }).platformAccount = {
      updateMany
    }

    const found = await new UserRepository().setAccountConsole(
      'user-1',
      'acc-1',
      'XBOX',
      'XBOX_SERIES'
    )

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'acc-1', userId: 'user-1', platform: 'XBOX' },
      data: { preferredConsole: 'XBOX_SERIES' }
    })
    expect(found).toBe(true)
  })

  it('reports false when no account matches', async () => {
    ;(prismaMock as unknown as { platformAccount: unknown }).platformAccount = {
      updateMany: vi.fn().mockResolvedValue({ count: 0 })
    }

    expect(
      await new UserRepository().setAccountConsole('user-1', 'x', 'XBOX', null)
    ).toBe(false)
  })

  it('orders a wishlist game by when it was added even when sorting by finish date', async () => {
    await new UserRepository().findManyGamesOfUser({
      userId: 'user-1',
      previewPerStatus: 8,
      sortBy: 'completedAt',
      sortOrder: 'desc'
    })

    const { sql } = lastQuery()
    expect(sql).toContain(
      "CASE WHEN ugs.status = 'WISHLIST' THEN ug.created_at ELSE COALESCE(ug.completed_at, ug.updated_at) END DESC"
    )
  })
})

describe('UserRepository sort by dropped date', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.$queryRaw.mockResolvedValue([])
  })

  it('orders by when the game was dropped, falling back to the last edit and to the added date', async () => {
    await new UserRepository().findManyGamesOfUser({
      userId: 'user-1',
      previewPerStatus: 8,
      sortBy: 'droppedAt',
      sortOrder: 'desc'
    })

    expect(lastQuery().sql).toContain(
      "CASE WHEN ugs.status = 'DROPPED' THEN COALESCE(ug.dropped_at, ug.updated_at) ELSE ug.created_at END DESC"
    )
  })
})

describe('UserRepository dropped date', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.userGame.update.mockResolvedValue({ igdbId: 1 })
    prismaMock.userGame.create.mockResolvedValue({ igdbId: 1 })
  })

  it('selects the dropped date in the list, also through the ranked preview', async () => {
    await new UserRepository().findManyGamesOfUser({
      userId: 'user-1',
      previewPerStatus: 24
    })

    const { sql } = lastQuery()
    expect(sql).toContain('ug.dropped_at')
    expect(sql).toContain('ranked."droppedAt"')
  })

  it('stamps the date when a game moves into Larguei', async () => {
    prismaMock.userGame.findUnique.mockResolvedValue({ userGamesStatusId: 3 })

    await new UserRepository().updateGameStatus(1, 'user-1', 6)

    const data = prismaMock.userGame.update.mock.calls[0][0].data
    expect(data.droppedAt).toBeInstanceOf(Date)
  })

  it('keeps the old date when the game is already in Larguei', async () => {
    prismaMock.userGame.findUnique.mockResolvedValue({ userGamesStatusId: 6 })

    await new UserRepository().updateGameStatus(1, 'user-1', 6)

    const data = prismaMock.userGame.update.mock.calls[0][0].data
    expect(data.droppedAt).toBeUndefined()
  })

  it('does not read the game or touch the date for a status other than Larguei', async () => {
    await new UserRepository().updateGameStatus(1, 'user-1', 3)

    expect(prismaMock.userGame.findUnique).not.toHaveBeenCalled()
    expect(
      prismaMock.userGame.update.mock.calls[0][0].data.droppedAt
    ).toBeUndefined()
  })

  it('stamps the date on a game created already dropped, and only then', async () => {
    const repository = new UserRepository()

    await repository.addGameToUserLibrary({
      igdbId: 1,
      userId: 'user-1',
      statusIds: 6
    })
    await repository.addGameToUserLibrary({
      igdbId: 2,
      userId: 'user-1',
      statusIds: 4
    })

    const [dropped, backlog] = prismaMock.userGame.create.mock.calls.map(
      call => call[0].data
    )
    expect(dropped.droppedAt).toBeInstanceOf(Date)
    expect(backlog.droppedAt).toBeUndefined()
  })
})
