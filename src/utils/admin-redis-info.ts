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

function positive(value: number | null): number | null {
  return value !== null && value > 0 ? value : null
}

export function parseRedisInfo(info: string): RedisInfo {
  const usedMemory = positive(field(info, 'used_memory'))
  const dataSize = positive(field(info, 'total_data_size'))
  const useDataSize = usedMemory === null && dataSize !== null
  return {
    usedMemoryBytes: useDataSize ? dataSize : usedMemory,
    maxMemoryBytes: positive(
      field(info, useDataSize ? 'max_data_size' : 'maxmemory')
    ),
    evictedKeys: field(info, 'evicted_keys')
  }
}
