import { describe, expect, it } from 'vitest'
import {
  isValidHandle,
  toHandle,
  uniqueHandle,
  HANDLE_REGEX,
  handlePrefix,
  toHandleSearch
} from './user-handle'

describe('toHandle', () => {
  it('normaliza nomes com espaço e acento', () => {
    expect(toHandle('Matheus Silva')).toBe('matheussilva')
    expect(toHandle('João Açaí')).toBe('joaoacai')
  })

  it('mantém o underscore que já existia', () => {
    expect(toHandle('Jane_Doe')).toBe('jane_doe')
  })

  it('completa nomes vazios ou curtos', () => {
    expect(toHandle(null)).toBe('usuario')
    expect(toHandle('!!!')).toBe('usuario')
    expect(toHandle('Al')).toBe('usuario-al')
  })

  it('corta em 30 caracteres sem deixar hífen na ponta', () => {
    const handle = toHandle('a'.repeat(29) + ' bbb')
    expect(handle.length).toBeLessThanOrEqual(30)
    expect(HANDLE_REGEX.test(handle)).toBe(true)
  })

  it('sempre devolve algo que passa no regex', () => {
    for (const raw of ['🎮🎮', '  --x-- ', 'A', 'ñandú', 'x_', '_y_z_']) {
      expect(HANDLE_REGEX.test(toHandle(raw))).toBe(true)
    }
  })
})

describe('isValidHandle', () => {
  it('aceita handles bem formados', () => {
    expect(isValidHandle('matheus-silva')).toBe(true)
    expect(isValidHandle('a_b')).toBe(true)
  })

  it('recusa maiúscula, espaço, curto, longo e borda com símbolo', () => {
    for (const bad of ['Matheus', 'a b', 'ab', 'a'.repeat(31), '-ab', 'ab-']) {
      expect(isValidHandle(bad)).toBe(false)
    }
  })

  it('recusa reservados, sem diferenciar maiúsculas', () => {
    expect(isValidHandle('me')).toBe(false)
    expect(isValidHandle('roulette')).toBe(false)
    expect(isValidHandle('steam')).toBe(false)
  })
})

describe('uniqueHandle', () => {
  it('usa o base quando está livre', () => {
    expect(uniqueHandle('Ana Lima', () => false)).toBe('analima')
  })

  it('numera em caso de colisão', () => {
    const taken = new Set(['analima', 'analima-2'])
    expect(uniqueHandle('Ana Lima', h => taken.has(h))).toBe('analima-3')
  })

  it('respeita o limite ao numerar', () => {
    const base = toHandle('x'.repeat(40))
    const result = uniqueHandle('x'.repeat(40), h => h === base)
    expect(result.length).toBeLessThanOrEqual(30)
    expect(result).not.toBe(base)
    expect(HANDLE_REGEX.test(result)).toBe(true)
  })

  it('nunca devolve reservado', () => {
    expect(uniqueHandle('steam', () => false)).not.toBe('steam')
  })
})

describe('toHandleSearch', () => {
  it('leva o termo digitado para o formato dos handles', () => {
    expect(toHandleSearch('  Matheus Silva ')).toBe('matheussilva')
    expect(toHandleSearch('João')).toBe('joao')
  })
})

describe('handlePrefix', () => {
  it('é prefixo de todo candidato de uniqueHandle, mesmo com base longa', () => {
    const raw = 'x'.repeat(40)
    const base = toHandle(raw)
    const prefix = handlePrefix(base)
    const taken = new Set<string>([base])
    for (let i = 0; i < 12; i++) {
      const handle = uniqueHandle(raw, h => taken.has(h))
      expect(handle.startsWith(prefix)).toBe(true)
      taken.add(handle)
    }
  })
})
