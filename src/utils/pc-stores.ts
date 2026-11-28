export type PcStore = 'STEAM' | 'EPIC'

interface StoreEvidence {
  external_games?: { external_game_source?: number }[]
  websites?: { type?: number }[]
}

const STEAM_SOURCE = 1
const EPIC_SOURCE = 26
const STEAM_WEBSITE = 13
const EPIC_WEBSITE = 16

const OTHER_STORE_SOURCES = new Set([5, 11, 13, 15, 28, 30, 31, 36])
const OTHER_STORE_WEBSITES = new Set([15, 17, 22, 23, 24, 25])

export function missingPcStores(game: StoreEvidence): PcStore[] {
  if (!game.external_games && !game.websites) return []

  const sources = new Set(
    (game.external_games ?? []).map(e => e.external_game_source)
  )
  const websites = new Set((game.websites ?? []).map(w => w.type))

  const knowsOtherStore =
    [...sources].some(s => s !== undefined && OTHER_STORE_SOURCES.has(s)) ||
    [...websites].some(t => t !== undefined && OTHER_STORE_WEBSITES.has(t))
  if (!knowsOtherStore) return []

  const missing: PcStore[] = []
  if (!sources.has(STEAM_SOURCE) && !websites.has(STEAM_WEBSITE)) {
    missing.push('STEAM')
  }
  if (!sources.has(EPIC_SOURCE) && !websites.has(EPIC_WEBSITE)) {
    missing.push('EPIC')
  }
  return missing
}
