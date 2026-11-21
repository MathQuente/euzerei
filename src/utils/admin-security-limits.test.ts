import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  LOGIN_FAILURES_PER_EMAIL,
  LOGIN_FAILURES_PER_IP,
  LOGIN_FAILURES_WINDOW_MINUTES,
  LOGIN_ROUTE_LIMIT,
  MAX_SESSIONS_PER_USER,
  RECENT_AUTH_MINUTES
} from './admin-security-limits'

function source(path: string) {
  return readFileSync(resolve(__dirname, path), 'utf8')
}

function match(text: string, pattern: RegExp) {
  const found = pattern.exec(text)
  if (!found) throw new Error(`pattern not found: ${pattern}`)
  return found
}

describe('the admin limits mirror the code that enforces them', () => {
  it('the login route limit of both login routes', () => {
    const pattern =
      /'\/login',\s*\{\s*config:\s*\{\s*rateLimit:\s*\{\s*max:\s*(\d+),\s*timeWindow:\s*'1 minute'/
    expect(Number(match(source('../routes/auth.ts'), pattern)[1])).toBe(
      LOGIN_ROUTE_LIMIT
    )
    expect(Number(match(source('../routes/panel-auth.ts'), pattern)[1])).toBe(
      LOGIN_ROUTE_LIMIT
    )
  })

  it('the failure counters of the password login', () => {
    const text = source('../services/auth.service.ts')
    expect(Number(match(text, /MAX_LOGIN_FAILURES_PER_IP = (\d+)/)[1])).toBe(
      LOGIN_FAILURES_PER_IP
    )
    expect(Number(match(text, /MAX_LOGIN_FAILURES_PER_EMAIL = (\d+)/)[1])).toBe(
      LOGIN_FAILURES_PER_EMAIL
    )
    const window = match(text, /LOGIN_FAILURES_WINDOW_SECONDS = (\d+) \* (\d+)/)
    expect((Number(window[1]) * Number(window[2])) / 60).toBe(
      LOGIN_FAILURES_WINDOW_MINUTES
    )
  })

  it('the recent sign-in window and the session cap', () => {
    expect(
      Number(
        match(
          source('../services/recent-auth.service.ts'),
          /RECENT_AUTH_TTL_SECONDS = (\d+) \* 60/
        )[1]
      )
    ).toBe(RECENT_AUTH_MINUTES)
    expect(
      Number(
        match(
          source('../repositories/auth.repository.ts'),
          /MAX_SESSIONS_PER_USER = (\d+)/
        )[1]
      )
    ).toBe(MAX_SESSIONS_PER_USER)
  })

  it('the password schema still refuses common passwords, as the protections card says', () => {
    const text = source('../schemas/auth.schema.ts')
    const schema = match(text, /export const PasswordSchema = z[\s\S]*?\n\n/)[0]
    expect(schema).toContain('isCommonPassword(password)')
  })

  it('the sign-in path still does not enforce a verified e-mail, as the protections card says', () => {
    const root = resolve(__dirname, '..')
    const users = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter(file => !file.startsWith('generated'))
      .filter(file =>
        readFileSync(resolve(root, file), 'utf8').includes(
          'requireVerifiedEmail'
        )
      )
    expect(users.sort()).toEqual(['schemas/app-settings.schema.ts'])
  })

  it('the limiter keys keep the format the screen reads', () => {
    const text = source('../server.ts')
    expect(text).toContain("nameSpace: 'rate-limit'")
  })
})
