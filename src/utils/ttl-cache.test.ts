import { describe, it, expect, vi } from 'vitest'
import { createTtlCache } from './ttl-cache'

describe('createTtlCache', () => {
  it('loads once inside the window and again after it expires', async () => {
    let now = 0
    const cached = createTtlCache(10_000, () => now)
    const load = vi.fn().mockResolvedValue('v')

    await cached('k', load)
    now = 9_999
    await cached('k', load)
    expect(load).toHaveBeenCalledTimes(1)

    now = 10_000
    await cached('k', load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps keys apart', async () => {
    const cached = createTtlCache(10_000, () => 0)
    const a = vi.fn().mockResolvedValue('a')
    const b = vi.fn().mockResolvedValue('b')

    expect(await cached('a', a)).toBe('a')
    expect(await cached('b', b)).toBe('b')
  })

  it('concurrent callers share one load (three panel blocks asking at once)', async () => {
    const cached = createTtlCache(10_000, () => 0)
    let release!: (value: string) => void
    const load = vi.fn(
      () => new Promise<string>(resolve => (release = resolve))
    )

    const first = cached('k', load)
    const second = cached('k', load)
    release('v')

    expect(await Promise.all([first, second])).toEqual(['v', 'v'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not remember a failure: the next call tries again', async () => {
    const cached = createTtlCache(10_000, () => 0)
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValue('ok')

    await expect(cached('k', load)).rejects.toThrow('redis down')
    await Promise.resolve()
    expect(await cached('k', load)).toBe('ok')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
