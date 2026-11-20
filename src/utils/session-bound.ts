const SESSION_BOUND_PREFIXES = ['/auth', '/panel', '/admin']

export function isSessionBound(
  url: string,
  cookies?: Record<string, string | undefined>
): boolean {
  return (
    SESSION_BOUND_PREFIXES.some(prefix => url.startsWith(prefix)) ||
    Boolean(cookies?.accessToken || cookies?.refreshToken)
  )
}
