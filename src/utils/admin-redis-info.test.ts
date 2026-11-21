import { describe, it, expect } from 'vitest'
import { parseRedisInfo } from './admin-redis-info'

describe('parseRedisInfo', () => {
  it('reads memory and evictions from the INFO text', () => {
    const info =
      '# Memory\r\nused_memory:43000000\r\nmaxmemory:268435456\r\n# Stats\r\nevicted_keys:0\r\n'

    expect(parseRedisInfo(info)).toEqual({
      usedMemoryBytes: 43_000_000,
      maxMemoryBytes: 268_435_456,
      evictedKeys: 0
    })
  })

  it('maxmemory 0 means no limit', () => {
    expect(parseRedisInfo('maxmemory:0').maxMemoryBytes).toBeNull()
  })

  it('a partial INFO (Upstash) leaves the missing fields null', () => {
    expect(parseRedisInfo('# Server\r\nredis_version:7.0\r\n')).toEqual({
      usedMemoryBytes: null,
      maxMemoryBytes: null,
      evictedKeys: null
    })
  })

  it('does not mistake a field that only starts with the same letters', () => {
    expect(
      parseRedisInfo('used_memory_human:41M\r\n').usedMemoryBytes
    ).toBeNull()
  })
})
