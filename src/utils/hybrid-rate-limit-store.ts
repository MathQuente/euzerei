import LocalStore from '@fastify/rate-limit/store/LocalStore'
import RedisStore from '@fastify/rate-limit/store/RedisStore'
import type { Redis } from 'ioredis'

/**
 * Store do @fastify/rate-limit que divide o trabalho:
 *
 * - o limite GERAL (rotas sem `config.rateLimit` próprio) conta na memória do processo, sem
 *   mandar nenhum comando ao Redis (o Upstash cobra por comando; eram 1 por requisição);
 * - rotas com limite PRÓPRIO (login, painel, denúncia, upload, importações, IGDB) continuam no
 *   Redis, com a mesma chave de antes (`<namespace><MÉTODO><url>-<chave>`), porque a tela de
 *   Segurança lê e apaga essas chaves e a contagem precisa valer entre reinícios.
 *
 * A memória é por processo. O lib roda numa instância só (Render free); com mais de uma, cada
 * instância contaria o limite geral separado. O contador zera quando o processo reinicia.
 */
export const RATE_LIMIT_NAMESPACE = 'rate-limit'

export interface RateLimitStore {
  incr(
    key: string,
    cb: (
      error: Error | null,
      result?: { current: number; ttl: number }
    ) => void,
    timeWindow: number,
    max: number
  ): void
  child(routeOptions: object): RateLimitStore
}

interface RouteInfo {
  method?: string | string[]
  url?: string
  config?: { rateLimit?: unknown }
}

function hasOwnLimit(routeOptions: object): boolean {
  const config = (routeOptions as { routeInfo?: RouteInfo }).routeInfo?.config
  return Boolean(config?.rateLimit)
}

export function createHybridRateLimitStore(redis: Redis) {
  return class HybridRateLimitStore implements RateLimitStore {
    private local: RateLimitStore

    constructor(options: object = {}) {
      const { continueExceeding, exponentialBackoff, cache } = options as {
        continueExceeding?: boolean
        exponentialBackoff?: boolean
        cache?: number
      }
      this.local = new LocalStore(continueExceeding, exponentialBackoff, cache)
    }

    incr: RateLimitStore['incr'] = (key, cb, timeWindow, max) =>
      this.local.incr(key, cb, timeWindow, max)

    child(routeOptions: object): RateLimitStore {
      const { continueExceeding, exponentialBackoff, cache, routeInfo } =
        routeOptions as {
          continueExceeding?: boolean
          exponentialBackoff?: boolean
          cache?: number
          routeInfo: RouteInfo
        }
      if (hasOwnLimit(routeOptions)) {
        // Mesma montagem do RedisStore.child do plugin: `<namespace><MÉTODO><url>-`.
        return new RedisStore(
          continueExceeding,
          exponentialBackoff,
          redis,
          `${RATE_LIMIT_NAMESPACE}${routeInfo.method}${routeInfo.url}-`
        )
      }
      return new LocalStore(continueExceeding, exponentialBackoff, cache)
    }
  }
}
