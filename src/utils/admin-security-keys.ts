import {
  LOGIN_FAILURES_PER_EMAIL,
  LOGIN_FAILURES_PER_IP,
  LOGIN_ROUTE_LIMIT
} from './admin-security-limits'

export type LoginRoute = 'login' | 'panel'

export type LoginKey =
  | { kind: 'ip'; route: LoginRoute; ip: string }
  | { kind: 'email-ip'; emailHash: string }
  | { kind: 'email'; emailHash: string }

const ROUTE_PREFIXES: ReadonlyArray<readonly [string, LoginRoute]> = [
  ['rate-limitPOST/auth/login-', 'login'],
  ['rate-limitPOST/panel/auth/login-', 'panel']
]

const FAILURES_KEY = /^login-failures:([0-9a-f]{64})(?::([0-9a-f]{64}))?$/

export function classifyLoginKey(key: string): LoginKey | null {
  for (const [prefix, route] of ROUTE_PREFIXES) {
    if (key.startsWith(prefix)) {
      const ip = key.slice(prefix.length)
      return ip === '' ? null : { kind: 'ip', route, ip }
    }
  }
  const match = FAILURES_KEY.exec(key)
  if (!match) return null
  return match[2]
    ? { kind: 'email-ip', emailHash: match[1] }
    : { kind: 'email', emailHash: match[1] }
}

export function blockLimit(key: LoginKey): number {
  switch (key.kind) {
    case 'ip':
      return LOGIN_ROUTE_LIMIT
    case 'email-ip':
      return LOGIN_FAILURES_PER_IP
    case 'email':
      return LOGIN_FAILURES_PER_EMAIL
  }
}

export function isBlocked(key: LoginKey, count: number): boolean {
  return key.kind === 'ip'
    ? count > LOGIN_ROUTE_LIMIT
    : count >= blockLimit(key)
}

export function shortRef(hash: string): string {
  return hash.slice(0, 6)
}
