import { describe, it, expect } from 'vitest'
import {
  BLOCK_ID_PATTERN,
  blockId,
  blockLimit,
  classifyLoginKey,
  isBlocked,
  shortRef
} from './admin-security-keys'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

describe('classifyLoginKey', () => {
  it('reads the route limiter key with the plain ip', () => {
    expect(classifyLoginKey('rate-limitPOST/auth/login-187.4.22.91')).toEqual({
      kind: 'ip',
      route: 'login',
      ip: '187.4.22.91'
    })
    expect(
      classifyLoginKey('rate-limitPOST/panel/auth/login-2001:db8::1')
    ).toEqual({ kind: 'ip', route: 'panel', ip: '2001:db8::1' })
  })

  it('reads the failure counters by e-mail and by e-mail plus ip', () => {
    expect(classifyLoginKey(`login-failures:${HASH_A}`)).toEqual({
      kind: 'email',
      emailHash: HASH_A
    })
    expect(classifyLoginKey(`login-failures:${HASH_A}:${HASH_B}`)).toEqual({
      kind: 'email-ip',
      emailHash: HASH_A
    })
  })

  it.each([
    'rate-limitPOST/auth/login-',
    'rate-limitPOST/auth/register-1.2.3.4',
    'rate-limitPOST/auth/forgot-password-1.2.3.4',
    'rate-limit1.2.3.4',
    `login-familiar-ip:${HASH_A}:${HASH_B}`,
    'login-failures:not-a-hash',
    `login-failures:${HASH_A.toUpperCase()}`,
    `login-failures:${HASH_A}:${HASH_B}:extra`,
    'bull:steam-import:wait',
    'users:user:2f1c3a4e'
  ])('ignores %s', key => {
    expect(classifyLoginKey(key)).toBeNull()
  })
})

describe('isBlocked', () => {
  it('the route limiter blocks from the 4th request, not the 3rd', () => {
    const key = { kind: 'ip', route: 'login', ip: '1.2.3.4' } as const
    expect(isBlocked(key, 3)).toBe(false)
    expect(isBlocked(key, 4)).toBe(true)
  })

  it('the failure counters block when they reach the limit', () => {
    expect(isBlocked({ kind: 'email-ip', emailHash: HASH_A }, 9)).toBe(false)
    expect(isBlocked({ kind: 'email-ip', emailHash: HASH_A }, 10)).toBe(true)
    expect(isBlocked({ kind: 'email', emailHash: HASH_A }, 49)).toBe(false)
    expect(isBlocked({ kind: 'email', emailHash: HASH_A }, 50)).toBe(true)
  })

  it('reports the limit of each kind', () => {
    expect(blockLimit({ kind: 'ip', route: 'panel', ip: 'x' })).toBe(3)
    expect(blockLimit({ kind: 'email-ip', emailHash: HASH_A })).toBe(10)
    expect(blockLimit({ kind: 'email', emailHash: HASH_A })).toBe(50)
  })
})

describe('shortRef', () => {
  it('is the first 6 hex characters only', () => {
    expect(shortRef(HASH_A)).toBe('aaaaaa')
    expect(shortRef(HASH_A)).toHaveLength(6)
  })
})

describe('blockId', () => {
  it('é um prefixo hex de 16 caracteres, estável e sem revelar a chave', () => {
    const key = 'rate-limitPOST/auth/login-187.4.22.91'
    const id = blockId(key)

    expect(id).toMatch(BLOCK_ID_PATTERN)
    expect(blockId(key)).toBe(id)
    expect(id).not.toContain('187')
  })

  it('chaves diferentes dão ids diferentes', () => {
    expect(blockId('login-failures:' + 'a'.repeat(64))).not.toBe(
      blockId('login-failures:' + 'b'.repeat(64))
    )
  })
})
