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

  it('Upstash reports used_memory as 0 and the size in total_data_size', () => {
    const info = [
      '# Server',
      'upstash_version:1.19.8',
      '# Memory',
      'used_memory:0',
      'maxmemory:67108864',
      '# Persistence',
      'total_keys:13',
      'total_data_size:112208',
      'max_data_size:250000000',
      '# Stats',
      'evicted_keys:0'
    ].join('\r\n')

    expect(parseRedisInfo(info)).toEqual({
      usedMemoryBytes: 112_208,
      maxMemoryBytes: 250_000_000,
      evictedKeys: 0
    })
  })

  it('a real used_memory wins over total_data_size', () => {
    const info =
      'used_memory:5000\r\nmaxmemory:100\r\ntotal_data_size:9\r\nmax_data_size:7\r\n'

    expect(parseRedisInfo(info)).toMatchObject({
      usedMemoryBytes: 5000,
      maxMemoryBytes: 100
    })
  })

  it('a used_memory of 0 with no data size is unknown, never 0 bytes', () => {
    expect(parseRedisInfo('used_memory:0\r\n').usedMemoryBytes).toBeNull()
  })
})
