import { describe, it, expect } from 'vitest'
import { isSessionBound } from './session-bound'

describe('isSessionBound', () => {
  it.each(['/auth/login', '/panel/auth/login', '/admin/me', '/admin'])(
    'marks %s as session bound, so it is never cached',
    url => {
      expect(isSessionBound(url)).toBe(true)
    }
  )

  it('marks any route called with a session cookie', () => {
    expect(isSessionBound('/games', { accessToken: 'x' })).toBe(true)
    expect(isSessionBound('/games', { refreshToken: 'x' })).toBe(true)
  })

  it('leaves public routes without a session cache-able', () => {
    expect(isSessionBound('/games')).toBe(false)
    expect(isSessionBound('/health', {})).toBe(false)
  })
})
