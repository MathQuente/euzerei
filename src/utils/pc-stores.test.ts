import { describe, expect, it } from 'vitest'
import { missingPcStores } from './pc-stores'

const src = (...ids: number[]) => ({
  external_games: ids.map(external_game_source => ({ external_game_source }))
})

describe('missingPcStores', () => {
  it('sem dados de loja não afirma nada', () => {
    expect(missingPcStores({})).toEqual([])
    expect(missingPcStores(src(3, 20))).toEqual([])
  })

  it('Minecraft: Xbox e PlayStation mas nem Steam nem Epic', () => {
    expect(missingPcStores(src(20, 11, 36, 14))).toEqual(['STEAM', 'EPIC'])
  })

  it('Fortnite: Epic sem Steam', () => {
    expect(missingPcStores(src(11, 36, 26))).toEqual(['STEAM'])
  })

  it('o site da loja vale como evidência', () => {
    expect(
      missingPcStores({ ...src(11), websites: [{ type: 13 }, { type: 16 }] })
    ).toEqual([])
  })
})
