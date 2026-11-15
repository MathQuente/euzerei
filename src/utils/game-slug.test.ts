import { describe, it, expect } from 'vitest'
import { baseSlug, slugify, uniqueSlug } from './game-slug'

describe('slugify', () => {
  it.each([
    ['The Witcher 3: Wild Hunt', 'the-witcher-3-wild-hunt'],
    ['Pokémon Ruby', 'pokemon-ruby'],
    ['Ørsted', 'orsted'],
    ['Straße Æon Łódź Đ', 'strasse-aeon-lodz-d'],
    ["Assassin's Creed®", 'assassins-creed'],
    ['FIFA 23', 'fifa-23'],
    ['  --  ', ''],
    ['日本語', '']
  ])('%s -> %s', (name, expected) => {
    expect(slugify(name)).toBe(expected)
  })

  it('cuts long names at a word boundary within the limit', () => {
    const slug = slugify('word '.repeat(30))
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(slug.endsWith('-')).toBe(false)
    expect(slug).toMatch(/^(word-)*word$/)
  })

  it('cuts a single huge word at the limit', () => {
    expect(slugify('a'.repeat(100))).toHaveLength(60)
  })
})

describe('baseSlug', () => {
  it('falls back to the id when the name gives an empty slug', () => {
    expect(baseSlug('日本語', 42)).toBe('42')
  })

  it('never returns an all-digit slug that could be read as another id', () => {
    expect(baseSlug('2048', 77)).toBe('2048-77')
  })
})

describe('uniqueSlug', () => {
  it('uses the base slug when free', () => {
    expect(uniqueSlug('Doom', 1, () => false)).toBe('doom')
  })

  it('appends the id when the base slug is taken', () => {
    expect(uniqueSlug('Doom', 9, s => s === 'doom')).toBe('doom-9')
  })

  it('falls back to the bare id when the base and the id slug are both taken', () => {
    const taken = new Set(['doom', 'doom-9'])
    expect(uniqueSlug('Doom', 9, s => taken.has(s))).toBe('9')
  })

  it('keeps slugs unique when an id slug equals the clean slug of another game', () => {
    expect(baseSlug('Doom 64', 5)).toBe('doom-64')
    expect(uniqueSlug('Doom', 64, s => s === 'doom')).toBe('doom-64')
  })
})
