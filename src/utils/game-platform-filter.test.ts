import { describe, expect, it } from 'vitest'
import {
  PLATFORM_FILTERS,
  parsePlatformFilterKeys,
  platformNamesFor
} from './game-platform-filter'

describe('parsePlatformFilterKeys', () => {
  it('reads known keys, ignoring case, spaces and repeats', () => {
    expect(parsePlatformFilterKeys('PC, xbox ,pc')).toEqual(['pc', 'xbox'])
  })

  it('ignores unknown keys, including inherited property names', () => {
    expect(
      parsePlatformFilterKeys('sega,constructor,__proto__,nintendo')
    ).toEqual(['nintendo'])
  })

  it('is idempotent: accepts its own output (route parse, then controller parse)', () => {
    const once = parsePlatformFilterKeys('pc,mobile')
    expect(parsePlatformFilterKeys(once)).toEqual(once)
  })

  it('returns nothing without a value', () => {
    expect(parsePlatformFilterKeys(undefined)).toEqual([])
    expect(parsePlatformFilterKeys('')).toEqual([])
  })
})

describe('platformNamesFor', () => {
  it('joins the names of the chosen families', () => {
    const names = platformNamesFor(['mobile', 'xbox'])
    expect(names).toEqual(
      expect.arrayContaining(['Android', 'iOS', 'Xbox One'])
    )
    expect(names).not.toContain('Mac')
  })

  it('keeps the pipe in "Xbox Series X|S" intact', () => {
    expect(platformNamesFor(['xbox'])).toContain('Xbox Series X|S')
  })

  it('has no name in two families', () => {
    const all = Object.values(PLATFORM_FILTERS).flat()
    expect(new Set(all).size).toBe(all.length)
  })
})
