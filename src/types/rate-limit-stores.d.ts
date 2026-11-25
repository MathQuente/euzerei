// O @fastify/rate-limit não tipa os stores embutidos; só usamos o que o store híbrido precisa.
declare module '@fastify/rate-limit/store/RedisStore' {
  import type { Redis } from 'ioredis'
  import type { RateLimitStore } from '../utils/hybrid-rate-limit-store'

  class RedisStore implements RateLimitStore {
    constructor(
      continueExceeding: boolean | undefined,
      exponentialBackoff: boolean | undefined,
      redis: Redis,
      key?: string
    )
    incr: RateLimitStore['incr']
    child(routeOptions: object): RateLimitStore
  }
  export = RedisStore
}

declare module '@fastify/rate-limit/store/LocalStore' {
  import type { RateLimitStore } from '../utils/hybrid-rate-limit-store'

  class LocalStore implements RateLimitStore {
    constructor(
      continueExceeding: boolean | undefined,
      exponentialBackoff: boolean | undefined,
      cache?: number
    )
    incr: RateLimitStore['incr']
    child(routeOptions: object): RateLimitStore
  }
  export = LocalStore
}
