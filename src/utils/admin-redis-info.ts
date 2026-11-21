export interface RedisInfo {
  usedMemoryBytes: number | null
  maxMemoryBytes: number | null
  evictedKeys: number | null
}

function field(info: string, name: string): number | null {
  const line = info.split(/\r?\n/).find(entry => entry.startsWith(`${name}:`))
  if (!line) return null
  const value = Number(line.slice(name.length + 1))
  return Number.isFinite(value) ? value : null
}

export function parseRedisInfo(info: string): RedisInfo {
  const maxMemory = field(info, 'maxmemory')
  return {
    usedMemoryBytes: field(info, 'used_memory'),
    maxMemoryBytes: maxMemory === null || maxMemory === 0 ? null : maxMemory,
    evictedKeys: field(info, 'evicted_keys')
  }
}
