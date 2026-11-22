import { CacheRepository } from '../repositories/cache.repository'

const ACCESS_TOKEN_TTL_SECONDS = 60 * 15

export const sessionsRevokedAtKey = (userId: string) =>
  `sessions-revoked-at:${userId}`

/**
 * `marginSeconds` empurra a marca para o futuro. A checagem é `iat < marca`, então um token emitido no MESMO
 * segundo da marca escapa. Quem nunca mais emite sessão para o usuário (suspensão, exclusão) usa 1; a troca de senha
 * usa 0 porque emite uma sessão nova logo depois, que não pode ser derrubada.
 */
export async function markSessionsRevoked(
  cacheRepository: CacheRepository,
  userId: string,
  marginSeconds = 0
) {
  await cacheRepository.set(
    sessionsRevokedAtKey(userId),
    Math.floor(Date.now() / 1000) + marginSeconds,
    ACCESS_TOKEN_TTL_SECONDS
  )
}
