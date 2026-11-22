export function createTtlCache(ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<
    string,
    { expiresAt: number; value: Promise<unknown> }
  >()

  function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = entries.get(key)
    if (hit && hit.expiresAt > now()) return hit.value as Promise<T>

    const value = load()
    entries.set(key, { expiresAt: now() + ttlMs, value })
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key)
    })
    return value
  }
  cached.clear = () => entries.clear()
  return cached
}
