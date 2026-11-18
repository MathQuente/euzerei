import { describe, expect, it } from 'vitest'
import {
  asReleasePrecision,
  precisionFromFormat,
  releaseDatePrecision
} from './release-precision'

const GTA = 1795046400 // 2026-11-19
const NEW_YEAR_EVE = 1798675200 // 2026-12-31

describe('releaseDatePrecision', () => {
  it('é "day" quando a data é exata', () => {
    expect(
      releaseDatePrecision(GTA, [
        { date: GTA, date_format: 0 },
        { date: GTA, date_format: 0 }
      ])
    ).toBe('day')
  })

  it('reconhece mês, ano e trimestres', () => {
    expect(releaseDatePrecision(GTA, [{ date: GTA, date_format: 1 }])).toBe(
      'month'
    )
    expect(
      releaseDatePrecision(NEW_YEAR_EVE, [
        { date: NEW_YEAR_EVE, date_format: 2 }
      ])
    ).toBe('year')
    expect(
      releaseDatePrecision(NEW_YEAR_EVE, [
        { date: NEW_YEAR_EVE, date_format: 6 }
      ])
    ).toBe('q4')
  })

  it('é "tbd" quando a data é "a confirmar" (date nulo)', () => {
    expect(
      releaseDatePrecision(NEW_YEAR_EVE, [
        { date_format: 7 },
        { date_format: 7 }
      ])
    ).toBe('tbd')
  })

  it('escolhe a entrada mais precisa entre as que coincidem', () => {
    expect(
      releaseDatePrecision(GTA, [
        { date: GTA, date_format: 2 },
        { date: GTA, date_format: 0 },
        { date: GTA, date_format: 1 }
      ])
    ).toBe('day')
  })

  it('ignora entradas de outra data ao medir a precisão', () => {
    expect(
      releaseDatePrecision(NEW_YEAR_EVE, [
        { date: NEW_YEAR_EVE, date_format: 2 },
        { date: GTA, date_format: 0 }
      ])
    ).toBe('year')
  })

  it('é "tbd" quando nenhuma entrada coincide com first_release_date', () => {
    expect(
      releaseDatePrecision(NEW_YEAR_EVE, [{ date: GTA, date_format: 0 }])
    ).toBe('tbd')
  })

  it('é desconhecida (não "tbd") quando a entrada da mesma data não tem formato conhecido', () => {
    expect(
      releaseDatePrecision(GTA, [
        { date: GTA },
        { date: NEW_YEAR_EVE, date_format: 0 }
      ])
    ).toBeUndefined()
    expect(
      releaseDatePrecision(GTA, [
        { date: GTA, date_format: 99 },
        { date: NEW_YEAR_EVE, date_format: 0 }
      ])
    ).toBeUndefined()
  })

  it('é desconhecida sem release_dates ou sem date_format', () => {
    expect(releaseDatePrecision(GTA, undefined)).toBeUndefined()
    expect(releaseDatePrecision(GTA, [])).toBeUndefined()
    expect(releaseDatePrecision(GTA, [{ date: GTA }])).toBeUndefined()
    expect(
      releaseDatePrecision(undefined, [{ date: GTA, date_format: 0 }])
    ).toBeUndefined()
  })
})

describe('precisionFromFormat', () => {
  it('traduz os códigos da IGDB e ignora os desconhecidos', () => {
    expect(precisionFromFormat(3)).toBe('q1')
    expect(precisionFromFormat(99)).toBeUndefined()
    expect(precisionFromFormat(undefined)).toBeUndefined()
  })
})

describe('asReleasePrecision', () => {
  it('aceita os valores conhecidos e descarta o resto', () => {
    expect(asReleasePrecision('year')).toBe('year')
    expect(asReleasePrecision('q4')).toBe('q4')
    expect(asReleasePrecision('tbd')).toBe('tbd')
    expect(asReleasePrecision('quarter')).toBeUndefined()
    expect(asReleasePrecision('toString')).toBeUndefined()
    expect(asReleasePrecision('')).toBeUndefined()
    expect(asReleasePrecision(null)).toBeUndefined()
    expect(asReleasePrecision(undefined)).toBeUndefined()
  })
})
