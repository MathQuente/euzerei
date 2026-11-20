import { describe, it, expect } from 'vitest'
import { passwordFingerprint, readBearerToken } from './panel-token'

describe('readBearerToken', () => {
  it('reads the token after Bearer, ignoring case and extra spaces', () => {
    expect(readBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi')
    expect(readBearerToken('bearer   abc')).toBe('abc')
    expect(readBearerToken('  Bearer abc  ')).toBe('abc')
  })

  it('returns null for a missing, bare or different scheme header', () => {
    expect(readBearerToken(undefined)).toBeNull()
    expect(readBearerToken('')).toBeNull()
    expect(readBearerToken('abc')).toBeNull()
    expect(readBearerToken('Basic abc')).toBeNull()
    expect(readBearerToken('Bearer')).toBeNull()
    expect(readBearerToken('Bearer a b')).toBeNull()
  })
})

describe('passwordFingerprint', () => {
  it('is stable for the same hash and different for another', () => {
    expect(passwordFingerprint('hash-1')).toBe(passwordFingerprint('hash-1'))
    expect(passwordFingerprint('hash-1')).not.toBe(
      passwordFingerprint('hash-2')
    )
  })

  it('does not contain the hash it came from', () => {
    const fingerprint = passwordFingerprint('$2b$12$secret-hash')
    expect(fingerprint).toHaveLength(16)
    expect(fingerprint).not.toContain('secret')
  })
})
