import { CacheRepository } from '../repositories/cache.repository'

export const OAUTH_STATE_TTL_SECONDS = 600
export const oauthStateKey = (state: string) => `oauth-state:${state}`

export function parseAcceptedTerms(value: unknown): boolean {
  return value === 'true'
}

export interface OAuthState {
  acceptedTerms: boolean
  linkUserId?: string
}

export async function saveOAuthState(
  cache: Pick<CacheRepository, 'set'>,
  state: string,
  acceptedTerms: boolean,
  linkUserId?: string
) {
  await cache.set(
    oauthStateKey(state),
    linkUserId ? { acceptedTerms, linkUserId } : { acceptedTerms },
    OAUTH_STATE_TTL_SECONDS
  )
}

export async function readOAuthState(
  cache: Pick<CacheRepository, 'get'>,
  state: string
): Promise<OAuthState | null> {
  const stored = await cache.get(oauthStateKey(state))
  if (stored === null || stored === undefined || stored === false) return null

  const fields = typeof stored === 'object' ? (stored as OAuthState) : null
  const acceptedTerms = fields?.acceptedTerms === true
  return typeof fields?.linkUserId === 'string'
    ? { acceptedTerms, linkUserId: fields.linkUserId }
    : { acceptedTerms }
}
