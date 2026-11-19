import fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import {
  MIN_ORIGIN_SECRET_LENGTH,
  ORIGIN_SECRET_HEADER,
  registerOriginGuard
} from './origin-guard'

const SECRET = 'a'.repeat(MIN_ORIGIN_SECRET_LENGTH)

function buildApp(secret: string | undefined) {
  const app = fastify()
  const enabled = registerOriginGuard(app, { secret })
  app.get('/health', async () => ({ status: 'ok' }))
  app.get('/ready', async () => ({ status: 'ready' }))
  app.get('/games', async () => ({ games: [] }))
  app.post('/auth/login', async () => ({ ok: true }))
  return { app, enabled }
}

describe('registerOriginGuard', () => {
  it('stays off and lets every request through when no secret is set', async () => {
    const { app, enabled } = buildApp(undefined)

    const response = await app.inject({ method: 'GET', url: '/games' })

    expect(enabled).toBe(false)
    expect(response.statusCode).toBe(200)
  })

  it('treats an empty secret as not configured', async () => {
    const { app, enabled } = buildApp('')

    const response = await app.inject({ method: 'GET', url: '/games' })

    expect(enabled).toBe(false)
    expect(response.statusCode).toBe(200)
  })

  it('refuses a secret shorter than the minimum', () => {
    expect(() => buildApp('curto')).toThrow(/at least 32 characters/)
  })

  it('answers 403 when the header is missing', async () => {
    const { app, enabled } = buildApp(SECRET)

    const response = await app.inject({ method: 'GET', url: '/games' })

    expect(enabled).toBe(true)
    expect(response.statusCode).toBe(403)
    expect(response.headers['content-type']).toContain(
      'application/problem+json'
    )
    expect(response.json()).toMatchObject({ status: 403, detail: 'Forbidden' })
  })

  it('answers 403 when the header is wrong', async () => {
    const { app } = buildApp(SECRET)

    const response = await app.inject({
      method: 'GET',
      url: '/games',
      headers: { [ORIGIN_SECRET_HEADER]: 'b'.repeat(MIN_ORIGIN_SECRET_LENGTH) }
    })

    expect(response.statusCode).toBe(403)
  })

  it('answers 403 when the header has a different length', async () => {
    const { app } = buildApp(SECRET)

    const response = await app.inject({
      method: 'GET',
      url: '/games',
      headers: { [ORIGIN_SECRET_HEADER]: 'a' }
    })

    expect(response.statusCode).toBe(403)
  })

  it('answers 403 when the header is the unexpanded Vercel placeholder', async () => {
    const { app } = buildApp(SECRET)

    const response = await app.inject({
      method: 'GET',
      url: '/games',
      headers: { [ORIGIN_SECRET_HEADER]: '$ORIGIN_SECRET' }
    })

    expect(response.statusCode).toBe(403)
  })

  it('lets the request through when the header matches', async () => {
    const { app } = buildApp(SECRET)

    const response = await app.inject({
      method: 'GET',
      url: '/games',
      headers: { [ORIGIN_SECRET_HEADER]: SECRET }
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ games: [] })
  })

  it('guards write routes too', async () => {
    const { app } = buildApp(SECRET)

    const refused = await app.inject({ method: 'POST', url: '/auth/login' })
    const allowed = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { [ORIGIN_SECRET_HEADER]: SECRET }
    })

    expect(refused.statusCode).toBe(403)
    expect(allowed.statusCode).toBe(200)
  })

  it('keeps /health open for the platform health check, with or without a query string', async () => {
    const { app } = buildApp(SECRET)

    const plain = await app.inject({ method: 'GET', url: '/health' })
    const withQuery = await app.inject({ method: 'GET', url: '/health?x=1' })

    expect(plain.statusCode).toBe(200)
    expect(withQuery.statusCode).toBe(200)
  })

  it('does not exempt other paths that only look like /health', async () => {
    const { app } = buildApp(SECRET)

    const ready = await app.inject({ method: 'GET', url: '/ready' })
    const healthz = await app.inject({ method: 'GET', url: '/healthz' })
    const nested = await app.inject({ method: 'GET', url: '/health/x' })

    expect(ready.statusCode).toBe(403)
    expect(healthz.statusCode).toBe(403)
    expect(nested.statusCode).toBe(403)
  })

  it('refuses unknown routes without the header instead of revealing which exist', async () => {
    const { app } = buildApp(SECRET)

    const response = await app.inject({ method: 'GET', url: '/nao-existe' })

    expect(response.statusCode).toBe(403)
  })
})
