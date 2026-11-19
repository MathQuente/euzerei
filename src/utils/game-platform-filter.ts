/**
 * Famílias de plataforma do filtro do catálogo. Cada chave vira a lista exata
 * de nomes que o IGDB grava em `games_cache.platforms`.
 */
export const PLATFORM_FILTERS = {
  pc: ['PC (Microsoft Windows)', 'Mac', 'Linux'],
  playstation: [
    'PlayStation',
    'PlayStation 2',
    'PlayStation 3',
    'PlayStation 4',
    'PlayStation 5',
    'PlayStation Portable',
    'PlayStation Vita',
    'PlayStation VR',
    'PlayStation VR2'
  ],
  xbox: ['Xbox', 'Xbox 360', 'Xbox One', 'Xbox Series X|S'],
  nintendo: [
    'Nintendo Entertainment System',
    'Super Nintendo Entertainment System',
    'Nintendo 64',
    '64DD',
    'Nintendo GameCube',
    'Wii',
    'Wii U',
    'Nintendo Switch',
    'Nintendo Switch 2',
    'Nintendo DS',
    'Nintendo DSi',
    'Nintendo 3DS',
    'New Nintendo 3DS',
    'Game Boy',
    'Game Boy Color',
    'Game Boy Advance',
    'Virtual Boy',
    'Pokémon mini',
    'Family Computer',
    'Family Computer Disk System',
    'Super Famicom',
    'Satellaview'
  ],
  mobile: ['Android', 'iOS']
} as const

export type PlatformFilterKey = keyof typeof PLATFORM_FILTERS

export const PLATFORM_FILTER_KEYS = Object.keys(
  PLATFORM_FILTERS
) as PlatformFilterKey[]

const isPlatformFilterKey = (value: string): value is PlatformFilterKey =>
  Object.hasOwn(PLATFORM_FILTERS, value)

/**
 * Lê `?platforms=pc,xbox`: só chaves conhecidas, sem repetir. Aceita também
 * uma lista, porque a rota valida a query e o controller valida de novo o
 * resultado já convertido.
 */
export function parsePlatformFilterKeys(
  raw: string | readonly string[] | undefined
): PlatformFilterKey[] {
  if (!raw) return []
  const values = typeof raw === 'string' ? raw.split(',') : raw
  const keys = values
    .map(value => value.trim().toLowerCase())
    .filter(isPlatformFilterKey)
  return [...new Set(keys)]
}

/** A união dos nomes IGDB das famílias escolhidas. */
export function platformNamesFor(keys: readonly PlatformFilterKey[]): string[] {
  return [...new Set(keys.flatMap(key => PLATFORM_FILTERS[key]))]
}
