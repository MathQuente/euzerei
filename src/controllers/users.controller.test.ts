import { describe, it, expect, vi } from 'vitest'
import { FastifyReply, FastifyRequest } from 'fastify'
import { UserController } from './users.controller'
import { UserService } from '../services/users.service'
import { CacheRepository } from '../repositories/cache.repository'

function fakeReply() {
  const reply = {
    status: vi.fn(() => reply),
    send: vi.fn(() => reply),
    clearCookie: vi.fn(() => reply)
  }
  return reply as unknown as FastifyReply & {
    status: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
    clearCookie: ReturnType<typeof vi.fn>
  }
}

function fakeRequest(idempotencyKey?: string) {
  return {
    params: { igdbId: '10' },
    body: { incrementValue: 1 },
    user: { userId: 'user-1' },
    headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}
  } as unknown as FastifyRequest
}

function setup(cacheOverrides: Partial<CacheRepository> = {}) {
  const updateUserGamePlayedCount = vi
    .fn()
    .mockResolvedValue({ playedCount: 3 })
  const cache = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setIfAbsent: vi.fn().mockResolvedValue(true),
    del: vi.fn().mockResolvedValue(undefined),
    ...cacheOverrides
  } as unknown as CacheRepository
  const controller = new UserController(
    { updateUserGamePlayedCount } as unknown as UserService,
    cache
  )
  return { controller, cache, updateUserGamePlayedCount }
}

describe('UserController.updateUserGamePlayedCount', () => {
  it('applies the change and remembers the result under the idempotency key', async () => {
    const { controller, cache, updateUserGamePlayedCount } = setup()
    const reply = fakeReply()

    await controller.updateUserGamePlayedCount(fakeRequest('key-12345'), reply)

    expect(updateUserGamePlayedCount).toHaveBeenCalledTimes(1)
    expect(cache.set).toHaveBeenCalledWith(
      'idempotency:user-1:played-count:10:key-12345',
      { playedCount: 3 },
      expect.any(Number)
    )
    expect(reply.send).toHaveBeenCalledWith({ playedCount: 3 })
  })

  it('returns the remembered result without applying a repeated request', async () => {
    const { controller, updateUserGamePlayedCount } = setup({
      setIfAbsent: vi.fn().mockResolvedValue(false),
      get: vi.fn().mockResolvedValue({ playedCount: 3 })
    })
    const reply = fakeReply()

    await controller.updateUserGamePlayedCount(fakeRequest('key-12345'), reply)

    expect(updateUserGamePlayedCount).not.toHaveBeenCalled()
    expect(reply.send).toHaveBeenCalledWith({ playedCount: 3 })
  })

  it('rejects a repeated request while the first is still running', async () => {
    const { controller, updateUserGamePlayedCount } = setup({
      setIfAbsent: vi.fn().mockResolvedValue(false),
      get: vi.fn().mockResolvedValue('pending')
    })

    await expect(
      controller.updateUserGamePlayedCount(
        fakeRequest('key-12345'),
        fakeReply()
      )
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(updateUserGamePlayedCount).not.toHaveBeenCalled()
  })

  it('applies the change normally when no key is sent', async () => {
    const { controller, cache, updateUserGamePlayedCount } = setup()

    await controller.updateUserGamePlayedCount(fakeRequest(), fakeReply())

    expect(updateUserGamePlayedCount).toHaveBeenCalledTimes(1)
    expect(cache.setIfAbsent).not.toHaveBeenCalled()
  })
})

describe('UserController.deleteUser', () => {
  it('deletes the account and clears the auth cookies', async () => {
    const deleted = { id: 'user-1', userName: 'someone' }
    const deleteUser = vi.fn().mockResolvedValue({ user: deleted })
    const controller = new UserController({
      delete: deleteUser
    } as unknown as UserService)
    const reply = fakeReply()

    await controller.deleteUser(fakeRequest(), reply)

    expect(deleteUser).toHaveBeenCalledWith('user-1')
    expect(reply.clearCookie).toHaveBeenCalledWith(
      'accessToken',
      expect.objectContaining({ httpOnly: true })
    )
    expect(reply.clearCookie).toHaveBeenCalledWith(
      'refreshToken',
      expect.objectContaining({ httpOnly: true })
    )
    expect(reply.status).toHaveBeenCalledWith(200)
    expect(reply.send).toHaveBeenCalledWith({ user: deleted })
  })

  it('does not clear cookies when the deletion fails', async () => {
    const controller = new UserController({
      delete: vi.fn().mockRejectedValue(new Error('not found'))
    } as unknown as UserService)
    const reply = fakeReply()

    await expect(controller.deleteUser(fakeRequest(), reply)).rejects.toThrow()

    expect(reply.clearCookie).not.toHaveBeenCalled()
  })
})

describe('UserController.getAllUserGames', () => {
  function ownerRequest(query: Record<string, string>) {
    return {
      query,
      user: { userId: 'user-1' },
      headers: {}
    } as unknown as FastifyRequest
  }

  it('hands the platform filter to the service and never hides statuses from the owner', async () => {
    const findManyUserGames = vi.fn().mockResolvedValue({
      games: {},
      totalPerStatus: [],
      total: 0
    })
    const controller = new UserController({
      findManyUserGames
    } as unknown as UserService)

    await controller.getAllUserGames(
      ownerRequest({ filter: 'QUEUE', platforms: 'PLAYSTATION,XBOX' }),
      fakeReply()
    )

    const options = findManyUserGames.mock.calls[0][6]
    expect(options).toEqual({ platforms: ['PLAYSTATION', 'XBOX'] })
    expect(options).not.toHaveProperty('excludeStatuses')
  })
})

describe('UserController.getPublicUserGames', () => {
  it('uses the public method, which is the one that leaves dropped games out', async () => {
    const findPublicUserGames = vi.fn().mockResolvedValue({
      games: { DROPPED: [] },
      totalPerStatus: [],
      total: 0
    })
    const findManyUserGames = vi.fn()
    const controller = new UserController({
      resolveUserRef: vi.fn(async (ref: string) => ref),
      findPublicUserGames,
      findManyUserGames
    } as unknown as UserService)

    await controller.getPublicUserGames(
      {
        params: { userId: '3f1c2e0a-9b4d-4c61-8a57-2d0f7a1b9e44' },
        query: {}
      } as unknown as FastifyRequest,
      fakeReply()
    )

    expect(findPublicUserGames).toHaveBeenCalledTimes(1)
    expect(findManyUserGames).not.toHaveBeenCalled()
  })

  it('passes the paging, filter and search of the full list to the public method', async () => {
    const findPublicUserGames = vi.fn().mockResolvedValue({
      games: {},
      totalPerStatus: [],
      total: 0
    })
    const controller = new UserController({
      resolveUserRef: vi.fn(async (ref: string) => ref),
      findPublicUserGames
    } as unknown as UserService)

    await controller.getPublicUserGames(
      {
        params: { userId: '3f1c2e0a-9b4d-4c61-8a57-2d0f7a1b9e44' },
        query: { filter: 'PLAYED', pageIndex: '2', query: 'zelda' }
      } as unknown as FastifyRequest,
      fakeReply()
    )

    expect(findPublicUserGames).toHaveBeenCalledWith(
      '3f1c2e0a-9b4d-4c61-8a57-2d0f7a1b9e44',
      expect.objectContaining({
        filter: 'PLAYED',
        pageIndex: 2,
        query: 'zelda'
      })
    )
  })
})
