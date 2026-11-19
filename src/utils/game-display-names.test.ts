import { describe, expect, it } from 'vitest'
import {
  displayName,
  displayNameOverrides,
  legacySlugToIgdbId,
  overriddenIgdbName
} from './game-display-names'
import { slugify } from './game-slug'

describe('game display names', () => {
  it('renames FIFA Soccer 13 and leaves other games alone', () => {
    expect(displayName(2153, 'FIFA Soccer 13')).toBe('FIFA 13')
    expect(displayName(1, 'Portal')).toBe('Portal')
    expect(overriddenIgdbName(2153)).toBe('FIFA Soccer 13')
    expect(overriddenIgdbName(1)).toBeNull()
  })

  it('maps the old slug back to the game', () => {
    expect(legacySlugToIgdbId('fifa-soccer-13')).toBe(2153)
    expect(legacySlugToIgdbId('fifa-soccer-06')).toBe(700)
    expect(legacySlugToIgdbId('fifa-13')).toBeNull()
  })

  it('covers the 13 FIFA Soccer games with a name that slugs cleanly', () => {
    const overrides = displayNameOverrides()
    expect(overrides).toHaveLength(13)
    for (const { name, igdbName } of overrides) {
      expect(igdbName.startsWith('FIFA Soccer ')).toBe(true)
      expect(name).toBe(igdbName.replace('Soccer ', ''))
      expect(slugify(name)).toMatch(/^fifa-\d+$/)
    }
  })
})
