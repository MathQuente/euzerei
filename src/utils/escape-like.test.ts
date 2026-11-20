import { describe, it, expect } from 'vitest'
import { escapeLike } from './escape-like'

describe('escapeLike', () => {
  it('leaves ordinary text alone', () => {
    expect(escapeLike('Suspendeu a conta @kenzo')).toBe(
      'Suspendeu a conta @kenzo'
    )
  })

  it('escapes the wildcards so they match themselves', () => {
    expect(escapeLike('100%')).toBe('100\\%')
    expect(escapeLike('a_b')).toBe('a\\_b')
  })

  it('escapes the escape character itself, and first, so it is not doubled twice', () => {
    expect(escapeLike('a\\b')).toBe('a\\\\b')
    expect(escapeLike('\\%')).toBe('\\\\\\%')
  })

  it('handles every special character together', () => {
    expect(escapeLike('%_\\')).toBe('\\%\\_\\\\')
  })
})
