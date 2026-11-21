import { describe, it, expect } from 'vitest'
import { jobRef, truncateReason, REASON_MAX_LENGTH } from './admin-job-ref'

describe('jobRef', () => {
  const id = 'steam-import-2f1c3a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b'

  it('is the store plus 4 hex characters and never contains the id', () => {
    const ref = jobRef('steam', id)

    expect(ref).toMatch(/^steam-import:[0-9a-f]{4}$/)
    expect(ref).not.toContain('2f1c')
  })

  it('is stable for the same job and differs between jobs', () => {
    expect(jobRef('steam', id)).toBe(jobRef('steam', id))
    expect(jobRef('steam', id)).not.toBe(jobRef('steam', `${id}0`))
  })
})

describe('truncateReason', () => {
  it('keeps short text, trimmed', () => {
    expect(truncateReason('  Perfil privado ')).toBe('Perfil privado')
  })

  it('has no reason for null or blank text', () => {
    expect(truncateReason(null)).toBeNull()
    expect(truncateReason('   ')).toBeNull()
  })

  it('cuts long text to the limit with an ellipsis', () => {
    const cut = truncateReason('a'.repeat(1000))

    expect(cut).toHaveLength(REASON_MAX_LENGTH)
    expect(cut?.endsWith('…')).toBe(true)
  })
})
