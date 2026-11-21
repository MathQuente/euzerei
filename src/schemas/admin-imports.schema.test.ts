import { describe, it, expect } from 'vitest'
import { IMPORTS_MAX_PAGE, ImportListQuerySchema } from './admin-imports.schema'

const parse = (query: Record<string, string>) =>
  ImportListQuerySchema.safeParse(query)

describe('ImportListQuerySchema', () => {
  it('defaults to page 1 with no filters', () => {
    const result = parse({})
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ page: 1 })
    expect(result.data?.status).toBeUndefined()
    expect(result.data?.store).toBeUndefined()
  })

  it('reads status, store and page', () => {
    expect(parse({ status: 'failed', store: 'psn', page: '3' }).data).toEqual({
      status: 'failed',
      store: 'psn',
      page: 3
    })
  })

  it('treats blank filters as absent', () => {
    const result = parse({ status: '', store: '  ' })
    expect(result.success).toBe(true)
    expect(result.data?.status).toBeUndefined()
    expect(result.data?.store).toBeUndefined()
  })

  it.each(['failed', 'running', 'queued', 'done'])(
    'accepts status %s',
    status => {
      expect(parse({ status }).success).toBe(true)
    }
  )

  it.each([
    ['an unknown status', { status: 'banana' }],
    ['the raw BullMQ state', { status: 'completed' }],
    ['an unknown store', { store: 'epic' }],
    ['page 0', { page: '0' }],
    ['a fractional page', { page: '1.5' }],
    [
      'a page above the cap that bounds the Redis reads',
      { page: String(IMPORTS_MAX_PAGE + 1) }
    ]
  ])('refuses %s', (_label, query) => {
    expect(parse(query).success).toBe(false)
  })

  it('accepts the page cap', () => {
    expect(parse({ page: String(IMPORTS_MAX_PAGE) }).success).toBe(true)
  })
})
