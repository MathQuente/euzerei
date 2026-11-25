// O @fastify/rate-limit não tipa os stores embutidos; só declaramos o que o store híbrido usa.
// Sem import relativo aqui: dentro de `declare module` o TypeScript o recusa (TS2439), e o
// `skipLibCheck` do projeto esconderia o erro em arquivos .d.ts.
declare module '@fastify/rate-limit/store/RedisStore' {
  import type { Redis } from 'ioredis'

  interface Store {
    incr(
      key: string,
      cb: (
        error: Error | null,
        result?: { current: number; ttl: number }
      ) => void,
      timeWindow: number,
      max: number
    ): void
    child(routeOptions: object): Store
  }

  class RedisStore implements Store {
    constructor(
      continueExceeding: boolean | undefined,
      exponentialBackoff: boolean | undefined,
      redis: Redis,
      key?: string
    )
    incr: Store['incr']
    child: Store['child']
  }
  export = RedisStore
}

declare module '@fastify/rate-limit/store/LocalStore' {
  interface Store {
    incr(
      key: string,
      cb: (
        error: Error | null,
        result?: { current: number; ttl: number }
      ) => void,
      timeWindow: number,
      max: number
    ): void
    child(routeOptions: object): Store
  }

  class LocalStore implements Store {
    constructor(
      continueExceeding: boolean | undefined,
      exponentialBackoff: boolean | undefined,
      cache?: number
    )
    incr: Store['incr']
    child: Store['child']
  }
  export = LocalStore
}
