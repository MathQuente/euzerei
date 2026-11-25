import { beforeEach, describe, expect, it, vi } from 'vitest'

const redis = vi.hoisted(() => ({ mget: vi.fn() }))
vi.mock('../database/redis', () => ({ redis }))

import { CacheRepository } from './cache.repository'

describe('CacheRepository.mget', () => {
  beforeEach(() => {
    redis.mget.mockReset()
  })

  it('reads every key in ONE command, parses JSON and turns a missing key into null', async () => {
    redis.mget.mockResolvedValue([null, '1700000000', '{"a":1}', '"text"'])

    const result = await new CacheRepository().mget(['a', 'b', 'c', 'd'])

    expect(redis.mget).toHaveBeenCalledTimes(1)
    expect(redis.mget).toHaveBeenCalledWith('a', 'b', 'c', 'd')
    expect(result).toEqual([null, 1700000000, { a: 1 }, 'text'])
  })

  it('keeps a number a number, which the revocation check needs (typeof revokedAt)', async () => {
    redis.mget.mockResolvedValue([null, '1700000000'])

    const [, revokedAt] = await new CacheRepository().mget(['t', 'u'])

    expect(typeof revokedAt).toBe('number')
  })

  it('does not call Redis for an empty list', async () => {
    expect(await new CacheRepository().mget([])).toEqual([])
    expect(redis.mget).not.toHaveBeenCalled()
  })

  it('lets a Redis failure through, so the guard answers 503 instead of letting the request in', async () => {
    redis.mget.mockRejectedValue(new Error('redis down'))

    await expect(new CacheRepository().mget(['a'])).rejects.toThrow(
      'redis down'
    )
  })
})
