import { slugify } from './game-slug'

const DISPLAY_NAMES: Record<number, { name: string; igdbName: string }> = {
  45581: { name: 'FIFA 96', igdbName: 'FIFA Soccer 96' },
  10682: { name: 'FIFA 64', igdbName: 'FIFA Soccer 64' },
  43335: { name: 'FIFA 2003', igdbName: 'FIFA Soccer 2003' },
  3136: { name: 'FIFA 2004', igdbName: 'FIFA Soccer 2004' },
  703: { name: 'FIFA 2005', igdbName: 'FIFA Soccer 2005' },
  700: { name: 'FIFA 06', igdbName: 'FIFA Soccer 06' },
  696: { name: 'FIFA 07', igdbName: 'FIFA Soccer 07' },
  3135: { name: 'FIFA 08', igdbName: 'FIFA Soccer 08' },
  3134: { name: 'FIFA 09', igdbName: 'FIFA Soccer 09' },
  3133: { name: 'FIFA 10', igdbName: 'FIFA Soccer 10' },
  503: { name: 'FIFA 11', igdbName: 'FIFA Soccer 11' },
  2946: { name: 'FIFA 12', igdbName: 'FIFA Soccer 12' },
  2153: { name: 'FIFA 13', igdbName: 'FIFA Soccer 13' }
}

export function displayName(igdbId: number, igdbName: string): string {
  return DISPLAY_NAMES[igdbId]?.name ?? igdbName
}

export function overriddenIgdbName(igdbId: number): string | null {
  return DISPLAY_NAMES[igdbId]?.igdbName ?? null
}

export function legacySlugToIgdbId(slug: string): number | null {
  for (const [id, { igdbName }] of Object.entries(DISPLAY_NAMES)) {
    if (slugify(igdbName) === slug) return Number(id)
  }
  return null
}

export function displayNameOverrides() {
  return Object.entries(DISPLAY_NAMES).map(([id, entry]) => ({
    igdbId: Number(id),
    ...entry
  }))
}
